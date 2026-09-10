'use client';

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { buildHistoryForAsk, type AdvisorHistoryMessage } from '@deckgauge/shared';
import { useLocalBridge, type BridgeStatus } from './useLocalBridge';
import { notifyToolCall } from './board-mutation-signal';
import { describeAdvisorError, type AdvisorErrorCopy } from './advisor-error-copy';
import {
  advisorReducer,
  INITIAL_ADVISOR_STATE,
  type AdvisorChatMessage,
  type AdvisorState,
} from './advisor-state';
import { appendMessage, createSession, getSession, listSessions } from './advisor-api';
import { AdvisorRouteBinder } from './AdvisorRouteBinder';
import { readPanelSize, writePanelSize, type AdvisorPanelSize } from './advisor-prefs';
import { resolveAdvisorPageContext, type AdvisorPageContext } from './advisor-page-context';

/** Survives a reload as UI state only — never conversation content. */
const RESTORE_KEY = 'deckgauge.advisor.ui';

interface AdvisorContextValue {
  state: AdvisorState;
  /**
   * The board the CURRENT ROUTE is showing, `null` on any page that isn't a
   * board view. Distinct from `state.boardId`, which is the board the
   * conversation belongs to.
   *
   * The launcher and panel render on EVERY route regardless of this value —
   * off-board they run in product-help mode — so this is no longer a gate on
   * whether the advisor is visible. What it decides is whether board data
   * tools are in play: `AdvisorPanel` treats "board mode" as
   * `state.boardId && routeBoardId !== null`.
   *
   * The two deliberately do NOT have to be equal — a navigation between boards
   * leaves them briefly disagreeing while `rebindToBoard` resolves the new
   * board's session, and blinking the panel out for that round trip is worse
   * than showing the conversation it is about to rebind.
   */
  routeBoardId: string | null;
  bridgeStatus: BridgeStatus;
  bridgeAgent?: string;
  open(params: { boardId: string; widgetType?: string }): void;
  raise(): void;
  dock(): void;
  close(): void;
  newSession(): void;
  resume(sessionId: string): Promise<void>;
  send(question: string): Promise<void>;
  /**
   * Point the conversation at another board from the scope row. NAVIGATES —
   * see the implementation for why it must not rebind directly.
   */
  switchBoard(boardId: string): void;
  /** Told by the history list that a session is gone, so a dead active id can be dropped. */
  sessionDeleted(sessionId: string): void;
  clearWidgetScope(): void;
  /** Card vs drawer. A UI preference, not conversation state. */
  panelSize: AdvisorPanelSize;
  setPanelSize(size: AdvisorPanelSize): void;
  /** What the Advisor knows about the current route. Never null. */
  pageContext: AdvisorPageContext;
}

const AdvisorContext = createContext<AdvisorContextValue | null>(null);

export function useAdvisor(): AdvisorContextValue {
  const value = useContext(AdvisorContext);
  if (!value) throw new Error('useAdvisor must be used inside <AdvisorProvider>');
  return value;
}

type AdvisorStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; toolCalls: Array<{ name: string }> }
  | { type: 'error'; message: string };

function parseSseEvent(block: string): AdvisorStreamEvent | null {
  const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  const payload = dataLine.slice('data:'.length).trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload) as AdvisorStreamEvent;
  } catch {
    return null;
  }
}

function toHistory(messages: readonly AdvisorChatMessage[]): AdvisorHistoryMessage[] {
  return buildHistoryForAsk(messages.map(({ role, text }) => ({ role, text })));
}

/** Callbacks `drainAdvisorStream` reports through, kept as an interface so both call sites type-check identically. */
interface AdvisorStreamHandlers {
  isCurrent: () => boolean;
  onDelta: (text: string) => void;
  onToolCall: (name: string) => void;
  fail: (copy: { message: string }) => void;
}

/**
 * Drains an SSE response body into dispatches. Shared by the board and help
 * ask paths, which differ only in URL and request body — duplicating this
 * loop is how the `sawDone` truncation guard would drift between them.
 *
 * Returns the assembled answer and tool-call names, or `null` if the caller
 * should do nothing further: the conversation moved on (`isCurrent()` went
 * false) or a failure was already reported via `fail`.
 */
