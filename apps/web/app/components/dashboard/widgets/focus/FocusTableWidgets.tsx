'use client';
import { useMemo, useState } from 'react';
import { useWidgetConfigWithBoardPeriod } from '../../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from '../useWidgetData';
import { WidgetErrorState } from '../WidgetErrorState';
import { WidgetEmptyState } from '../WidgetEmptyState';
import {
  FocusNoData,
  CLASS_GLYPH,
  classPillLabel,
  CLASS_COLOR,
  CLASS_KEYS,
  CLASS_LABEL,
  CLASS_SHORT_LABEL,
  sumClasses,
  ClassBar,
  STAGE_COLOR,
  STAGE_LABEL,
  WidgetLoading,
  type FocusClassKey,
  type FocusStageKey,
} from './focus-ui';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

/**
 * Both tables here scroll their own body inside a fixed-height widget card, so
 * an unfrozen header leaves the viewport after two rows and the rest of the
 * table is a grid of unlabelled numbers — which for these two widgets is the
 * entire content.
 *
 * Sticky is on the CELLS rather than the <tr> or <thead>. These tables are
 * border-collapse (Tailwind's preflight sets it), and a collapsed table's row
 * and row-group boxes are not reliably positionable across engines while its
 * cells always are.
 *
 * For the same reason the underline is an inset shadow, not `border-b`: a
 * collapsed border belongs to the table grid and scrolls away with it, leaving
 * the frozen header with no edge against the rows sliding under it. And each
 * cell needs its OWN background — the <tr>'s paints behind the grid and
 * scrolls too, so without it the rows read straight through the header.
 * bg-white is WidgetCard's own fill.
 */
const FROZEN_TH =
  'sticky top-0 z-10 bg-white shadow-[inset_0_-1px_0_theme(colors.slate.200)] font-semibold pt-1 pb-2';

/**
 * The ledger's header is a dark band, so it carries slate-800 as its fill and
 * needs no rule. Horizontal padding stays per-cell: one column uses px-2 and
 * merging conflicting utilities into one class string does not resolve them —
 * stylesheet order decides, not the order they are written here.
 */
const FROZEN_TH_DARK = 'sticky top-0 z-10 bg-slate-800 font-semibold py-2.5';

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

