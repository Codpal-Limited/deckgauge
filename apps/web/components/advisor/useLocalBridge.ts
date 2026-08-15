'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';

/** How long to wait for a `ready` frame before giving up on the bridge. */
const CONNECT_TIMEOUT_MS = 1500;

/**
 * How long to then wait for the bridge to confirm our `authenticate` frame.
 *
 * Deliberately much larger than `CONNECT_TIMEOUT_MS`, and a separate budget
 * rather than a share of it: `ready` only proves the bridge process is
 * listening, whereas answering `authenticate` makes it preflight the token
 * against `/mcp` and spawn the ACP adapter subprocess. Measured ~1.3s against
 * a live bridge on a warm, idle machine, so anything near 1500ms turns a
 * healthy bridge into a coin flip. The headroom above that is for agents on
 * the `mcp-remote` stdio fallback, where the connect path also downloads that
 * package on a cold npx cache.
 *
 * Still bounded, so a bridge that accepts the frame and then goes silent
 * can't leave the panel stuck in `'connecting'` forever.
 */
const AUTHENTICATE_TIMEOUT_MS = 30_000;

/**
 * The WebSocket spec's `OPEN` ready-state value (always `1`, the same across
 * every implementation). Read as a literal rather than `window.WebSocket.OPEN`
 * so `ask()`'s guard doesn't depend on a test's mock class defining that
 * static — only on the mock socket's `readyState` instance field.
 */
const WEBSOCKET_OPEN_STATE = 1;

const BRIDGE_DISCONNECTED_MESSAGE =
  'Local bridge disconnected — restart it with `pnpm deckgauge:advisor` and try again.';
const BRIDGE_NOT_CONNECTED_MESSAGE = 'The local agent bridge is not connected.';

export type BridgeStatus = 'connecting' | 'ready' | 'unavailable';

export interface AskHandlers {
  onDelta(text: string): void;
  onToolCall(name: string): void;
  onDone(): void;
  onError(message: string): void;
}

export interface BridgeHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface UseLocalBridgeResult {
  status: BridgeStatus;
  agent?: string;
  ask(
    boardId: string,
    question: string,
    widgetType: string | undefined,
    history: readonly BridgeHistoryMessage[],
    handlers: AskHandlers
  ): void;
}

/** Frames the bridge (Task 6's `startWsServer`) sends over the socket. */
type BridgeFrame =
  | { type: 'ready'; agent: string }
  | { type: 'authenticated' }
  | { type: 'delta'; text: string }
  | { type: 'toolCall'; name: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

function isBridgeFrame(value: unknown): value is BridgeFrame {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'ready':
      return typeof record.agent === 'string';
    case 'authenticated':
      return true;
    case 'delta':
      return typeof record.text === 'string';
    case 'toolCall':
      return typeof record.name === 'string';
    case 'done':
      return true;
    case 'error':
      return typeof record.message === 'string';
    default:
      return false;
  }
}

function parseFrame(data: unknown): BridgeFrame | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data);
    return isBridgeFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Connects to the local advisor bridge (`apps/advisor-bridge`'s WS server,
 * Task 6) if one is running on `127.0.0.1:<port>`. Auto-detects — there is no
 * manual toggle: `status` starts `'connecting'`, becomes `'ready'` once the
 * server's `ready` frame arrives, or `'unavailable'` if the socket
 * errors/closes first (or the connect attempt times out), so callers
 * (`AdvisorPanel`) can fall back to the existing SSE flow with no bridge
 * running.
 *
 * Keeps exactly one socket open for as long as `enabled` holds; `ask()` sends
 * the `{type:'ask',...}` frame on it and routes every subsequent frame to
 * the handlers passed to that `ask()` call, until the next `ask()` replaces
 * them.
 *
 * `enabled` exists because the handshake hands the operator's Keycloak access
 * token to whatever is listening on `127.0.0.1:<port>`. The provider that owns
 * this hook is mounted in the ROOT LAYOUT, so connecting unconditionally would
 * offer that token on every authenticated page view; the caller passes
 * `state.mode !== 'closed' || state.isAsking` so it happens only once the user
 * has deliberately opened the advisor, which is the precondition that held
 * before the advisor became app-wide — and so that closing the panel mid-answer
 * does not cut the socket the answer is arriving on. Should the socket be torn
 * down with an ask still pending anyway, that ask is failed rather than left
 * hanging.
 */