async function drainAdvisorStream(
  body: ReadableStream<Uint8Array>,
  handlers: AdvisorStreamHandlers,
): Promise<{ answer: string; toolCalls: string[] } | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  const toolCalls: string[] = [];
  // The API's SSE route always writes a `done` frame on both its success and
  // error paths. If the reader's own `done` (the HTTP stream closing) arrives
  // without one ever having been seen, the connection was dropped mid-answer
  // — not a clean finish.
  let sawDone = false;

  // SSE frames are separated by a blank line and a chunk may split one
  // mid-way, so consume only complete `\n\n`-terminated blocks.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // The conversation moved on under us (＋ New, a resume, a board change).
    // Stop draining and leave the transcript alone — the caller's abort will
    // already have cut the socket in most cases.
    if (!handlers.isCurrent()) {
      await reader.cancel();
      return null;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const event = parseSseEvent(block);
      if (event?.type === 'delta') {
        answer += event.text;
        handlers.onDelta(event.text);
      } else if (event?.type === 'done') {
        sawDone = true;
        for (const call of event.toolCalls) {
          toolCalls.push(call.name);
          handlers.onToolCall(call.name);
        }
      } else if (event?.type === 'error') {
        // In-stream errors carry the provider's own message, not a code.
        // Cancel the reader so the response stream isn't left undrained once
        // we stop reading it.
        await reader.cancel();
        handlers.fail({ message: event.message });
        return null;
      }
      boundary = buffer.indexOf('\n\n');
    }
  }

  if (!sawDone) {
    // Never persist a truncated answer as if it were complete: drop it (via
    // the error path, which clears streamingAnswer) and keep the question in
    // the transcript so a retry has the full conversation behind it.
    handlers.fail({
      message:
        'The connection to the advisor was interrupted before the answer finished. Try asking again.',
    });
    return null;
  }

  return { answer, toolCalls };
}

