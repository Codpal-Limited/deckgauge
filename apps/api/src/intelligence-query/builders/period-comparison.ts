import { pullRequestsUnion, commitsUnion, issuesUnion } from '../../widgets/unions.js';
import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { formatDateTime } from '../../widgets/widget-helpers.js';
import { resolveComparePeriods } from './period.js';
import { buildIssueDoneItemsSql, issueCycleMedianHoursSql } from './issue-cycle.js';

// Corrective-commit signal — identical to dora-metrics.ts / rework-rate.ts so
// Change Failure Rate stays consistent across widgets.
const CORRECTIVE_RE =
  '(^|[^a-z])(revert|rollback|hotfix|bugfix|fixup|fix|fixes|fixed|regression)([^a-z]|$)';

// Bulk-close guard for issue cycle time (created→done): items whose span
// exceeds this are dropped from the median so a mass historical import close
// cannot skew it. Matches flow-throughput-cycle.ts's DEFAULT_MAX_AGE_DAYS.
const ISSUE_CYCLE_MAX_AGE_DAYS = 90;

// Same bulk-close guard for Time to Restore (created→closed span). Kept as its
// own name so the two metrics can diverge later without confusion.
const TTR_MAX_AGE_DAYS = 90;

// Period-over-Period scorecard, single round-trip. Each metric is computed
// twice — once per window — as a scalar subquery over the union it needs, with
// a NULL fallback when that source is absent (mirrors dora-metrics.ts). Returns
// null only when the board has NO source at all.
export function buildPeriodComparisonSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const prs = pullRequestsUnion(scope);
  const commits = commitsUnion(scope);
  const issues = issuesUnion(scope);
  if (prs.sql === null && commits.sql === null && issues.sql === null) return null;

  const { a, b } = resolveComparePeriods(config, Date.now);

  // Per-window column builders. `fromKey`/`toKey` are the DateTime param names.
  const cycle = (fromKey: string, toKey: string) =>
    prs.sql
      ? `(SELECT quantile(0.5)(cycle_time_hours) FROM (${prs.sql})
           WHERE merged_at IS NOT NULL AND merged_at >= {${fromKey}:DateTime} AND merged_at < {${toKey}:DateTime}
             AND cycle_time_hours IS NOT NULL AND state = 'merged')`
      : `CAST(NULL AS Nullable(Float64))`;

  // Issue cycle time (work-item created→done, in hours). Complements the
  // PR-based `cycle` above for teams whose PR window collapses to ~0.
  const issueCycleA = issueCycleMedianHoursSql(scope, 'fromA', 'toA');
  const issueCycleB = issueCycleMedianHoursSql(scope, 'fromB', 'toB');

  const deploys = (fromKey: string, toKey: string) =>
    prs.sql
      ? `(SELECT count() FROM (${prs.sql})
           WHERE merged_at IS NOT NULL AND merged_at >= {${fromKey}:DateTime} AND merged_at < {${toKey}:DateTime}
             AND state = 'merged')`
      : `CAST(NULL AS Nullable(UInt64))`;

  const corrective = (fromKey: string, toKey: string) =>
    commits.sql
      ? `(SELECT countIf(match(lowerUTF8(message), '${CORRECTIVE_RE}')) FROM (${commits.sql})
           WHERE is_merge_commit = 0 AND committed_at >= {${fromKey}:DateTime} AND committed_at < {${toKey}:DateTime})`
      : `CAST(NULL AS Nullable(UInt64))`;

  const totalCommits = (fromKey: string, toKey: string) =>
    commits.sql
      ? `(SELECT count() FROM (${commits.sql})
           WHERE is_merge_commit = 0 AND committed_at >= {${fromKey}:DateTime} AND committed_at < {${toKey}:DateTime})`
      : `CAST(NULL AS Nullable(UInt64))`;

  // Time to Restore: median hours a bug was open → closed, over the issue union
  // (whose Jira leg now coalesces closed_at with the first done transition).
  // Guarded against bulk-close outliers.
  const ttr = (fromKey: string, toKey: string) =>
    issues.sql
      ? `(SELECT quantile(0.5)(if(
             dateDiff('hour', created_at, closed_at) BETWEEN 0 AND ${TTR_MAX_AGE_DAYS} * 24,
             dateDiff('hour', created_at, closed_at),
             NULL))
           FROM (${issues.sql})
           WHERE closed_at IS NOT NULL AND closed_at >= {${fromKey}:DateTime} AND closed_at < {${toKey}:DateTime}
             AND match(lowerUTF8(type), '(bug|defect|incident|hotfix)'))`
      : `CAST(NULL AS Nullable(Float64))`;

  const throughput = (fromKey: string, toKey: string) =>
    issues.sql
      ? `(SELECT count() FROM (${issues.sql})
           WHERE closed_at IS NOT NULL AND closed_at >= {${fromKey}:DateTime} AND closed_at < {${toKey}:DateTime})`
      : `CAST(NULL AS Nullable(UInt64))`;

  return {
    sql: `SELECT
        ${cycle('fromA', 'toA')}         AS cycle_a,
        ${cycle('fromB', 'toB')}         AS cycle_b,
        ${issueCycleA.sql}               AS issue_cycle_a,
        ${issueCycleB.sql}               AS issue_cycle_b,
        ${deploys('fromA', 'toA')}       AS deploys_a,
        ${deploys('fromB', 'toB')}       AS deploys_b,
        ${corrective('fromA', 'toA')}    AS corrective_a,
        ${totalCommits('fromA', 'toA')}  AS total_a,
        ${corrective('fromB', 'toB')}    AS corrective_b,
        ${totalCommits('fromB', 'toB')}  AS total_b,
        ${ttr('fromA', 'toA')}           AS ttr_a,
        ${ttr('fromB', 'toB')}           AS ttr_b,
        ${throughput('fromA', 'toA')}    AS throughput_a,
        ${throughput('fromB', 'toB')}    AS throughput_b`,
    params: {
      ...prs.params,
      ...commits.params,
      ...issues.params,
      // issueCycleA/B share identical scope params (same keys+values); merging
      // one set is sufficient. icMaxAgeDays feeds the bulk-close guard.
      ...issueCycleA.params,
      icMaxAgeDays: ISSUE_CYCLE_MAX_AGE_DAYS,
      fromA: formatDateTime(a.from),
      toA: formatDateTime(a.to),
      fromB: formatDateTime(b.from),
      toB: formatDateTime(b.to),
    },
  };
}