export function useLocalBridge(port = 4779, enabled = true): UseLocalBridgeResult {
  const [status, setStatus] = useState<BridgeStatus>('connecting');
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const socketRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<BridgeStatus>('connecting');
  const handlersRef = useRef<AskHandlers | null>(null);
  // Tracks whether this socket has ever reached `ready` (i.e. authenticated,
  // ask-capable), so a later disconnect is reported distinctly ("bridge died
  // mid-session") from a disconnect that happens before the bridge was ever
  // usable at all.
  const reachedReadyRef = useRef(false);

  // The operator's own NextAuth/Keycloak session — this is the token the
  // bridge authenticates with (see ws-server.ts's `authenticate` message),
  // not a static DECKGAUGE_TOKEN. Read via a ref so the socket's onmessage
  // handler (set up once per `[port]`, below) always sees the current token
  // rather than the one captured when the effect first ran.
  const { data: session } = useSession();
  const accessTokenRef = useRef<string | undefined>(session?.accessToken);
  // The token last handed to the bridge, so a refresh can be told apart from
  // the initial handshake (which `onmessage`'s `ready` branch owns).
  const authenticatedTokenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    accessTokenRef.current = session?.accessToken;
  }, [session?.accessToken]);

  // NextAuth rotates the access token well within a long-lived panel session
  // (see `useAuthFetch`'s refresh path). The bridge holds whichever token it
  // was given for the life of its ACP session and the agent carries that token
  // on every `/mcp` call, so without this the board tools start 401ing partway
  // through a session that still looks connected. Re-send on every change.
  const token = session?.accessToken;
  useEffect(() => {
    const socket = socketRef.current;
    if (!token || !socket || socket.readyState !== WEBSOCKET_OPEN_STATE) {
      return;
    }
    // Nothing to refresh until the initial handshake has installed a token.
    if (!authenticatedTokenRef.current || authenticatedTokenRef.current === token) {
      return;
    }
    authenticatedTokenRef.current = token;
    socket.send(JSON.stringify({ type: 'authenticate', token }));
  }, [token]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!enabled) {
      // No socket at all while the advisor is closed — see `enabled` above.
      // Reset to the neutral pre-connect state so re-enabling replays the
      // whole handshake instead of inheriting a stale 'unavailable'.
      setStatus('connecting');
      setAgent(undefined);
      reachedReadyRef.current = false;
      authenticatedTokenRef.current = undefined;
      return;
    }

    // Guards the CONNECT race only (connecting -> ready vs. connecting ->
    // unavailable via timeout/early close/error). Once the bridge reaches
    // 'ready' this guard no longer applies: a later onclose/onerror (the
    // bridge process dying mid-session) must still flip status back to
    // 'unavailable' so the panel falls back to SSE mode for the next ask.
    let connectSettled = false;
    // The agent name from the `ready` frame, held until `authenticated`
    // arrives so `agent` and `status` flip to their final values together.
    let pendingAgent: string | undefined;

    const settleConnect = (nextStatus: BridgeStatus, nextAgent?: string) => {
      if (connectSettled) return;
      connectSettled = true;
      setStatus(nextStatus);
      if (nextAgent !== undefined) {
        setAgent(nextAgent);
      }
    };

    const socket = new window.WebSocket(`ws://127.0.0.1:${port}`);
    socketRef.current = socket;
    reachedReadyRef.current = false;
    authenticatedTokenRef.current = undefined;

    // Reassigned when `ready` hands off from the connect deadline to the
    // (much longer) authenticate deadline; the cleanup below always clears
    // whichever one is currently pending.
    let timeoutId = setTimeout(() => settleConnect('unavailable'), CONNECT_TIMEOUT_MS);

    socket.onmessage = (event: MessageEvent) => {
      const frame = parseFrame(event.data);
      if (!frame) return;

      if (frame.type === 'ready') {
        // Already given up on this socket (the connect deadline fired before
        // `ready` arrived): don't open a handshake we've stopped waiting for.
        // Starting one anyway would flip `reachedReadyRef` when
        // `authenticated` landed, and a later ask() would then blame a
        // "disconnected" bridge that had in fact authenticated fine.
        if (connectSettled) return;

        // The bridge exists and found a local agent, but it isn't
        // ask-capable until it has authenticated with our token — send that
        // next rather than settling to 'ready' yet.
        //
        // The connect deadline has done its job the moment this frame
        // arrives (the bridge is demonstrably reachable), so retire it here
        // and start the separate, much longer authenticate deadline.
        // Leaving the connect timer running instead would make it bound the
        // whole ACP handshake and settle a healthy bridge to 'unavailable'.
        clearTimeout(timeoutId);
        pendingAgent = frame.agent;
        const token = accessTokenRef.current;
        if (!token) {
          // No token to offer (logged out, or the session hasn't loaded):
          // authenticate() can do nothing with an empty string, so give up
          // now instead of waiting out a deadline that cannot be met.
          settleConnect('unavailable');
          return;
        }
        timeoutId = setTimeout(() => settleConnect('unavailable'), AUTHENTICATE_TIMEOUT_MS);
        authenticatedTokenRef.current = token;
        socket.send(JSON.stringify({ type: 'authenticate', token }));
        return;
      }

      if (frame.type === 'authenticated') {
        clearTimeout(timeoutId);
        // A re-authentication succeeding after a previous one was refused has
        // to set status directly: `settleConnect` is one-shot, so it would
        // leave the panel stuck on the provider flow until remount even though
        // the bridge is working again.
        if (reachedReadyRef.current) {
          setStatus('ready');
          return;
        }
        reachedReadyRef.current = true;
        settleConnect('ready', pendingAgent);
        return;
      }

      // An `error` frame arriving before we've ever settled means the
      // bridge rejected the authenticate attempt (e.g. no local agent) —
      // fall back to the SSE flow rather than treating it as an in-flight
      // ask's error (there is no ask in flight this early).
      if (frame.type === 'error' && !connectSettled) {
        clearTimeout(timeoutId);
        settleConnect('unavailable');
        return;
      }

      // An `error` with no ask in flight, after the panel was already live, is
      // a failed re-authentication (the refreshed token was refused, or its
      // /mcp preflight failed). The bridge's session is unusable now, so fall
      // back to the provider flow instead of leaving a "ready" panel whose
      // next ask would fail.
      if (frame.type === 'error' && !handlersRef.current && reachedReadyRef.current) {
        setStatus('unavailable');
        return;
      }

      const handlers = handlersRef.current;
      if (!handlers) return;

      if (frame.type === 'delta') {
        handlers.onDelta(frame.text);
      } else if (frame.type === 'toolCall') {
        handlers.onToolCall(frame.name);
      } else if (frame.type === 'done') {
        // The exchange is finished: clear the pending-handlers slot so a
        // later disconnect (no ask in flight anymore) doesn't mistake this
        // completed ask for one still awaiting a response and fire a
        // spurious "disconnected" error on top of an answer that already
        // arrived successfully.
        handlersRef.current = null;
        handlers.onDone();
      } else if (frame.type === 'error') {
        handlersRef.current = null;
        handlers.onError(frame.message);
      }
    };

    const handleDisconnect = () => {
      clearTimeout(timeoutId);
      if (reachedReadyRef.current) {
        // Past the connect race: this is a live-session disconnect, not a
        // failed initial connect, so it must always be surfaced regardless
        // of `connectSettled`.
        setStatus('unavailable');
        // An ask already in flight (sent, awaiting delta/done frames that
        // will now never arrive) would otherwise leave the caller stuck
        // (e.g. AdvisorPanel's `isAsking` never clearing) — surface the
        // disconnect to it instead of leaving it hanging.
        const pendingHandlers = handlersRef.current;
        if (pendingHandlers) {
          handlersRef.current = null;
          pendingHandlers.onError(BRIDGE_DISCONNECTED_MESSAGE);
        }
        return;
      }
      settleConnect('unavailable');
    };

    socket.onerror = handleDisconnect;
    socket.onclose = handleDisconnect;

    return () => {
      clearTimeout(timeoutId);
      // Neutralize the socket's handlers before closing it: our own
      // `close()` call below triggers the socket's close event too, and
      // that must not call setState after this component has unmounted.
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.onopen = null;
      socket.close();
      socketRef.current = null;
      // Nulling those handlers is exactly what makes `handleDisconnect`
      // unreachable here, so a teardown with an ask still pending has to
      // report it itself: its caller is waiting on delta/done frames that can
      // no longer arrive, and silence leaves it hanging forever (in
      // `AdvisorProvider`, `isAsking` stuck true and the composer dead).
      const pendingHandlers = handlersRef.current;
      if (pendingHandlers) {
        handlersRef.current = null;
        pendingHandlers.onError(BRIDGE_DISCONNECTED_MESSAGE);
      }
    };
  }, [port, enabled]);

  const ask = useCallback(
    (
      boardId: string,
      question: string,
      widgetType: string | undefined,
      history: readonly BridgeHistoryMessage[],
      handlers: AskHandlers
    ): void => {
      const socket = socketRef.current;
      const socketIsOpen = socket !== null && socket.readyState === WEBSOCKET_OPEN_STATE;
      if (statusRef.current !== 'ready' || !socketIsOpen) {
        handlers.onError(
          reachedReadyRef.current ? BRIDGE_DISCONNECTED_MESSAGE : BRIDGE_NOT_CONNECTED_MESSAGE
        );
        return;
      }
      handlersRef.current = handlers;
      socket.send(JSON.stringify({ type: 'ask', boardId, question, widgetType, history }));
    },
    []
  );

  return useMemo(() => ({ status, agent, ask }), [status, agent, ask]);
}
