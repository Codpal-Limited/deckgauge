'use client';

import { Fragment, useState } from 'react';
import {
  gradeTrajectory,
  type PeriodComparisonMetric,
  type PeriodMetricKey,
  type DeltaVerdict,
  type TrajectoryGrade,
} from '@deckgauge/shared';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  metrics: PeriodComparisonMetric[];
  periodA?: { from: string; to: string };
  periodB?: { from: string; to: string };
  emptyReason?: string;
  trajectories?: Record<string, Array<{ month: string; value: number | null }>>;
}

const VERDICT_STYLE: Record<DeltaVerdict, { cls: string; arrow: string; word: string }> = {
  improved: { cls: 'bg-emerald-100 text-emerald-700', arrow: '▲', word: 'Improved' },
  regressed: { cls: 'bg-rose-100 text-rose-700', arrow: '▼', word: 'Regressed' },
  flat: { cls: 'bg-amber-100 text-amber-700', arrow: '●', word: 'Flat' },
  na: { cls: 'bg-slate-100 text-slate-400', arrow: '–', word: 'N/A' },
};

const GRADE_STYLE: Record<TrajectoryGrade, { cls: string; word: string }> = {
  improving: { cls: 'bg-emerald-100 text-emerald-700', word: 'Improving' },
  regressing: { cls: 'bg-rose-100 text-rose-700', word: 'Regressing' },
  flat: { cls: 'bg-amber-100 text-amber-700', word: 'Flat' },
  stalling: { cls: 'bg-amber-100 text-amber-700', word: 'Stalling' },
  recovering: { cls: 'bg-emerald-100 text-emerald-700', word: 'Recovering' },
};

// Plain-English explanation shown when a metric row is expanded: what the number
// actually measures, and what a good/bad reading tells the team. Kept beside the
// widget (not in the shared help map) because it is specific to these five rows.
const METRIC_HELP: Record<PeriodMetricKey, { measures: string; meaning: string }> = {
  cycle_time: {
    measures: "Median time from a change's first commit to its pull request being merged.",
    meaning:
      'How fast the team turns started work into merged code. Rising cycle time usually means reviews are slow or PRs are too large — the biggest lever on delivery speed. Lower is better.',
  },
  issue_cycle_time: {
    measures:
      'Median time from a work item (Jira issue / ADO work item) being created to it reaching a done state.',
    meaning:
      "How long tickets take to go from raised to done — the delivery clock the team actually plans against. Unlike PR cycle time it captures the work that happens before a PR is opened, so it stays meaningful when PRs are opened and merged in minutes. A bulk-close guard drops items older than 90 days so a mass historical cleanup can't skew it. Lower is better.",
  },
  deploy_frequency: {
    measures:
      'How often the team ships, counted as merged PRs per week (a proxy for deploys — no deployment source is connected yet).',
    meaning:
      'Delivery cadence and batch size. Frequent small merges signal healthy continuous flow; a drop means work is pooling into larger, riskier releases. Higher is better.',
  },
  change_failure_rate: {
    measures:
      'The share of commits that are corrective — fixes, reverts, hotfixes or rollbacks (a proxy matched from commit messages; no incident source is connected yet).',
    meaning:
      'How much effort goes into repairing recent work instead of building new value. A rising rate is an early quality-and-stability warning. Lower is better.',
  },
  time_to_restore: {
    measures: 'Median time from a bug or incident issue being opened to it being closed.',
    meaning:
      "How quickly the team recovers when something breaks. A climbing value points to slow triage or a fragile area that's hard to fix. Lower is better.",
  },
  throughput: {
    measures: 'The number of issues the team completed (closed) in the window.',
    meaning:
      'Raw delivery volume. Read it alongside the others — more throughput with a rising change-failure rate or slower cycle time can mean shipping fast but breaking things. Higher is generally better.',
  },
};

const SPARKLINE_PAD = 4;
const SPARKLINE_WIDTH = 160;
const SPARKLINE_HEIGHT = 40;

