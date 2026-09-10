'use client';
import { useEffect, useRef, useState } from 'react';
import { FOCUS_MODEL_BUDGET } from '@deckgauge/shared';
import { runFocusClassification } from '../../../../actions/focus-classify';
import { useAdvisor } from '../../../../../components/advisor/AdvisorProvider';

/**
 * `widgetRegistry.tsx`'s key for the Focus ledger widget. Duplicated rather
 * than imported: the registry pulls in every widget component in the app, and
 * this file only needs the one string it uses to scope the advisor's system
 * prompt (see `AdvisorProvider.send`'s `widgetType` handling) — the same
 * trade `AGENT_TOOL_BATCH_DEFAULT` makes in `packages/shared/src/focus/agent-tools.ts`.
 */
const FOCUS_LEDGER_WIDGET_TYPE = 'FOCUS_LEDGER';

/**
 * What gets typed into the advisor on the user's behalf when they press "Ask
 * your local agent" — naming both MCP tools (`list_unclassified_tasks`,
 * `set_focus_verdicts`, registered in `apps/api/src/advisor/tools.ts`)
 * explicitly rather than leaving the agent to infer the workflow from their
 * descriptions alone.
 */
const ASK_LOCAL_AGENT_PROMPT =
  "Classify this board's unclassified Focus tasks: call list_unclassified_tasks to fetch " +
  'them, then write your verdicts with set_focus_verdicts.';

interface Props {
  boardId: string;
  /** The widget's resolved config, so the run covers the window on screen. */
  config: Record<string, unknown>;
  unclassified: number;
  /** Re-read the widget once the run has written its verdicts. */
  onRun: () => void;
}

/**
 * The advisor run, as a notice rather than a control in the filter row.
 *
 * **This started life as a pill inside the filter stack and read as a fourth
 * filter dimension**, which is the opposite of what it is: it spends money
 * against the organization's provider and rewrites the classes every widget on
 * the page reports. Three things had been saying "filter" at once — its position
 * between the Class and Stage rows, the `w-14` uppercase label column the
 * filters use, and a `rounded-full` outline identical to an inactive `Pill`.
 *
 * So the shape carries the meaning now: it sits BELOW the filter block and above
 * the table, on its own tinted ground, and it states the situation in a sentence
 * while the button states only the verb. The old label ("Classify 26
 * unclassified") made one control do both jobs, which is what left it reading as
 * a thing you toggle rather than a thing you do.
 *
 * It is NOT the ✦ in the widget header — that opens the conversational advisor.
 *
 * **Task 3-15 adds a second path: the operator's own local agent, over
 * `AdvisorProvider`'s bridge connection**, for an organization that has no
 * advisor provider configured at all — the same 409 this strip has always
 * shown, now with something to do about it instead of only an explanation.
 *
 * Whether a provider is configured is not a fact this component can read at
 * render time. `GET /advisor/config` is `ORG_ADMIN`-gated — the ordinary
 * board editor who can see this button at all may not even be allowed to
 * call it — and nothing loads that answer onto the board page regardless.
 * The 409 this same POST already returns is the ONLY place that fact
 * surfaces, so `notConfigured` below is learned from a real attempt, not
 * given: a fresh mount always tries the server path first, exactly as
 * before, and only a 409 (checked by STATUS, not by matching the message
 * text, which is copy and could change under it) teaches this component
 * to offer the bridge from then on. Given no configured provider and no
 * bridge, that same 409 is the only thing there ever was to show, and stays
 * exactly what it always said.
 *
 * **`notConfigured` is a hint, never a routing decision — every press still
 * tries the server path first, unconditionally.** The first cut of this task
 * had the button call the bridge directly once `notConfigured` was learned,
 * which is what a review caught: this widget re-renders IN PLACE on a
 * refetch (see the comment on `previousCount` below) but is NOT remounted by
 * one, so if an org admin configures a provider while the tab stays on this
 * board, a `notConfigured` learned earlier would never be re-checked until a
 * reload — hiding the now-working, cheaper server path for the rest of the
 * mount. Retrying the server path on every press instead of clearing
 * `notConfigured` on a refetch was the deliberate choice: clearing it on
 * every refetch was rejected because it makes the common case (a board with
 * no provider at all) worse — a period change would silently re-arm the
 * server attempt, so the NEXT press eats the same 409 again before the
 * bridge offer reappears, trading a rare stale label for a recurring wasted
 * click. Retrying on every press costs one extra POST on top of a bridge ask
 * that already needs a session round trip before it can start — cheap next
 * to the multi-second, multi-tool-call agent turn that follows it — and it
 * is fully self-healing: the moment the server path succeeds, `run()` clears
 * `notConfigured` and the label reverts on its own, no reload required.
 */
