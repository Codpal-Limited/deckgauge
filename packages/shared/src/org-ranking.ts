import type { EmployeeRankingDto, RankingCounts, RankingTier } from './org-tree-schemas.js';

/**
 * Composite-score weights for the org-tree employee leaderboard. Delivery-weighted:
 * shipped outcomes (tickets closed, PRs merged) count for more than raw activity
 * (commits), and code-review participation still contributes. Weights sum to 1, so
 * the composite score lands on the same 0–100 scale as each normalized metric.
 */
export const RANKING_WEIGHTS = {
  ticketsClosed: 0.35,
  prsMerged: 0.3,
  commitsToMain: 0.2,
  reviewComments: 0.15,
} as const;

export type RankingMetricKey = keyof typeof RANKING_WEIGHTS;

const METRIC_KEYS: RankingMetricKey[] = [
  'ticketsClosed',
  'prsMerged',
  'commitsToMain',
  'reviewComments',
];

export interface RankingInput {
  employeeId: string;
  counts: RankingCounts;
}

/** Round to 2 decimals to keep scores/subscores stable and display-friendly. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Tier for a 1-based rank within a tree of `totalRanked` employees. The top three
 * always earn medals; everyone else is bucketed by percentile (rank / total), with
 * inclusive upper boundaries so exactly-10% lands in `top10` and exactly-25% in `top25`.
 */
export function rankTier(rank: number, totalRanked: number): RankingTier {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  const pct = rank / totalRanked;
  if (pct <= 0.1) return 'top10';
  if (pct <= 0.25) return 'top25';
  return 'rest';
}

/**
 * Rank every employee within an org tree by a weighted composite of their raw
 * contribution counts. Each metric is min-max normalized to 0–100 across the given
 * set (so a metric on which everyone is equal contributes nothing), then weighted by
 * RANKING_WEIGHTS. Ties break deterministically by tickets closed, then PRs merged,
 * then employeeId — so repeated reads of unchanged data produce identical ranks.
 *
 * Returns a map keyed by employeeId. Zero-activity employees are still ranked (they
 * simply fall to the bottom) so `totalRanked` reflects the full comparison set.
 */
export function computeRanking(inputs: RankingInput[]): Map<string, EmployeeRankingDto> {
  const out = new Map<string, EmployeeRankingDto>();
  if (inputs.length === 0) return out;

  // Per-metric min/max across the whole tree.
  const bounds: Record<RankingMetricKey, { min: number; max: number }> = {
    ticketsClosed: { min: Infinity, max: -Infinity },
    prsMerged: { min: Infinity, max: -Infinity },
    commitsToMain: { min: Infinity, max: -Infinity },
    reviewComments: { min: Infinity, max: -Infinity },
  };
  for (const { counts } of inputs) {
    for (const key of METRIC_KEYS) {
      const v = counts[key];
      if (v < bounds[key].min) bounds[key].min = v;
      if (v > bounds[key].max) bounds[key].max = v;
    }
  }

  const normalize = (key: RankingMetricKey, raw: number): number => {
    const { min, max } = bounds[key];
    if (max === min) return 0; // no spread → this metric carries no signal
    return ((raw - min) / (max - min)) * 100;
  };

  const scored = inputs.map(({ employeeId, counts }) => {
    const metrics = {} as EmployeeRankingDto['metrics'];
    let score = 0;
    for (const key of METRIC_KEYS) {
      const raw = counts[key];
      const normalized = normalize(key, raw);
      const weight = RANKING_WEIGHTS[key];
      const weightedContribution = normalized * weight;
      score += weightedContribution;
      metrics[key] = {
        raw,
        normalized: round2(normalized),
        weight,
        weightedContribution: round2(weightedContribution),
      };
    }
    return { employeeId, counts, metrics, score };
  });

  // Deterministic ordering: score desc, then tickets, then PRs, then id asc.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.counts.ticketsClosed !== a.counts.ticketsClosed) {
      return b.counts.ticketsClosed - a.counts.ticketsClosed;
    }
    if (b.counts.prsMerged !== a.counts.prsMerged) {
      return b.counts.prsMerged - a.counts.prsMerged;
    }
    return a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0;
  });

  const totalRanked = scored.length;
  scored.forEach((s, i) => {
    const rank = i + 1;
    out.set(s.employeeId, {
      rank,
      totalRanked,
      score: round2(s.score),
      tier: rankTier(rank, totalRanked),
      metrics: s.metrics,
    });
  });

  return out;
}