function Sparkline({ series }: { series: number[] }) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const innerWidth = SPARKLINE_WIDTH - SPARKLINE_PAD * 2;
  const innerHeight = SPARKLINE_HEIGHT - SPARKLINE_PAD * 2;
  const step = series.length > 1 ? innerWidth / (series.length - 1) : 0;

  const points = series.map((v, i) => {
    const x = SPARKLINE_PAD + i * step;
    const y = SPARKLINE_PAD + innerHeight - ((v - min) / range) * innerHeight;
    return { x, y };
  });

  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  const end = points[points.length - 1]!;

  return (
    <svg
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      className="h-10 w-40"
      role="img"
      aria-label="Trajectory sparkline"
    >
      <polyline
        points={polyline}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="text-slate-400"
      />
      <circle cx={end.x} cy={end.y} r={2.5} className="fill-slate-700" />
    </svg>
  );
}

function fmt(v: number | null, unit: PeriodComparisonMetric['unit']): string {
  if (v == null) return '—';
  if (unit === 'hours') return v >= 48 ? `${(v / 24).toFixed(1)}d` : `${v}h`;
  if (unit === 'percent') return `${v}%`;
  return `${v}`;
}

function fmtQuarter(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

export default function PeriodComparisonWidget({ boardId, config }: Props) {
  const { data, error } = useWidgetData<Data>(boardId, 'PERIOD_COMPARISON', config);
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400 p-2">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  const colA = fmtQuarter(data.periodA?.to) || 'Period A';
  const colB = fmtQuarter(data.periodB?.to) || 'Period B';

  function toggle(key: string) {
    setOpenKey((prev) => (prev === key ? null : key));
  }

  function handleKeyDown(e: React.KeyboardEvent, key: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(key);
    }
  }

  return (
    <div className="overflow-x-auto p-1">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th className="py-2 pr-3 text-left font-medium">Metric</th>
            <th className="py-2 px-3 text-right font-medium whitespace-nowrap">{colA}</th>
            <th className="py-2 px-3 text-right font-medium whitespace-nowrap">{colB}</th>
            <th className="py-2 pl-3 text-right font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {data.metrics.map((m) => {
            const v = VERDICT_STYLE[m.delta.verdict];
            const pct = m.delta.pct == null ? '' : ` ${m.delta.pct > 0 ? '+' : ''}${m.delta.pct}%`;
            const isOpen = openKey === m.key;
            const series = (data.trajectories?.[m.key] ?? [])
              .map((p) => p.value)
              .filter((val): val is number => val != null);
            return (
              <Fragment key={m.key}>
                <tr className="border-b border-slate-100">
                  <td
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={() => toggle(m.key)}
                    onKeyDown={(e) => handleKeyDown(e, m.key)}
                    className="py-2 pr-3 text-slate-700 cursor-pointer select-none"
                  >
                    <span
                      aria-hidden="true"
                      className={`inline-block mr-1 transition-transform motion-reduce:transition-none ${
                        isOpen ? 'rotate-90' : ''
                      }`}
                    >
                      ▶
                    </span>
                    {m.label}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-400">
                    {fmt(m.past, m.unit)}
                  </td>
                  <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold text-slate-800">
                    {fmt(m.now, m.unit)}
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${v.cls}`}
                    >
                      <span aria-hidden="true">{v.arrow}</span>
                      {v.word}
                      {pct}
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <td colSpan={4} className="py-3 px-3">
                      <div className="space-y-3">
                        <dl className="max-w-prose space-y-1 text-xs leading-snug text-slate-600">
                          <div>
                            <dt className="inline font-semibold text-slate-500">
                              What it measures —{' '}
                            </dt>
                            <dd className="inline">{METRIC_HELP[m.key].measures}</dd>
                          </div>
                          <div>
                            <dt className="inline font-semibold text-slate-500">
                              What it means for the team —{' '}
                            </dt>
                            <dd className="inline">{METRIC_HELP[m.key].meaning}</dd>
                          </div>
                        </dl>
                        {series.length < 2 ? (
                          <p className="text-xs text-slate-400">
                            Not enough history for a trend yet.
                          </p>
                        ) : (
                          <div className="flex items-center gap-3">
                            <Sparkline series={series} />
                            {(() => {
                              const verdict = gradeTrajectory(m.direction, series);
                              const g = GRADE_STYLE[verdict.grade];
                              return (
                                <span
                                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${g.cls}`}
                                >
                                  {g.word}
                                </span>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