export function FocusScorecardWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<{ people: Person[]; taskCount?: number; sourcesLastSyncedAt?: string | null; emptyReason?: string }>(
    boardId,
    'FOCUS_SCORECARD',
    merged,
  );

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (data.people.length === 0) return <FocusNoData {...data} />;

  // Must sum the SAME classes ClassBar renders. Scaling by an A+B+C total while
  // the bar draws every class let the segments total 1000% of the track; the
  // container is overflow-hidden, so a person at 10% roadmap and 90% D rendered
  // as a solid-green 100%-roadmap row — a flattering wrong answer, which is the
  // one kind this widget exists to prevent.
  const max = Math.max(1, ...data.people.map((p) => sumClasses(p.attention)));

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm min-w-[720px]">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-400">
            <th className={`${FROZEN_TH} text-left pr-3`}>Person</th>
            <th className={`${FROZEN_TH} text-right px-2`}>Tasks</th>
            <th className={`${FROZEN_TH} text-right px-2`}>Never&nbsp;moved</th>
            <th className={`${FROZEN_TH} text-right px-2`}>In&nbsp;prod</th>
            <th className={`${FROZEN_TH} text-right px-2`}>Unshipped</th>
            <th className={`${FROZEN_TH} text-right px-2`}>Working&nbsp;days</th>
            <th className={`${FROZEN_TH} text-left pl-4 w-56`}>Attention split</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.people.map((p) => (
            <tr key={p.name} className="hover:bg-slate-50">
              <td className="py-2.5 pr-3">
                <div className="text-sm font-medium text-slate-800">{p.name}</div>
                {/* The late-joiner marker is in the row TEXT, not a colour, so a
                    screen reader and a screenshot both carry it. */}
                {p.isLateJoiner && (
                  <div className="text-[11px] text-indigo-600">
                    Measured from {p.firstActivity}, their first recorded ticket movement — not the full window.
                  </div>
                )}
              </td>
              <td className="text-right px-2 py-2.5 tabular-nums text-slate-700">{p.tasks}</td>
              <td
                className={`text-right px-2 py-2.5 tabular-nums ${
                  p.neverMoved > 0 ? 'text-rose-600 font-semibold' : 'text-slate-700'
                }`}
              >
                {p.neverMoved}
              </td>
              <td className="text-right px-2 py-2.5 tabular-nums text-slate-700">
                {p.inProduction}
              </td>
              <td className="text-right px-2 py-2.5 tabular-nums text-slate-700">{p.unshipped}</td>
              <td className="text-right px-2 py-2.5 tabular-nums text-slate-700">
                {p.workingDays}
              </td>
              <td className="pl-4 py-2.5">
                <div className="w-48">
                  <ClassBar attention={p.attention} max={max} />
                </div>
                {/* Every non-zero class, not a fixed pair. This line used to
                    read `{p.shares.A}% roadmap · {p.shares.C}% internal`, so a
                    person at 90% non-roadmap reported "10% roadmap · 0%
                    internal" — two numbers that are individually true and
                    together imply the other 90% does not exist. This widget
                    renders no legend, so it is also the only place a class is
                    named outside a hover title — unclassified attention
                    included, now that it has a share of its own. */}
                {/* No fallback text: ClassBar directly above already says "no
                    recorded attention" when there is none, and having both
                    rendered it twice in one cell — which a `getByText` would
                    throw on. */}
                {CLASS_KEYS.some((c) => p.shares[c] > 0) && (
                  <div className="text-[10px] text-slate-400 mt-1 tabular-nums">
                    {CLASS_KEYS.filter((c) => p.shares[c] > 0)
                      .map((c) => `${p.shares[c]}% ${CLASS_SHORT_LABEL[c]}`)
                      .join(' · ')}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Not a disclaimer — a correction to how this table will otherwise be
          read. On the reference data the team lead showed 16 tasks and 0 in
          production while opening more pull requests and casting more reviews
          than anyone he managed. Until review and PR counts are columns here,
          a low row is evidence of nothing on its own. */}
      <p className="text-xs text-slate-500 mt-3 pt-2 border-t border-slate-100 max-w-3xl">
        Ticket counts only. Reviewing, mentoring, incident response and meetings
        appear in none of these columns, and a manager&apos;s row will understate their
        contribution accordingly — a low count here is not evidence of low output.
      </p>
    </div>
  );
}

interface Task {
  taskKey: string;
  provider: 'jira' | 'ado';
  title: string;
  state: string;
  stage: FocusStageKey;
  cls: FocusClassKey;
  reason: string;
  epicKey: string | null;
  owner: string | null;
  attentionDays: number;
  movesInWindow: number;
  onBoard: boolean;
  alsoInAdo?: boolean;
}

function Pill({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
        active
          ? 'bg-slate-800 border-slate-800 text-white font-semibold'
          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The ledger: every task, its raw state beside its derived stage, its class and
 * the printed reason.
 *
 * The raw state sits next to the mapped stage on purpose — that is what lets
 * someone see HOW a state was interpreted and argue with it, rather than being
 * handed a stage and asked to trust it.
 */
export function FocusLedgerWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<{ tasks: Task[]; taskCount?: number; sourcesLastSyncedAt?: string | null; emptyReason?: string }>(
    boardId,
    'FOCUS_LEDGER',
    merged,
  );

  const [person, setPerson] = useState<string | null>(null);
  const [cls, setCls] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const people = useMemo(
    () => [...new Set(tasks.map((t) => t.owner).filter((o): o is string => o !== null))].sort(),
    [tasks],
  );

  const rows = tasks.filter(
    (t) =>
      (person === null || t.owner === person) &&
      (cls === null || t.cls === cls) &&
      (stage === null || t.stage === stage),
  );

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (tasks.length === 0) return <FocusNoData {...data} />;

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="space-y-1.5">
        <div className="flex items-start gap-2">
          <span className="w-14 shrink-0 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Person
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Pill active={person === null} onClick={() => setPerson(null)}>
              All
            </Pill>
            {people.map((p) => (
              <Pill key={p} active={person === p} onClick={() => setPerson(p)}>
                {p}
              </Pill>
            ))}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <span className="w-14 shrink-0 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Class
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Pill active={cls === null} onClick={() => setCls(null)}>
              All
            </Pill>
            {CLASS_KEYS.map((c) => (
              <Pill key={c} active={cls === c} onClick={() => setCls(c)}>
                {classPillLabel(c)}
              </Pill>
            ))}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <span className="w-14 shrink-0 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Stage
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Pill active={stage === null} onClick={() => setStage(null)}>
              All
            </Pill>
            {(Object.keys(STAGE_LABEL) as FocusStageKey[]).map((s) => (
              <Pill key={s} active={stage === s} onClick={() => setStage(s)}>
                {STAGE_LABEL[s]}
              </Pill>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="bg-slate-800 text-white text-[11px] uppercase tracking-wide">
              <th className={`${FROZEN_TH_DARK} text-left px-3 w-28`}>ID</th>
              <th className={`${FROZEN_TH_DARK} text-left px-2 w-10`}>Cl</th>
              <th className={`${FROZEN_TH_DARK} text-left px-3`}>Title &amp; classification reason</th>
              <th className={`${FROZEN_TH_DARK} text-left px-3 w-28`}>Owner</th>
              <th className={`${FROZEN_TH_DARK} text-left px-3 w-28`}>State</th>
              <th className={`${FROZEN_TH_DARK} text-left px-3 w-32`}>Delivery stage</th>
              <th className={`${FROZEN_TH_DARK} text-left px-3 w-24`}>System</th>
              <th className={`${FROZEN_TH_DARK} text-right px-3 w-16`}>Moves</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">
                  No tasks match these filters.
                </td>
              </tr>
            ) : (
              rows.map((t) => (
                <tr key={t.taskKey} className="hover:bg-slate-50 align-top">
                  <td className="px-3 py-2.5">
                    <span className="font-mono text-[12px] font-medium text-slate-800">
                      {t.taskKey}
                    </span>
                  </td>
                  <td className="px-2 py-2.5">
                    <span
                      title={CLASS_LABEL[t.cls]}
                      className="inline-grid place-items-center w-5 h-5 rounded text-[11px] font-bold text-white"
                      style={{ background: CLASS_COLOR[t.cls] }}
                    >
                      {CLASS_GLYPH[t.cls]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-[13px] font-medium text-slate-800">{t.title}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{t.reason}</div>
                  </td>
                  <td className="px-3 py-2.5 text-[13px] text-slate-600">{t.owner ?? '—'}</td>
                  <td className="px-3 py-2.5 text-[13px] text-slate-700">{t.state}</td>
                  <td
                    className="px-3 py-2.5 text-[13px] font-medium"
                    style={{ color: STAGE_COLOR[t.stage] }}
                  >
                    {STAGE_LABEL[t.stage]}
                  </td>
                  <td className="px-3 py-2.5 text-[13px] text-slate-500">
                    {/* A merged row keeps its Jira key, so saying only "Jira"
                        would hide that the task was tracked in both — and that
                        its history came from both. */}
                    {t.alsoInAdo
                      ? 'Jira + Azure DevOps'
                      : t.provider === 'ado'
                        ? 'Azure DevOps'
                        : 'Jira'}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right tabular-nums text-[13px] ${
                      t.movesInWindow === 0 ? 'text-rose-600 font-semibold' : 'text-slate-700'
                    }`}
                  >
                    {t.movesInWindow}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">
        Showing {rows.length} of {tasks.length}. A zero in Moves means nothing observable happened
        to that task in the window.
      </p>
    </div>
  );
}

export function FocusCaveatsWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<{
    caveats: { key: string; text: string }[];
    emptyReason?: string;
  }>(boardId, 'FOCUS_CAVEATS', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;

  return (
    <div className="h-full overflow-auto">
      <p className="text-xs text-slate-400 italic mb-3">
        Written by the render, not by a person. A caveat that does not apply to this window is
        absent rather than greyed out.
      </p>
      <dl className="grid sm:grid-cols-2 gap-x-6">
        {data.caveats.map((c) => (
          <div key={c.key + c.text} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 border-b border-slate-100">
            <dt className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold pt-0.5">
              {c.key}
            </dt>
            <dd className="text-[13px] text-slate-600 leading-relaxed">{c.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
