'use client';
import { useState } from 'react';
import { useWidgetConfigWithBoardPeriod } from '../../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from '../useWidgetData';
import { WidgetErrorState } from '../WidgetErrorState';
import { WidgetEmptyState } from '../WidgetEmptyState';
import {
  FocusNoData,
  ClassBar,
  ClassLegend,
  sumClasses,
  STAGE_COLOR,
  STAGE_LABEL,
  WidgetLoading,
  type FocusStageKey,
  type FocusClassKey,
} from './focus-ui';
import { FocusStageMapEditor } from './FocusStageMapEditor';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
  /**
   * Whether this caller may edit the board. Gates the stage-map controls only:
   * the API refuses a save with `board('EDITOR')`, so showing the control to a
   * viewer would walk them into a 403 for no reason.
   */
  canEdit?: boolean;
}

interface Person {
  name: string;
  tasks: number;
  neverMoved: number;
  inProduction: number;
  unshipped: number;
  attention: Record<FocusClassKey, number>;
  shares: Record<FocusClassKey, number>;
  workingDays: number;
  isLateJoiner: boolean;
  firstActivity: string | null;
}

interface AttentionSplit {
  people: Person[];
  totals: Record<FocusClassKey, number>;
  shares: Record<FocusClassKey, number>;
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

export function FocusAttentionSplitWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<AttentionSplit>(boardId, 'FOCUS_ATTENTION_SPLIT', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (data.people.length === 0) return <FocusNoData {...data} />;

  const max = Math.max(
    1,
    ...data.people.map((p) => sumClasses(p.attention)),
  );

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex-1 space-y-2 overflow-auto">
        {data.people.map((p) => {
          const total = sumClasses(p.attention);
          return (
            <div key={p.name} className="flex items-center gap-3">
              <div className="w-40 shrink-0 text-right">
                <p className="text-sm font-medium text-slate-700 leading-tight">{p.name}</p>
                {p.isLateJoiner && (
                  <p className="text-[10px] text-indigo-600">from {p.firstActivity}</p>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <ClassBar attention={p.attention} max={max} />
              </div>
              <p className="w-14 shrink-0 text-right text-xs text-slate-500 tabular-nums">
                <b className="text-slate-800">{total}</b> d
              </p>
            </div>
          );
        })}
      </div>
      <div className="pt-2 border-t border-slate-100 space-y-2">
        <ClassLegend />
        {/* Stated on the face of the widget, not in a tooltip: tasks overlap, so
            this can exceed the days in the window and is not effort. */}
        <p className="text-xs text-slate-400">
          Calendar days in a working state, moved tasks only. A share-of-attention proxy, not FTE
          effort.
        </p>
      </div>
    </div>
  );
}

interface Funnel {
  counts: Record<FocusStageKey, number>;
  /**
   * The count of FEATURES that are work — issues rolled up to the root of their
   * parent chain, minus features nobody ever started. Deliberately not
   * `taskCount`, which counts issues; the widget says which it is showing,
   * because provenance on the same page divides by issues.
   */
  total: number;
  /** Features nobody started, excluded from `total` and every count. */
  featuresCancelledNeverWorked?: number;
  /** All-time attention on features that were abandoned entirely. */
  wastedDaysAbandonedFeatures?: number;
  /** All-time attention on cancelled work inside features that survived. */
  wastedDaysInsideLiveFeatures?: number;
  unmappedStates: string[];
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

/**
 * The funnel's own segment order — NOT the same declaration as the identically
 * named `STAGE_ORDER` in `FocusStageMapEditor.tsx`, which orders that dialog's
 * dropdown. Two unrelated constants; changing one and not the other gives a
 * funnel that cannot draw a stage, or an editor that cannot select it.
 *
 * `CANCELLED` sits after `IN_DEVELOPMENT`: the position in the flow where the
 * work died.
 */
const STAGE_ORDER: FocusStageKey[] = [
  'IN_PRODUCTION',
  'WAITING_TO_SHIP',
  'IN_DEVELOPMENT',
  'CANCELLED',
  'NOT_STARTED',
];

export function FocusDeliveryFunnelWidget({ boardId, config, canEdit = false }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error, refetch } = useWidgetData<Funnel>(boardId, 'FOCUS_DELIVERY_FUNNEL', merged);
  const [editing, setEditing] = useState(false);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  // A population of zero WORK is not the same as a window with nothing in it.
  // When every task was cancelled before anyone started, the generic empty state
  // would report that no tasks were touched — describing a process fact as an
  // idle team, which R6.12 forbids. This is the one case where the exclusion
  // accounts for the whole widget, so it is the one case that must say so.
  if (data.total === 0 && (data.featuresCancelledNeverWorked ?? 0) > 0) {
    return (
      <div className="text-sm text-slate-600">
        <p className="font-medium">No work to place.</p>
        <p className="text-xs text-slate-500 mt-1">
          Every one of the {data.featuresCancelledNeverWorked} features in this window was
          cancelled before any work began, so none of them is work that ended up anywhere.
        </p>
      </div>
    );
  }
  if (data.total === 0) return <FocusNoData {...data} />;

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex-1 space-y-3">
        {STAGE_ORDER.map((stage) => {
          const n = data.counts[stage];
          const pct = Math.round((n / data.total) * 100);
          return (
            <div key={stage}>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-medium" style={{ color: STAGE_COLOR[stage] }}>
                  {STAGE_LABEL[stage]}
                </span>
                <span className="text-xs text-slate-500 tabular-nums">
                  <b className="text-slate-800 text-sm">{n}</b> · {pct}%
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, background: STAGE_COLOR[stage] }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {/* The boundary between the middle two is MERGED — in development is the
          engineer's to finish, waiting to ship is not. Saying so is what stops
          the two being read as one "unfinished" pile. */}
      <p className="text-xs text-slate-400 pt-2 border-t border-slate-100">
        {/* Says which grain this is. Provenance on the same page divides by
            ISSUES, so a reader comparing the two totals needs to be told, or one
            of the widgets looks broken. */}
        <b className="text-slate-600">{data.total} features</b> — issues rolled up to the
        top-level item they hang under, so work on a sub-task counts for its epic.
      </p>
      <p className="text-xs text-slate-400">
        The line between in development and waiting to ship is{' '}
        <b className="text-slate-600">merged</b>: in development is still the engineer&apos;s to
        finish, waiting to ship is not.
      </p>
      {/* Two figures, not one, because two problems were being added together:
          a feature built and binned whole, versus scope trimmed inside one that
          shipped. The second is also what keeps `rollUpStages`' precedence
          honest — a feature with one shipped child and ten cancelled reads
          in-production, so those ten only appear here.

          Both un-windowed, said out loud: the event is "cancelled in this
          window" and its cost is every day ever spent. Each suppressed at zero
          independently — "0 days" reads as a measurement rather than the absence
          of one, and a board can abandon features without having trimmed any. */}
      {(data.wastedDaysAbandonedFeatures ?? 0) > 0 && (
        <p className="text-xs text-slate-500">
          ~{data.wastedDaysAbandonedFeatures} days of attention went into features that were
          abandoned entirely — <b className="text-slate-600">all-time</b>, unlike every other
          figure here.
        </p>
      )}
      {(data.wastedDaysInsideLiveFeatures ?? 0) > 0 && (
        <p className="text-xs text-slate-500">
          ~{data.wastedDaysInsideLiveFeatures} days more went into cancelled work inside
          features that shipped or are still live.
        </p>
      )}
      {/* Stated rather than silent: an exclusion nobody can see is
          indistinguishable from a bug. */}
      {(data.featuresCancelledNeverWorked ?? 0) > 0 && (
        <p className="text-xs text-slate-400">
          {data.featuresCancelledNeverWorked} features cancelled before any work began are
          excluded — never work, so not counted here.
        </p>
      )}
      {data.unmappedStates.length > 0 && (
        <p className="text-xs text-amber-700">
          Counted as not started because this board&apos;s stage map does not know them:{' '}
          {data.unmappedStates.join(', ')}.
        </p>
      )}
      {/* The way out of the caveat above, at the place it is read. An unmapped
          state inflates "not started" and empties the two middle bars, so the
          fix belongs next to the wrong number rather than in a settings page
          the reader has no reason to look for. Offered even with nothing
          unmapped: the in-development / waiting-to-ship line is arguable for QA
          and client-review states whether or not anything is broken. */}
      {canEdit && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-left text-indigo-600 hover:text-indigo-800 hover:underline"
        >
          {data.unmappedStates.length > 0
            ? `Map ${data.unmappedStates.length === 1 ? 'this 1 state' : `these ${data.unmappedStates.length} states`} →`
            : 'Configure stage map →'}
        </button>
      )}
      <FocusStageMapEditor
        open={editing}
        boardId={boardId}
        onClose={() => setEditing(false)}
        // The save already evicted this board's server-side widget cache; this
        // is what makes the bars move without a page reload.
        onSaved={() => refetch()}
      />
    </div>
  );
}

interface Provenance {
  provenance: { HUMAN: number; CAPEX: number; RULE: number; MODEL: number; NONE: number };
  total: number;
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

const SOURCE_META = [
  ['CAPEX', 'CAPEX set on the board row', '#4f46e5'],
  ['RULE', 'Matched a rule', '#0891b2'],
  ['MODEL', 'Judged by the model', '#d97706'],
  ['HUMAN', 'Set by hand', '#16a34a'],
  ['NONE', 'Not classified', '#94a3b8'],
] as const;

export function FocusProvenanceWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Provenance>(boardId, 'FOCUS_PROVENANCE', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (data.total === 0) return <FocusNoData {...data} />;

  const capexPct = Math.round((data.provenance.CAPEX / data.total) * 100);

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex h-2.5 rounded-full overflow-hidden">
        {SOURCE_META.map(([key, , color]) => {
          const n = data.provenance[key];
          return n > 0 ? (
            <i key={key} style={{ flex: n, background: color }} title={`${n} tasks`} />
          ) : null;
        })}
      </div>
      <dl className="space-y-1.5 text-sm flex-1">
        {SOURCE_META.map(([key, label, color]) => (
          <div key={key} className="flex items-center gap-2">
            <i
              aria-hidden
              className="w-2.5 h-2.5 rounded-sm inline-block"
              style={{ background: color }}
            />
            <dt className="text-slate-600 flex-1">{label}</dt>
            <dd className="font-semibold text-slate-800 tabular-nums">{data.provenance[key]}</dd>
          </div>
        ))}
      </dl>
      {/* The incentive, stated plainly: the field is cheap and better than a
          guess, and today almost nobody fills it in. */}
      <p className="text-xs text-slate-500 pt-2 border-t border-slate-100">
        Only <b className="text-slate-700">{data.provenance.CAPEX} of {data.total}</b> ({capexPct}%)
        carry a CAPEX/OPEX value, so the model is doing work the field would do for free — and more
        defensibly. Classify rows on the board and this shifts left on the next sync.
      </p>
    </div>
  );
}

interface BoardCoverage {
  epics: { key: string; title: string; touched: boolean; tasks: number }[];
  offBoardTasks: number;
  total: number;
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

export function FocusBoardCoverageWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<BoardCoverage>(boardId, 'FOCUS_BOARD_COVERAGE', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;

  const touched = data.epics.filter((e) => e.touched).length;

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex flex-wrap gap-1.5 flex-1 overflow-auto content-start">
        {data.epics.length === 0 ? (
          <p className="text-sm text-slate-500">
            No epic on this board is marked CAPEX. Mark the epics that make up
            your roadmap as CAPEX on the board and they will appear here.
          </p>
        ) : (
          data.epics.map((e) => (
            <span
              key={e.key}
              title={e.touched ? `${e.title} — ${e.tasks} task(s)` : `${e.title} — no activity`}
              className={`px-2 py-1 rounded-md text-[11px] font-mono ${
                e.touched
                  ? 'bg-emerald-600 text-white font-semibold'
                  : 'bg-rose-50 border border-rose-100 text-slate-400'
              }`}
            >
              {e.key}
            </span>
          ))
        )}
      </div>
      {data.epics.length > 0 && (
        <div className="flex items-center gap-4 text-xs pt-2 border-t border-slate-100">
          <span className="text-emerald-700 font-semibold">{touched} touched</span>
          <span className="text-rose-600 font-semibold">
            {data.epics.length - touched} untouched
          </span>
        </div>
      )}
      {/* The finding this whole view exists to surface: the board is not the
          same thing as the work. */}
      {data.offBoardTasks > 0 && (
        <p className="text-xs text-slate-600 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 leading-relaxed">
          <b className="text-slate-800">
            {data.offBoardTasks} of {data.total} tasks never appeared on this board.
          </b>{' '}
          They exist only in the synced source. This view reads that source, not the board rows, so
          the gap is visible rather than invisible.
        </p>
      )}
    </div>
  );
}
