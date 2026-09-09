'use client';
import { useEffect, useRef, useState } from 'react';
import { FOCUS_MODEL_BUDGET } from '@deckgauge/shared';
import { runFocusClassification } from '../../../../actions/focus-classify';

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
 */
export function FocusClassifyNotice({ boardId, config, unclassified, onRun }: Props) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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
   */
  const label = running
    ? 'Classifying…'
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
   * Absent when there is nothing to classify AND nothing to report.
   *
   * The second half matters: the count drops to zero on the refetch after a run
   * that finished the job, so hiding on the count alone would take the
   * "Classified 26." confirmation off screen with it and make a successful press
   * look like it did nothing.
   */
  if (unclassified === 0 && message === null) return null;

  async function run() {
    setRunning(true);
    setMessage(null);
    setFailed(false);
    setLeftOver(null);

    // try/finally, because a rejection here — the API unreachable, a Next digest
    // — would otherwise leave the button reading "Classifying…" forever with no
    // message, the one state this component exists to avoid.
    let outcome: Awaited<ReturnType<typeof runFocusClassification>>;
    try {
      outcome = await runFocusClassification(boardId, config);
    } catch (err) {
      setFailed(true);
      setMessage(err instanceof Error ? err.message : 'The run could not be started.');
      return;
    } finally {
      setRunning(false);
    }

    if (!outcome.ok) {
      // The commonest failure is an organization with no advisor configured, and
      // that sentence is the only explanation for a button that did nothing.
      setFailed(true);
      setMessage(outcome.error);
      return;
    }

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
          disabled={running}
          onClick={run}
          className="shrink-0 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {label}
        </button>
      )}
    </div>
  );
}