export function FocusClassifyNotice({ boardId, config, unclassified, onRun }: Props) {
  const advisor = useAdvisor();
  const [runningVia, setRunningVia] = useState<'server' | 'bridge' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * Learned from a 409, cleared by a subsequent success — NOT sticky for the
   * life of the mount. It used to be (an org rarely un-configures its
   * provider mid-session, so "learn once, trust forever" seemed safe), but a
   * review caught the corollary: while it stayed sticky, a provider
   * configured mid-session by an org admin, on the SAME board a tab was
   * already looking at, never got noticed until a reload — see the
   * component docblock. `run()` clears it on its own success path instead of
   * ever trusting a stale `true`.
   */
  const [notConfigured, setNotConfigured] = useState(false);
  const canOfferBridge = notConfigured && advisor.bridgeStatus === 'ready';
  /**
   * What the LAST RUN left behind, which is not the same as the `unclassified`
   * prop.
   *
   * The prop is the parent's count and only updates on the refetch — so deciding
   * whether to offer another run from it would offer one after a run that
   * finished the job, and withhold one in the moment before the refetch lands.
   * The run's own answer is the only thing that knows.
   */
  const [leftOver, setLeftOver] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  /**
   * Forget a finished run's report as soon as NEW unclassified work appears.
   *
   * Without this the feature became unreachable, not merely untidy: a completed
   * run leaves a message and no button, and the widget re-renders IN PLACE on
   * every refetch (`DashboardCanvas` keys the card on `widget.id`, so a period
   * change, a fresh sync or a class-picker save all re-render rather than
   * remount). The strip went on reporting "Classified 2." over however many new
   * tasks had arrived, with no route back to the action short of a reload.
   *
   * The signal has to be the count RISING. A plain `unclassified > leftOver`
   * comparison is also true in the moment before the refetch lands, which is the
   * state where the confirmation must survive — the two are indistinguishable by
   * count alone.
   */
  const previousCount = useRef(unclassified);
  useEffect(() => {
    const arrived = unclassified > previousCount.current;
    previousCount.current = unclassified;
    if (!arrived) return;
    setMessage(null);
    setLeftOver(null);
    setFailed(false);
  }, [unclassified]);


  /**
   * What the button offers next.
   *
   * A finished queue gets the confirmation and NO button: there is nothing left
   * to press, and leaving one there invites a second run that would cost money
   * to discover the same thing.
   *
   * `canOfferBridge` takes priority over the server-path states below it: once
   * this organization is known to have no provider AND a local agent is
   * connected, the bridge is the likely outcome of the next press. It is
   * only a HINT, though, not what decides which code runs — `run()` (the
   * only handler the button ever calls now) always tries the server path
   * first regardless of this label, so this can undersell what a press is
   * about to do: if a provider was configured moments ago, this render still
   * says "Ask your local agent" and the upcoming press will actually
   * succeed over the server instead.
   */
  const label =
    runningVia === 'server'
      ? 'Classifying…'
      : runningVia === 'bridge'
        ? 'Asking your local agent…'
        : canOfferBridge
          ? 'Ask your local agent'
          : failed
            ? 'Try again'
            : leftOver !== null && leftOver > 0
              ? 'Run again'
              : leftOver === null
                ? 'Classify with AI'
                : null;

  /**
   * Move focus to the strip when a run removes the button the user just pressed.
   *
   * `role="status"` handles the announcement, but a finishing run unmounts the
   * button and focus falls to `<body>` — dropping a keyboard user to the top of
   * the document with no indication anything happened. The previous control
   * never had this problem because its button always stayed mounted.
   */
  const hadButton = useRef(label !== null);
  useEffect(() => {
    if (hadButton.current && label === null) stripRef.current?.focus();
    hadButton.current = label !== null;
  }, [label]);

  /**
   * Holds a bridge question that `run()`'s 409 branch has requested but that
   * `advisor.state` hasn't caught up to yet — see that branch's comment for
   * why `open` and `send` can't be two calls in a row. Declared (and its
   * effect run) above the early `return null` below, along with every other
   * hook in this component: React requires the same hooks in the same order
   * on every render, and this component does return early.
   */
  const pendingBridgePromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingBridgePromptRef.current === null) return;
    if (advisor.state.boardId !== boardId) return;
    const prompt = pendingBridgePromptRef.current;
    pendingBridgePromptRef.current = null;
    void advisor.send(prompt).finally(() => setRunningVia(null));
    // `advisor.state` (not `.boardId`) is the dependency on purpose: `OPEN`
    // dispatches a new state object even when the board id it carries doesn't
    // change (reopening on the board the advisor was already on), and that is
    // exactly the case — the advisor already here — where this effect has to
    // re-run to notice the pending prompt at all.
  }, [advisor, advisor.state, boardId]);

  /**
   * Absent when there is nothing to classify AND nothing to report.
   *
   * The second half matters: the count drops to zero on the refetch after a run
   * that finished the job, so hiding on the count alone would take the
   * "Classified 26." confirmation off screen with it and make a successful press
   * look like it did nothing.
   */
  if (unclassified === 0 && message === null) return null;

  /**
   * The button's only handler, whether or not `canOfferBridge` currently
   * labels it "Ask your local agent" — see the component docblock's account
   * of why a routing decision based on that label is exactly the bug a
   * review caught. Always tries the server path first; a 409 with a
   * connected bridge falls back silently (no error is ever shown for it —
   * the 409 is expected, not a failure worth reporting) into a bridge ask
   * instead of returning.
   */
  async function run() {
    setRunningVia('server');
    setMessage(null);
    setFailed(false);
    setLeftOver(null);

    // No blanket try/finally around `setRunningVia(null)` any more: the 409
    // branch below can hand off into a BRIDGE run instead of ending here, and
    // a `finally` would clear `runningVia` a tick before that branch's own
    // `setRunningVia('bridge')` sets it again — harmless in practice (React
    // batches both into the one render) but confusing to read. Every exit
    // path below sets its own `runningVia` explicitly instead.
    let outcome: Awaited<ReturnType<typeof runFocusClassification>>;
    try {
      outcome = await runFocusClassification(boardId, config);
    } catch (err) {
      setFailed(true);
      setMessage(err instanceof Error ? err.message : 'The run could not be started.');
      setRunningVia(null);
      return;
    }

    if (!outcome.ok) {
      // 409, and only 409, means this organization has no advisor configured
      // (see focus-classify.routes.ts) — the one failure a connected local
      // agent can actually stand in for.
      if (outcome.status === 409) {
        setNotConfigured(true);
        if (advisor.bridgeStatus === 'ready') {
          // Hand off instead of reporting: this 409 isn't a failure the user
          // asked about, it's exactly the situation this whole feature exists
          // to route around, and retrying it silently on every press (rather
          // than trusting yesterday's `notConfigured`) is what notices a
          // provider that gets configured mid-session on the very next press
          // — see the component docblock.
          //
          // `open` and `send` are NOT called back to back: `send` reads which
          // board it's asking about off `AdvisorProvider`'s own reducer
          // state, and that state only updates once `open`'s dispatch has
          // actually committed — one render later, not in the same tick. A
          // session that has never opened the advisor (or last had it open
          // on a different board) would have `send` fire while the reducer
          // still says the OLD board, filing the question under the wrong
          // conversation entirely. So this only records the request
          // (`pendingBridgePromptRef`) and fires `open`; the effect declared
          // above it watches for `advisor.state` to actually agree with this
          // board before sending, however many renders that takes — zero,
          // when the advisor was already here.
          pendingBridgePromptRef.current = ASK_LOCAL_AGENT_PROMPT;
          setRunningVia('bridge');
          advisor.open({ boardId, widgetType: FOCUS_LEDGER_WIDGET_TYPE });
          return;
        }
      }
      // The commonest failure is an organization with no advisor configured, and
      // that sentence is the only explanation for a button that did nothing.
      setFailed(true);
      setMessage(outcome.error);
      setRunningVia(null);
      return;
    }

    // A successful server run is proof the provider now works — reachable
    // even after `notConfigured` was learned true earlier this mount, since
    // every press retries the server path first. Clearing it here is what
    // makes the label stop offering the bridge once the cheaper path is
    // confirmed working again, rather than only functioning correctly while
    // still visually claiming the bridge is the only way.
    setNotConfigured(false);

    const { classified, remaining, providerError } = outcome.result;
    // The remainder is the honest part: a capped run reporting only what it
    // classified would look complete when it is not.
    const progress =
      remaining > 0
        ? `Classified ${classified}. ${remaining} still unclassified.`
        : `Classified ${classified}.`;
    // A provider failure mid-run still saved what it earned, so this is a
    // success carrying a reason rather than an error. Saying only "Classified
    // 40" would present a rejected API key as a model that found little to do.
    setFailed(!!providerError);
    setLeftOver(remaining);
    setMessage(providerError ? `${progress} The advisor failed: ${providerError}` : progress);
    setRunningVia(null);
    onRun();
  }

  return (
    <div
      ref={stripRef}
      // `status` + `polite`, matching DashboardCanvas and WidgetEmptyState: this
      // swaps a description for a result and can turn red with no other signal.
      role="status"
      aria-live="polite"
      // Focusable only programmatically — it is not a tab stop, but it must be
      // able to receive focus when the button it contained disappears.
      tabIndex={-1}
      // `outline-none` alone would land focus here invisibly, blunting half of
      // what the focus move is for; `focus-visible` shows the ring to a keyboard
      // user without making the strip look focused after a mouse click.
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
        failed ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="min-w-0">
        <p className={`text-[13px] ${failed ? 'text-red-700' : 'text-slate-700'}`}>
          {message ?? `${unclassified} tasks carry no classification.`}
        </p>
        {message === null && (
          <p className="mt-0.5 text-xs text-slate-500">
            Sends up to {FOCUS_MODEL_BUDGET} of them to your advisor model.
          </p>
        )}
      </div>
      {label && (
        <button
          type="button"
          disabled={runningVia !== null}
          onClick={run}
          className="shrink-0 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {label}
        </button>
      )}
    </div>
  );
}
