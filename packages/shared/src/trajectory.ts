// Grades a metric's trajectory over a series of period buckets. The grade
// combines the whole-path direction (first vs last) with the recent move (last
// ~3 buckets). The interesting case is "stalling": improved overall but the
// recent buckets are reversing — a plain two-point diff misses this.
import type { MetricDirection } from './period-comparison';

export type TrajectoryGrade = 'improving' | 'regressing' | 'flat' | 'stalling' | 'recovering';

export interface TrajectoryVerdict {
  grade: TrajectoryGrade;
  overallPct: number | null;
  recentPct: number | null;
}

// Chosen so that a single-bucket bounce inside a genuinely flat series (e.g.
// the last-3-window swing in a choppy-but-net-flat metric) still reads as
// "flat" rather than tipping into regressing/recovering on noise.
const FLAT_THRESHOLD_PCT = 8;

function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function gradeTrajectory(
  direction: MetricDirection,
  series: number[],
): TrajectoryVerdict {
  const s = series.filter((n) => Number.isFinite(n));
  if (s.length < 2) return { grade: 'flat', overallPct: null, recentPct: null };

  const first = s[0]!;
  const last = s[s.length - 1]!;
  const recentRef = s[Math.max(0, s.length - 4)]!;
  const overallPct = pctChange(first, last);
  const recentPct = pctChange(recentRef, last);

  const isBetter = (from: number, to: number) =>
    direction === 'higher_is_better' ? to > from : to < from;

  const overallBetter = isBetter(first, last);
  const recentBetter = isBetter(recentRef, last);
  const overallSmall = overallPct == null || Math.abs(overallPct) < FLAT_THRESHOLD_PCT;
  const recentSmall = recentPct == null || Math.abs(recentPct) < FLAT_THRESHOLD_PCT;

  if (overallSmall && recentSmall) return { grade: 'flat', overallPct, recentPct };
  if (overallBetter && recentBetter) return { grade: 'improving', overallPct, recentPct };
  if (!overallBetter && !recentBetter) return { grade: 'regressing', overallPct, recentPct };
  if (overallBetter && !recentBetter) return { grade: 'stalling', overallPct, recentPct };
  return { grade: 'recovering', overallPct, recentPct };
}
