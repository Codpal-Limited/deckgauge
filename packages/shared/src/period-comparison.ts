// Period-over-Period metric deltas. Metric definitions are the SAME proxies as
// dora.ts, so the two widgets can never disagree. Direction decides whether a
// numeric increase is an improvement or a regression.

export type PeriodMetricKey =
  | 'cycle_time'
  | 'issue_cycle_time'
  | 'deploy_frequency'
  | 'change_failure_rate'
  | 'time_to_restore'
  | 'throughput';

export type MetricDirection = 'higher_is_better' | 'lower_is_better';
export type DeltaVerdict = 'improved' | 'regressed' | 'flat' | 'na';

export interface PeriodDelta {
  /** now - past, or null when either side is null. */
  absolute: number | null;
  /** Rounded percent change vs. past, or null when past is null/zero. */
  pct: number | null;
  verdict: DeltaVerdict;
}

export interface PeriodComparisonMetric {
  key: PeriodMetricKey;
  label: string;
  unit: 'hours' | 'percent' | 'count';
  direction: MetricDirection;
  past: number | null;
  now: number | null;
  delta: PeriodDelta;
}

interface MetricDef {
  key: PeriodMetricKey;
  label: string;
  unit: 'hours' | 'percent' | 'count';
  direction: MetricDirection;
}

// Canonical display order: speed, then stability, then output.
const METRIC_DEFS: MetricDef[] = [
  { key: 'cycle_time', label: 'Cycle Time', unit: 'hours', direction: 'lower_is_better' },
  { key: 'issue_cycle_time', label: 'Issue Cycle Time', unit: 'hours', direction: 'lower_is_better' },
  { key: 'deploy_frequency', label: 'Deployment Frequency', unit: 'count', direction: 'higher_is_better' },
  { key: 'change_failure_rate', label: 'Change Failure Rate', unit: 'percent', direction: 'lower_is_better' },
  { key: 'time_to_restore', label: 'Time to Restore', unit: 'hours', direction: 'lower_is_better' },
  { key: 'throughput', label: 'Throughput', unit: 'count', direction: 'higher_is_better' },
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeDelta(
  direction: MetricDirection,
  past: number | null,
  now: number | null,
): PeriodDelta {
  if (past == null || now == null || !Number.isFinite(past) || !Number.isFinite(now)) {
    return { absolute: null, pct: null, verdict: 'na' };
  }
  const absolute = round1(now - past);
  const pct = past === 0 ? null : Math.round(((now - past) / Math.abs(past)) * 100);
  if (absolute === 0) return { absolute, pct, verdict: 'flat' };
  const increased = now > past;
  const improved = direction === 'higher_is_better' ? increased : !increased;
  return { absolute, pct, verdict: improved ? 'improved' : 'regressed' };
}

export interface PeriodComparisonInputs {
  cycleTimeHours: { a: number | null; b: number | null };
  issueCycleHours: { a: number | null; b: number | null };
  deployFreqPerWeek: { a: number | null; b: number | null };
  changeFailureRatePct: { a: number | null; b: number | null };
  timeToRestoreHours: { a: number | null; b: number | null };
  throughput: { a: number | null; b: number | null };
}

export function buildPeriodComparison(inputs: PeriodComparisonInputs): PeriodComparisonMetric[] {
  const sideByKey: Record<PeriodMetricKey, { a: number | null; b: number | null }> = {
    cycle_time: inputs.cycleTimeHours,
    issue_cycle_time: inputs.issueCycleHours,
    deploy_frequency: inputs.deployFreqPerWeek,
    change_failure_rate: inputs.changeFailureRatePct,
    time_to_restore: inputs.timeToRestoreHours,
    throughput: inputs.throughput,
  };
  return METRIC_DEFS.map((def) => {
    const { a, b } = sideByKey[def.key];
    const past = a == null || !Number.isFinite(a) ? null : round1(a);
    const now = b == null || !Number.isFinite(b) ? null : round1(b);
    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      direction: def.direction,
      past,
      now,
      delta: computeDelta(def.direction, past, now),
    };
  });
}