export function AdvisorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(advisorReducer, INITIAL_ADVISOR_STATE);
  /**
   * The route binder's latest report, or `null` while it has not reported yet.
   *
   * Deliberately a wrapper object rather than a bare `string | null`: "no
   * board on this route" and "the route has not been read yet" are different
   * facts, and every ordering defect on this branch came from conflating
   * them. `AdvisorRouteBinder` sits behind `<Suspense>` (it calls
   * `useSearchParams`), so on a FULL PAGE LOAD it reports a commit or two
   * after the provider's own mount effects — and a provider that cannot tell
   * "not yet" from "nowhere" restores the advisor onto the board it was saved
   * on while the user is looking at a different one.
   */
  const [routeReport, setRouteReport] = useState<{ boardId: string | null } | null>(null);
  const routeBoardId = routeReport?.boardId ?? null;
  // Only connect once the advisor is actually in use: the bridge handshake
  // sends the user's Keycloak access token to 127.0.0.1:4779, and this
  // provider is mounted in the root layout, so an unconditional connection
  // would offer that token to whatever is squatting on that port on EVERY
  // authenticated page view.
  //
  // `|| state.isAsking` because closing is non-destructive by design: `CLOSE`
  // keeps `isAsking`, and the SSE path streams its answer to completion with
  // the panel shut. Dropping the socket out from under a bridge ask instead
  // strands it — no `done`/`error` frame can land, `ASK_DONE` never
  // dispatches, and reopening on the same board (which does not blank the
  // conversation) returns a permanently disabled composer. The socket has
  // already handed over the token by then, so keeping it for the tail of an
  // ask the user themselves started offers it to nothing new.
  const bridge = useLocalBridge(undefined, state.mode !== 'closed' || state.isAsking);
  // Read inside async callbacks that would otherwise close over a stale render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const pathname = usePathname();
  const router = useRouter();
  const pageContext = useMemo(() => resolveAdvisorPageContext(pathname), [pathname]);
  // Read inside `send`, which would otherwise need `pageContext` in its
  // dependency array and get a new identity on every navigation — same
  // rationale as `stateRef` above. Declared here, beside `stateRef`, rather
  // than down near `pageContext`'s original computation, so a future read of
  // `pageContextRef` during render can never observe it before it exists.
  const pageContextRef = useRef(pageContext);
  useEffect(() => {
    pageContextRef.current = pageContext;
  }, [pageContext]);

  /**
   * Which conversation the in-flight work belongs to.
   *
   * Every path that leaves the current conversation (`＋ New`, resuming
   * another session, opening onto another board, deleting the active session)
   * calls `startEpoch()`, and every async continuation of an ask carries the
   * epoch it started under and does nothing once that no longer matches.
   *
   * Without this, `blankConversation()` re-enables the composer under an ask
   * that is still streaming: two readers then dispatch DELTA into the same
   * `streamingAnswer`, so what the user reads is interleaved nonsense and
   * `toHistory()` ships exactly that as "prior turns". On the bridge path it
   * is worse — `useLocalBridge` keeps a single handlers slot, so the second
   * ask overwrites the first and the first assistant turn is never persisted.
   */
  const epochRef = useRef(0);
  /** Aborts the SSE fetch of a superseded ask instead of letting it run on. */
  const askAbortRef = useRef<AbortController | null>(null);

  const startEpoch = useCallback((): number => {
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    epochRef.current += 1;
    return epochRef.current;
  }, []);

  const open = useCallback(
    (params: { boardId: string; widgetType?: string }) => {
      // Adopt this board as the route's when nothing has reported one yet.
      // On a first page view of a bare `/` — no `?boardId`, no last-board
      // cookie — `app/page.tsx` still resolves a default board and renders
      // it, but the route binder's effect has already run and returned null
      // by the time the board page writes that cookie, and its deps never
      // change again. `routeBoardId` would then stay null for the life of the
      // page and both the panel and the dock would refuse to render, making
      // this click do nothing at all. Every entry point that can reach here
      // (the board header button, a widget chip) is rendered by the board
      // page itself, so the board it carries IS the board on screen. Only
      // fills a null: the binder stays the authority on every later change,
      // including navigating away, which nulls it again.
      if (routeBoardId === null) setRouteReport({ boardId: params.boardId });
      // Only a CROSS-board open blanks the conversation (see the reducer);
      // reopening on the same board raises the live one and must not cancel
      // an answer in flight.
      if (state.boardId !== params.boardId) startEpoch();
      dispatch({ type: 'OPEN', boardId: params.boardId, widgetType: params.widgetType });
    },
    [routeBoardId, state.boardId, startEpoch],
  );
  const raise = useCallback(() => dispatch({ type: 'RAISE' }), []);
  const dock = useCallback(() => dispatch({ type: 'DOCK' }), []);
  const close = useCallback(() => dispatch({ type: 'CLOSE' }), []);
  const newSession = useCallback(() => {
    startEpoch();
    dispatch({ type: 'NEW_SESSION' });
  }, [startEpoch]);
  const sessionDeleted = useCallback(
    (sessionId: string) => {
      // Only the ACTIVE session matters here: deleting any other row is
      // purely a history-list concern.
      if (stateRef.current.sessionId !== sessionId) return;
      startEpoch();
      dispatch({ type: 'NEW_SESSION' });
    },
    [startEpoch],
  );
  const clearWidgetScope = useCallback(() => dispatch({ type: 'CLEAR_WIDGET_SCOPE' }), []);

  // Flips true once the restore effect (below) has made its one attempt to
  // read RESTORE_KEY, which it does on the first commit where the route has
  // been reported. Declared here (rather than next to that effect) because
  // the persist effect below reads it too — this ref is what keeps the two
  // safe no matter which order they run in or which is edited later. It is
  // only ever WRITTEN by the restore effect and read as "has that already
  // happened", so it carries no value that could be out of date.
  const restoredRef = useRef(false);

  // Persist only {mode, sessionId, boardId}. The transcript is refetched and
  // re-authorized server-side on restore, so nothing here is trusted content.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Stay inert until the restore effect has run its one mount-time read of
    // RESTORE_KEY. Without this gate, this effect's first run sees the
    // default closed/no-boardId state and calls removeItem() — deleting the
    // very data the restore effect is about to read, before it ever reads it
    // (every mount would wipe its own restore data).
    if (!restoredRef.current) return;
    if (state.mode === 'closed' || !state.boardId) {
      window.localStorage.removeItem(RESTORE_KEY);
      return;
    }
    window.localStorage.setItem(
      RESTORE_KEY,
      JSON.stringify({ mode: state.mode, boardId: state.boardId, sessionId: state.sessionId }),
    );
  }, [state.mode, state.boardId, state.sessionId]);

  /**
   * Loads a session's transcript into the panel.
   *
   * Takes `boardId` as an ARGUMENT rather than reading `stateRef.current`:
   * mount-time restore calls this in the same tick as the dispatch that sets
   * the board, and the ref is only re-synced by an effect after that render
   * commits — so a ref read here would still see the initial `boardId: null`
   * and bail before ever fetching the transcript.
   */
  const resumeInto = useCallback(async (boardId: string, sessionId: string, epoch: number) => {
    const transcript = await getSession(boardId, sessionId);
    // Another conversation switch overtook this fetch — drop it rather than
    // overwrite whatever the user is now looking at.
    if (epochRef.current !== epoch) return;
    // A session that no longer resolves (deleted elsewhere, or a stale id from
    // localStorage) falls back to a blank conversation rather than an error.
    if (!transcript) {
      dispatch({ type: 'NEW_SESSION' });
      return;
    }
    dispatch({
      type: 'RESUME',
      sessionId: transcript.id,
      title: transcript.title,
      messages: transcript.messages,
    });
  }, []);

  const resume = useCallback(
    async (sessionId: string) => {
      const boardId = stateRef.current.boardId;
      if (!boardId) return;
      await resumeInto(boardId, sessionId, startEpoch());
    },
    [resumeInto, startEpoch],
  );

  /**
   * Moves a live advisor onto the board the user just navigated to.
   *
   * Sessions are per board, so the conversation cannot travel with the user:
   * without this the panel keeps reading "reading b1" and keeps answering
   * about the board that is no longer on screen. Binds to that board's most
   * recent session, or leaves the blank conversation `REBIND_BOARD` installed
   * if it has none. The previous board's session is not lost — it is in that
   * board's history list.
   */
  const rebindToBoard = useCallback(
    async (boardId: string) => {
      const epoch = startEpoch();
      dispatch({ type: 'REBIND_BOARD', boardId });
      const result = await listSessions(boardId);
      if (epochRef.current !== epoch) return;
      // A failed list is not an empty one, but either way the blank
      // conversation already dispatched is the right thing to be looking at.
      const newest = result.ok ? result.sessions[0] : undefined;
      if (!newest) return;
      await resumeInto(boardId, newest.id, epoch);
    },
    [resumeInto, startEpoch],
  );

  /**
   * Lets the scope row point the conversation at another board the user has
   * access to — by NAVIGATING there, not by rebinding.
   *
   * The route is the single authority on board binding (see the binding effect
   * below), so a switcher that called `rebindToBoard` directly was fighting it
   * and always lost: the rebind set `state.boardId = b2`, the binding effect
   * re-ran on that very change, saw the route still said b1, and rebound
   * straight back — while `REBIND_BOARD` blanked the transcript on each leg.
   * Every selection reverted, and took the visible conversation with it.
   *
   * Navigating instead makes the route say b2, and the binding effect then does
   * the rebind itself, on its own terms. The switcher only ever renders in
   * board mode, where the canonical board URL is `/?boardId=<id>` (a bare
   * `/boards/<id>` has no index page).
   */
  const switchBoard = useCallback(
    (boardId: string) => {
      router.push(`/?boardId=${encodeURIComponent(boardId)}`);
    },
    [router],
  );

  /**
   * The binder's only job: hand the provider what the route says. No decision
   * is taken here.
   *
   * This used to also decide whether to rebind, off `stateRef.current` — a
   * ref another effect populates. That read is exactly what made effect
   * ordering decide correctness: the binder is a CHILD of this provider, so
   * in any commit where it reports, its effect runs BEFORE the parent effect
   * that re-syncs `stateRef` — and it therefore judged "is there anything to
   * rebind?" against the state as it was one commit ago. Every decision now
   * lives in the two effects below, which are keyed on committed values only.
   */
  const bindRoute = useCallback((boardId: string | null) => {
    // Same object identity when the answer has not changed, so a binder that
    // re-reports the same board does not re-render the whole app.
    setRouteReport((previous) => (previous?.boardId === boardId ? previous : { boardId }));
  }, []);

  // Restore the dock/panel once, as soon as the route has been read.
  useEffect(() => {
    // Wait for the binder's FIRST report rather than assuming it has already
    // happened. Behind `<Suspense>` it has not: on a full page load this
    // effect runs first, and restoring against an unknown route is what bound
    // the advisor to the saved board while the user was looking at another
    // one. Keyed on `routeReport`, so it simply runs again once that lands.
    if (restoredRef.current || routeReport === null || typeof window === 'undefined') return;
    // The user got here first (clicked "Ask the Advisor" before the route
    // settled). Their click is newer than anything on disk, so there is
    // nothing left to restore onto.
    if (state.mode !== 'closed') {
      restoredRef.current = true;
      return;
    }
    restoredRef.current = true;
    const raw = window.localStorage.getItem(RESTORE_KEY);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as {
        mode?: string;
        boardId?: string;
        sessionId?: string | null;
      };
      if (!saved.boardId || (saved.mode !== 'open' && saved.mode !== 'docked')) return;
      // Reloading on a DIFFERENT board than the one the advisor was left on
      // restores the mode but binds to the board actually on screen. Nothing
      // is at stake in getting this wrong any more — the binding effect below
      // would correct it on the next commit — but doing it here is what keeps
      // a cross-board reload from fetching the saved board's transcript and
      // flashing it at a user who is not on that board.
      const routeBoard = routeReport.boardId;
      const rebound = routeBoard !== null && routeBoard !== saved.boardId;
      const boardId = rebound ? routeBoard : saved.boardId;
      const sessionId = rebound ? null : (saved.sessionId ?? null);
      // One dispatch, carrying the session id with it — see `RESTORE` in
      // advisor-state.ts for why this must not be OPEN-then-RESUME.
      dispatch({ type: 'RESTORE', mode: saved.mode, boardId, sessionId });
      if (sessionId) void resumeInto(boardId, sessionId, epochRef.current);
      else if (rebound) void rebindToBoard(boardId);
    } catch {
      window.localStorage.removeItem(RESTORE_KEY);
    }
  }, [routeReport, state.mode, resumeInto, rebindToBoard]);

  /**
   * Keeps the conversation on the board the user is actually looking at.
   *
   * The single authority on binding, and the reason effect ordering can no
   * longer decide correctness: it reads nothing but committed render values
   * and is keyed on all three of them, so whatever order the restore effect,
   * the binder's effect and this one happen to run in, the commit that
   * follows re-evaluates the same comparison and converges. A rebind that was
   * missed because a value had not landed yet simply happens on the commit
   * where it does.
   *
   * Doing nothing while the advisor is closed is deliberate: the next
   * `open({boardId})` binds it to whatever board that click came from, and
   * rebinding here would fetch a session list nobody asked for on every
   * navigation.
   */
  useEffect(() => {
    if (routeBoardId === null) return;
    if (state.mode === 'closed' || state.boardId === null) return;
    if (state.boardId === routeBoardId) return;
    void rebindToBoard(routeBoardId);
  }, [routeBoardId, state.mode, state.boardId, rebindToBoard]);

  /** Ensures a session row exists to hang messages off, returning its id. */
  const ensureSession = useCallback(
    async (boardId: string, epoch: number): Promise<string | null> => {
      const existing = stateRef.current.sessionId;
      if (existing) return existing;
      const created = await createSession(boardId);
      if (!created) return null;
      // The conversation this session was being created for is gone — hanging
      // its id off whatever replaced it would file the new turns under the
      // wrong session.
      if (epochRef.current !== epoch) return null;
      dispatch({ type: 'SESSION_STARTED', sessionId: created.id });
      return created.id;
    },
    [],
  );

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      const current = stateRef.current;
      if (!trimmed || current.isAsking) return;

      const boardId = current.boardId;
      const widgetType = current.widgetType;
      // Assembled BEFORE the question is appended, so it is strictly prior turns.
      const history = toHistory(current.messages);
      // Board data tools are only available on a board route with a board
      // bound to the conversation — e.g. a board conversation left open while
      // the user navigates to Timesheet is a help question, not a board one.
      //
      // Deliberately a different test than `AdvisorPanel`'s "is this board
      // mode" (`Boolean(state.boardId) && routeBoardId !== null`): that one
      // exists to decide what CHROME to render around an already-open panel,
      // and `routeBoardId` starts `null` until `AdvisorRouteBinder` reports —
      // behind `<Suspense>`, that is one or more commits into a full page
      // load. `pageContext.isBoard` has no such gap; it is a pure function of
      // `pathname`, true on `/` from the very first render. The two windows
      // this leaves briefly disagreeing on a fresh `/` load — the panel
      // reads "help" while `send` correctly takes the board branch, or vice
      // versa — are the same class of transient the rest of this file's
      // comments document, not a bug in either place.
      const isBoardQuestion = Boolean(boardId) && pageContextRef.current.isBoard;

      const askId = startEpoch();
      const abort = new AbortController();
      askAbortRef.current = abort;

      dispatch({ type: 'ASK_START', question: trimmed });

      /** True only while this ask is still the conversation's live one. */
      const isCurrent = () => epochRef.current === askId;

      const finish = (sessionId: string | null, answer: string, toolCalls: string[]) => {
        if (!isCurrent()) return;
        dispatch({ type: 'ASK_DONE' });
        // Help turns never carry a session (see the branch below) and a
        // board without a session id is the "createSession failed" case —
        // either way, there is nothing to persist.
        if (boardId && sessionId && answer) {
          void appendMessage(boardId, sessionId, { role: 'assistant', text: answer, toolCalls });
        }
      };
      const fail = (error: AdvisorErrorCopy) => {
        if (!isCurrent()) return;
        dispatch({ type: 'ASK_ERROR', error });
      };

      try {
        if (!isBoardQuestion) {
          // Product help. `AdvisorSession.boardId` is non-nullable with a
          // foreign-key to `Board`, so there is no row to hang an off-board
          // conversation off — these turns are ephemeral by design (see the
          // spec's "Help conversations are ephemeral in Phase 1"). No
          // `ensureSession`, no `appendMessage`, for either the question or
          // the answer.
          // A bound `boardId` on the help path means the conversation started
          // as a BOARD conversation and the user has since navigated off the
          // board view (`state.boardId` stays bound there by design). Its turns
          // are answers full of that board's real numbers, produced by tools
          // this model does not have — replaying them as the help model's own
          // prior words hands a documentation-only assistant a page of figures
          // to build on. Send no history at all rather than history that
          // belongs to another conversation.
          const response = await fetch('/api/advisor/help/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question: trimmed,
              pageContext: {
                key: pageContextRef.current.key,
                label: pageContextRef.current.label,
              },
              boardId: boardId ?? undefined,
              // The standalone Roadmap entity's id, when the route is `/roadmap/[id]`
              // — extracted once by `resolveAdvisorPageContext` (see its docstring)
              // and forwarded as its own top-level field, mirroring `boardId`.
              roadmapId: pageContextRef.current.entityId,
              history: boardId ? undefined : history,
            }),
            signal: abort.signal,
          });

          const contentType = response.headers.get('content-type') ?? '';
          if (contentType.includes('application/json')) {
            const body = (await response.json()) as { error?: string; message?: string };
            // Failures arrive as a machine code in `error` — translate, don't print.
            fail(describeAdvisorError(body.error ?? body.message));
            return;
          }
          if (!response.body) {
            fail({ message: 'The advisor returned an empty response.' });
            return;
          }

          const drained = await drainAdvisorStream(response.body, {
            isCurrent,
            onDelta: (text) => dispatch({ type: 'DELTA', text }),
            onToolCall: (name) => {
              notifyToolCall(boardId, name);
              dispatch({ type: 'TOOL_CALL', name });
            },
            fail,
          });
          // No sessionId: `finish` skips persistence when it is absent.
          if (drained) finish(null, drained.answer, drained.toolCalls);
          return;
        }

        // `isBoardQuestion` is true only when `boardId` is truthy, but that
        // fact lives in a separate boolean the type-checker cannot see
        // through — this is the narrowing check, not a real possibility.
        if (!boardId) return;

        // Inside the try: `createSession` is total now, but keeping this out
        // here is what made a single network blip escape `send` as an
        // unhandled rejection — leaving `isAsking` true forever, with the
        // composer disabled and no error shown.
        const sessionId = await ensureSession(boardId, askId);
        if (!isCurrent()) return;
        if (sessionId) {
          // Persist the question before the answer is attempted: a failed ask
          // then still leaves a retry with the full conversation behind it.
          void appendMessage(boardId, sessionId, { role: 'user', text: trimmed, toolCalls: [] });
        }

        if (bridge.status === 'ready') {
          let answer = '';
          const toolCalls: string[] = [];
          bridge.ask(boardId, trimmed, widgetType, history, {
            onDelta: (text) => {
              if (!isCurrent()) return;
              answer += text;
              dispatch({ type: 'DELTA', text });
            },
            onToolCall: (name) => {
              // The mutation already happened server-side by the time this
              // frame arrives, regardless of whether this ask is still the
              // conversation's live one — unlike the dispatch below, this must
              // not be skipped just because the user moved on.
              notifyToolCall(boardId, name);
              if (!isCurrent()) return;
              toolCalls.push(name);
              dispatch({ type: 'TOOL_CALL', name });
            },
            onDone: () => finish(sessionId, answer, toolCalls),
            // Bridge errors are already written for humans.
            onError: (message) => fail({ message }),
          });
          return;
        }

        const response = await fetch(`/api/advisor/boards/${boardId}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            boardId,
            question: trimmed,
            widgetType,
            history,
            pageContext: { key: pageContextRef.current.key, label: pageContextRef.current.label },
          }),
          signal: abort.signal,
        });

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const body = (await response.json()) as { error?: string; message?: string };
          // Failures arrive as a machine code in `error` — translate, don't print.
          fail(describeAdvisorError(body.error ?? body.message));
          return;
        }
        if (!response.body) {
          fail({ message: 'The advisor returned an empty response.' });
          return;
        }

        const drained = await drainAdvisorStream(response.body, {
          isCurrent,
          onDelta: (text) => dispatch({ type: 'DELTA', text }),
          onToolCall: (name) => {
            notifyToolCall(boardId, name);
            dispatch({ type: 'TOOL_CALL', name });
          },
          fail,
        });
        if (drained) finish(sessionId, drained.answer, drained.toolCalls);
      } catch (err) {
        // An abort is this provider cancelling its own ask, not a failure the
        // user needs to read about — and `fail` is epoch-guarded anyway, so
        // it would be a no-op. Everything else (a dropped connection, a
        // non-JSON body) becomes visible copy and clears `isAsking`.
        fail({
          message: err instanceof Error ? err.message : 'The advisor request failed.',
        });
      } finally {
        if (askAbortRef.current === abort) askAbortRef.current = null;
      }
    },
    [bridge, ensureSession, startEpoch],
  );

  // Read lazily so the first render already has the persisted size — a
  // useEffect hydration would flash the card before switching to the drawer.
  const [panelSize, setPanelSizeState] = useState<AdvisorPanelSize>(readPanelSize);
  const setPanelSize = useCallback((size: AdvisorPanelSize) => {
    setPanelSizeState(size);
    writePanelSize(size);
  }, []);

  const value = useMemo<AdvisorContextValue>(
    () => ({
      state,
      routeBoardId,
      bridgeStatus: bridge.status,
      bridgeAgent: bridge.agent,
      open,
      raise,
      dock,
      close,
      newSession,
      resume,
      send,
      switchBoard,
      sessionDeleted,
      clearWidgetScope,
      panelSize,
      setPanelSize,
      pageContext,
    }),
    [
      state,
      routeBoardId,
      bridge.status,
      bridge.agent,
      open,
      raise,
      dock,
      close,
      newSession,
      resume,
      send,
      switchBoard,
      sessionDeleted,
      clearWidgetScope,
      panelSize,
      setPanelSize,
      pageContext,
    ],
  );

  return (
    <AdvisorContext.Provider value={value}>
      {/* Suspense because `useSearchParams` needs one, and this provider
          wraps the whole app — it must never be the thing that suspends. */}
      <Suspense fallback={null}>
        <AdvisorRouteBinder onBoardChange={bindRoute} />
      </Suspense>
      {children}
    </AdvisorContext.Provider>
  );
}
