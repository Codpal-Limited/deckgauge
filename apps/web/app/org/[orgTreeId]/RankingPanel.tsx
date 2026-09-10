'use client';

import type { OrgEmployeeDto } from '@deckgauge/shared';
import {
  rankBadgeView,
  RANKING_METRIC_LABELS,
  formatWeight,
} from './employee-presentation';
import { TableScroller } from '../../components/TableScroller';

// The four metrics in descending weight order — matches the leaderboard weighting
// so the breakdown reads top-down by importance.
const METRIC_ORDER = ['ticketsClosed', 'prsMerged', 'commitsToMain', 'reviewComments'] as const;

/**
 * The "Ranking" tab: the employee's tree-relative leaderboard position and the full
 * arithmetic behind it — raw count, 0–100 subscore, weight, and weighted contribution
 * per metric, footing to the composite score.
 */
export function RankingPanel({ employee }: { employee: OrgEmployeeDto }) {
  const ranking = employee.ranking;

  if (!ranking) {
    return (
      <div className="rounded-lg border border-slate-200 p-6 text-center">
        <p className="text-sm font-medium text-slate-600">Not ranked</p>
        <p className="mt-1 text-xs text-slate-400">
          This person has no matched contribution activity in the last 90 days, so they don&apos;t
          appear on this org tree&apos;s leaderboard yet.
        </p>
      </div>
    );
  }

  const badge = rankBadgeView(ranking);

  return (
    <div className="space-y-4">
      {/* Headline */}
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-4">
        <span
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-slate-100 text-2xl"
          aria-hidden="true"
        >
          {badge.emoji ?? '#'}
        </span>
        <div className="min-w-0">
          <div className="text-lg font-semibold text-slate-900">
            Rank #{ranking.rank}
            <span className="ml-1 text-sm font-normal text-slate-400">
              of {ranking.totalRanked}
            </span>
          </div>
          <div className="text-sm text-slate-500">
            Contribution score <span className="font-semibold text-slate-700">{ranking.score}</span>
            <span className="text-slate-400"> / 100</span>
          </div>
        </div>
      </div>

      {/* Breakdown table */}
      <div className="overflow-hidden rounded-lg border border-slate-200">
        {/* Inside the card, not around it: the card owns the border and the
            `overflow-hidden` that rounds it. That `overflow-hidden` is a CLIP,
            not a scroll container — five numeric columns in a 390px drawer were
            being cut off with no way to reach them. */}
        <TableScroller>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2 font-medium">Metric</th>
                <th className="px-3 py-2 text-right font-medium">Count</th>
                <th className="px-3 py-2 text-right font-medium">Subscore</th>
                <th className="px-3 py-2 text-right font-medium">Weight</th>
                <th className="px-3 py-2 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody>
              {METRIC_ORDER.map((key) => {
                const m = ranking.metrics[key];
                return (
                  <tr key={key} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 text-slate-700">{RANKING_METRIC_LABELS[key]}</td>
                    <td className="px-3 py-2 text-right font-medium text-slate-800">{m.raw}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{m.normalized}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{formatWeight(m.weight)}</td>
                    <td className="px-3 py-2 text-right font-medium text-slate-800">
                      {m.weightedContribution}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50">
                <td className="px-3 py-2 font-semibold text-slate-700" colSpan={4}>
                  Composite score
                </td>
                <td className="px-3 py-2 text-right font-semibold text-slate-900">{ranking.score}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroller>
      </div>

      <p className="text-xs text-slate-400">
        Each metric is scored 0–100 relative to everyone on this org tree, then weighted. Counts
        cover the last 90 days.
      </p>
    </div>
  );
}
