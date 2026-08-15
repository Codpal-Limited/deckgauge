// DORA metrics — the four DORA delivery-performance metrics, each classified
// into an Elite/High/Medium/Low tier. Reuses the BenchmarkConfig + tierFor
// machinery from benchmarks.ts, but keeps its own threshold table because DORA
// sub-metrics are NOT widget types (BENCHMARKS_V1 is keyed by widget type).
//
// Which of these are measured and which are proxied:
//   - Lead Time         : p50 cycle time (first commit → merge) of merged PRs.
//                         Measured.
//   - Deploy Frequency  : successful PRODUCTION deployments per week, from real
//                         deployment records (cockpit.ado_deployments — classic
//                         Release pipelines — and cockpit.github_deployments).
//                         PROXIED as merged PRs per week only when the board's
//                         scope has no deployment source; DoraMetricsResult
//                         reports which via deploySource, and the widget labels
//                         a proxied number.
//   - Change Failure Rate: PROXY — corrective-commit ratio (fix/revert/hotfix
//                          message match), the same signal Rework Rate uses.
//                          Could move to failed-vs-total deployments now that
//                          deployment records carry a status, but has not.
//   - Time to Restore   : PROXY — p50 hours from bug-issue opened → closed;
//                         there is no incident source.
// Thresholds follow the commonly-cited DORA state-of-DevOps bands.
import { type BenchmarkConfig, type Tier, tierFor } from './benchmarks';

export const DORA_BENCHMARKS = {
  lead_time: { direction: 'lower_is_better', elite: 24, high: 168, medium: 720, unit: 'hours' },
  deploy_frequency: {
    direction: 'higher_is_better',
    elite: 7,
    high: 1,
    medium: 0.25,
    unit: 'count',
  },
  change_failure_rate: {
    direction: 'lower_is_better',
    elite: 5,
    high: 10,
    medium: 15,
    unit: 'percent',
  },
  time_to_restore: { direction: 'lower_is_better', elite: 1, high: 24, medium: 168, unit: 'hours' },
} as const satisfies Record<string, BenchmarkConfig>;

export type DoraMetricKey = keyof typeof DORA_BENCHMARKS;

export const DORA_METRIC_LABELS: Record<DoraMetricKey, string> = {
  lead_time: 'Lead Time for Changes',
  deploy_frequency: 'Deployment Frequency',
  change_failure_rate: 'Change Failure Rate',
  time_to_restore: 'Time to Restore',
};

// Ordered for display: the canonical DORA two-by-two (speed, then stability).
const DORA_METRIC_ORDER: DoraMetricKey[] = [
  'lead_time',
  'deploy_frequency',
  'change_failure_rate',
  'time_to_restore',
];

export interface DoraMetric {
  key: DoraMetricKey;
  label: string;
  /** Rounded metric value; null when the source for this metric is absent or empty. */
  value: number | null;
  unit: BenchmarkConfig['unit'];
  /** DORA tier, or null when value is null (nothing to classify). */
  tier: Tier | null;
}

export interface DoraInputs {
  leadTimeHours: number | null;
  deployFreqPerWeek: number | null;
  changeFailureRatePct: number | null;
  timeToRestoreHours: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Classify a single metric value against its DORA band; null passes through. */
export function classifyDora(key: DoraMetricKey, value: number | null): Tier | null {
  if (value == null || !Number.isFinite(value)) return null;
  return tierFor(value, DORA_BENCHMARKS[key]);
}

/**
 * Build the ordered four-metric DORA scorecard from raw computed values. Any
 * metric whose value is null (missing source, empty window) is kept in the
 * scorecard with value/tier null so the UI can render a stable "—" cell.
 */
export function buildDoraScorecard(inputs: DoraInputs): DoraMetric[] {
  const valueByKey: Record<DoraMetricKey, number | null> = {
    lead_time: inputs.leadTimeHours,
    deploy_frequency: inputs.deployFreqPerWeek,
    change_failure_rate: inputs.changeFailureRatePct,
    time_to_restore: inputs.timeToRestoreHours,
  };
  return DORA_METRIC_ORDER.map((key) => {
    const raw = valueByKey[key];
    const value = raw == null || !Number.isFinite(raw) ? null : round1(raw);
    return {
      key,
      label: DORA_METRIC_LABELS[key],
      value,
      unit: DORA_BENCHMARKS[key].unit,
      tier: classifyDora(key, value),
    };
  });
}