registerBuilder('PERIOD_COMPARISON', buildPeriodComparisonSql);

// Long-format monthly trajectory for the drill-down. One SELECT per metric,
// UNION ALL'd, each grouped by month over the full span [periodA.from, periodB.to].
// Not registered — the service imports and calls it directly (it is not a
// dispatchable widget type of its own).
export function buildPeriodComparisonTrendSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const prs = pullRequestsUnion(scope);
  const commits = commitsUnion(scope);
  const issues = issuesUnion(scope);
  if (prs.sql === null && commits.sql === null && issues.sql === null) return null;

  const { a, b } = resolveComparePeriods(config, Date.now);

  const legs: string[] = [];
  if (prs.sql) {
    legs.push(`SELECT 'cycle_time' AS metric, toString(toStartOfMonth(merged_at)) AS month,
        quantile(0.5)(cycle_time_hours) AS value
      FROM (${prs.sql})
      WHERE state = 'merged' AND merged_at >= {trendFrom:DateTime} AND merged_at < {trendTo:DateTime}
        AND cycle_time_hours IS NOT NULL
      GROUP BY month`);
    // Raw monthly counts would penalize the partial first/last month buckets
    // (the ~180-day span rarely aligns to calendar-month boundaries), which
    // reads as a spurious drop to gradeTrajectory. Normalize to a per-week
    // rate using only the days of each bucket that fall inside [trendFrom,
    // trendTo), so a partial month is compared on equal footing with a full
    // one. This also matches the scorecard's per-week deploy frequency.
    legs.push(`SELECT 'deploy_frequency' AS metric, toString(bucket) AS month,
        toFloat64(cnt) / greatest(dateDiff('day', greatest(bucket, {trendFrom:DateTime}), least(bucket + INTERVAL 1 MONTH, {trendTo:DateTime})), 1) * 7 AS value
      FROM (
        SELECT toDateTime(toStartOfMonth(merged_at)) AS bucket, count() AS cnt
        FROM (${prs.sql})
        WHERE state = 'merged' AND merged_at >= {trendFrom:DateTime} AND merged_at < {trendTo:DateTime}
        GROUP BY bucket
      )`);
  }
  const issueItems = buildIssueDoneItemsSql(scope, 'trendFrom', 'trendTo');
  if (issueItems.sql) {
    // Median created→done span (hours) per month, same bulk-close guard as the
    // scorecard. Scale-invariant like the cycle_time leg — no per-week rate.
    legs.push(`SELECT 'issue_cycle_time' AS metric, toString(toStartOfMonth(done_at)) AS month,
        quantile(0.5)(if(
          dateDiff('hour', created_at, done_at) BETWEEN 0 AND {icMaxAgeDays:UInt32} * 24,
          dateDiff('hour', created_at, done_at),
          NULL))                                          AS value
      FROM (${issueItems.sql})
      GROUP BY month`);
  }

  if (commits.sql) {
    legs.push(`SELECT 'change_failure_rate' AS metric, toString(toStartOfMonth(committed_at)) AS month,
        100 * countIf(match(lowerUTF8(message), '${CORRECTIVE_RE}')) / nullIf(count(), 0) AS value
      FROM (${commits.sql})
      WHERE is_merge_commit = 0 AND committed_at >= {trendFrom:DateTime} AND committed_at < {trendTo:DateTime}
      GROUP BY month`);
  }
  if (issues.sql) {
    // Same partial-bucket normalization as deploy_frequency above — see comment there.
    legs.push(`SELECT 'throughput' AS metric, toString(bucket) AS month,
        toFloat64(cnt) / greatest(dateDiff('day', greatest(bucket, {trendFrom:DateTime}), least(bucket + INTERVAL 1 MONTH, {trendTo:DateTime})), 1) * 7 AS value
      FROM (
        SELECT toDateTime(toStartOfMonth(closed_at)) AS bucket, count() AS cnt
        FROM (${issues.sql})
        WHERE closed_at IS NOT NULL AND closed_at >= {trendFrom:DateTime} AND closed_at < {trendTo:DateTime}
        GROUP BY bucket
      )`);
    // Time to Restore: median created→closed (hours) per month for bug items,
    // same bulk-close guard as the scorecard. Scale-invariant (median) — no
    // per-week rate. Jira closed_at is coalesced with the first done transition
    // inside issuesUnion (resolved_at is unreliable) — see unions.ts.
    legs.push(`SELECT 'time_to_restore' AS metric, toString(toStartOfMonth(closed_at)) AS month,
        quantile(0.5)(if(
          dateDiff('hour', created_at, closed_at) BETWEEN 0 AND ${TTR_MAX_AGE_DAYS} * 24,
          dateDiff('hour', created_at, closed_at),
          NULL))                                          AS value
      FROM (${issues.sql})
      WHERE closed_at IS NOT NULL AND closed_at >= {trendFrom:DateTime} AND closed_at < {trendTo:DateTime}
        AND match(lowerUTF8(type), '(bug|defect|incident|hotfix)')
      GROUP BY month`);
  }

  return {
    sql: `${legs.join('\nUNION ALL\n')}\nORDER BY metric ASC, month ASC`,
    params: {
      ...prs.params,
      ...commits.params,
      ...issues.params,
      ...issueItems.params,
      icMaxAgeDays: ISSUE_CYCLE_MAX_AGE_DAYS,
      trendFrom: formatDateTime(a.from),
      trendTo: formatDateTime(b.to),
    },
  };
}
