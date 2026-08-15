import {
  pullRequestsUnion,
  commitsUnion,
  issuesUnion,
  deploymentsUnion,
} from '../../widgets/unions.js';
import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { formatDateTime, resolveWeeks } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';

const DEFAULT_WEEKS = 12;

// Bulk-close guard (days) for Time to Restore: a bug whose created→closed span
// exceeds this is dropped from the median so a mass historical close cannot skew
// it. Matches issue-cycle.ts's ISSUE_CYCLE_MAX_AGE_DAYS.
const TTR_MAX_AGE_DAYS = 90;

// Corrective-commit signal, reused verbatim from rework-rate.ts so Change
// Failure Rate and Rework Rate stay consistent. Token bounded by [^a-z] (not a
// regex word boundary) so 'fix' doesn't match inside 'prefix'/'fixture'.
const CORRECTIVE_RE =
  '(^|[^a-z])(revert|rollback|hotfix|bugfix|fixup|fix|fixes|fixed|regression)([^a-z]|$)';

// DORA scorecard, single round-trip. Each metric column is computed by a
// subquery over the union it needs, and falls back to NULL when that source is
// absent — so a Jira-only board still gets Time-to-Restore, a GitHub-only board
// still gets the speed + change-failure metrics, etc. Returns null only when the
// board has NO source at all.
//
// Deploy Frequency prefers REAL deployment records (cockpit.ado_deployments from
// classic Release pipelines, cockpit.github_deployments) and falls back to the
// merged-PR proxy otherwise. BOTH counts are computed here and the choice is made
// in the service, because "has a deployment source" is not the same as "that
// source yields production deploys":
//
//   - the production test is a heuristic on the stage NAME (see
//     isProductionStage), and plenty of real pipelines don't cooperate. The
//     Auxiliary project only ever deploys to DEV/UAT/PPE; Internal Development
//     has 3,391 successful deploys all named ADO's default "Stage 1".
//   - a board fed only by those projects has a deployment source but zero
//     production deploys, and reporting 0/wk as an OBSERVED number is worse than
//     the proxy it replaced.
//
// So the service falls back to the proxy whenever the real count is zero, and
// reports which one it used via `deploy_source` so the widget can label a proxied
// number instead of passing it off as observed.
//
// Still PROXIES (no incident source exists):
//   lead_time_hours    = p50 cycle time of merged PRs
//   corrective/total   = corrective-commit ratio → Change Failure Rate
//   ttr_hours          = p50 hours a bug-issue was open → closed. issuesUnion
//                        coalesces Jira closed_at with the first done transition
//                        (resolved_at is unreliable), so this works for status-
//                        close workflows too — see unions.ts.
export function buildDoraMetricsSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const prs = pullRequestsUnion(scope);
  const commits = commitsUnion(scope);
  const issues = issuesUnion(scope);
  const deployments = deploymentsUnion(scope);
  if (prs.sql === null && commits.sql === null && issues.sql === null) return null;

  const weeks = resolveWeeks((config as { weeks?: unknown }).weeks, DEFAULT_WEEKS);
  const { from, to } = resolvePeriod(config, Date.now, weeks * 7);

  const leadTimeCol = prs.sql
    ? `(SELECT quantile(0.5)(cycle_time_hours) FROM (${prs.sql})
         WHERE merged_at IS NOT NULL AND merged_at >= {from:DateTime} AND merged_at < {to:DateTime}
           AND cycle_time_hours IS NOT NULL AND state = 'merged')`
    : `CAST(NULL AS Nullable(Float64))`;

  // Real deploys: SUCCESSFUL and PRODUCTION only. A failed deploy did not ship,
  // and counting every pre-production stage of a multi-stage pipeline would
  // inflate the rate several-fold (a real org's pipelines run UAT / Sandbox /
  // QA / Development / Production — only 1 stage in 5 ships).
  // uniqExact(release_key), NOT count(): one logical release fans out to one row
  // per stage, so counting rows inflated the rate 2-4x on multi-stage pipelines.
  // A release that reached production counts once.
  const deploysRealCol = deployments.sql
    ? `(SELECT uniqExact(release_key) FROM (${deployments.sql})
         WHERE deployed_at IS NOT NULL AND deployed_at >= {from:DateTime} AND deployed_at < {to:DateTime}
           AND is_success AND is_production)`
    : `CAST(NULL AS Nullable(UInt64))`;

  // Merged-PR proxy, kept as the fallback for boards whose deployment records
  // carry no recognisable production stage.
  const deploysProxyCol = prs.sql
    ? `(SELECT count() FROM (${prs.sql})
         WHERE merged_at IS NOT NULL AND merged_at >= {from:DateTime} AND merged_at < {to:DateTime}
           AND state = 'merged')`
    : `CAST(NULL AS Nullable(UInt64))`;

  const correctiveCol = commits.sql
    ? `(SELECT countIf(match(lowerUTF8(message), '${CORRECTIVE_RE}')) FROM (${commits.sql})
         WHERE is_merge_commit = 0 AND committed_at >= {from:DateTime} AND committed_at < {to:DateTime})`
    : `CAST(NULL AS Nullable(UInt64))`;

  const totalCommitsCol = commits.sql
    ? `(SELECT count() FROM (${commits.sql})
         WHERE is_merge_commit = 0 AND committed_at >= {from:DateTime} AND committed_at < {to:DateTime})`
    : `CAST(NULL AS Nullable(UInt64))`;

  // Change Failure Rate, measured rather than proxied.
  //
  // ado_deployments carries ADO's real deploymentStatus, so a production release
  // that did not succeed is observable — the corrective-commit ratio below only
  // ever existed because no failure source did. Denominator counts DISTINCT
  // releases for the same reason deploys_real does: one logical release fans out
  // to a row per stage, and counting rows would disagree with how the deploy
  // frequency beside it is counted.
  //
  // A release with both a failed and a later successful production deployment
  // counts as failed. DORA asks whether a change caused a failure in production,
  // and a retry means it did — so the retry is not allowed to erase it.
  const failedReleasesCol = deployments.sql
    ? `(SELECT uniqExact(release_key) FROM (${deployments.sql})
         WHERE deployed_at IS NOT NULL AND deployed_at >= {from:DateTime} AND deployed_at < {to:DateTime}
           AND is_production AND NOT is_success)`
    : `CAST(NULL AS Nullable(UInt64))`;

  const totalReleasesCol = deployments.sql
    ? `(SELECT uniqExact(release_key) FROM (${deployments.sql})
         WHERE deployed_at IS NOT NULL AND deployed_at >= {from:DateTime} AND deployed_at < {to:DateTime}
           AND is_production)`
    : `CAST(NULL AS Nullable(UInt64))`;

  // Time to Restore: median hours a bug was open → closed, over the issue union
  // (whose Jira leg now coalesces closed_at with the first done transition).
  // Guarded against bulk-close outliers.
  const ttrCol = issues.sql
    ? `(SELECT quantile(0.5)(if(
           dateDiff('hour', created_at, closed_at) BETWEEN 0 AND ${TTR_MAX_AGE_DAYS} * 24,
           dateDiff('hour', created_at, closed_at),
           NULL))
         FROM (${issues.sql})
         WHERE closed_at IS NOT NULL AND closed_at >= {from:DateTime} AND closed_at < {to:DateTime}
           AND match(lowerUTF8(type), '(bug|defect|incident|hotfix)'))`
    : `CAST(NULL AS Nullable(Float64))`;

  return {
    sql: `SELECT
        ${leadTimeCol}      AS lead_time_hours,
        ${deploysRealCol}   AS deploys_real,
        ${deploysProxyCol}  AS deploys_proxy,
        ${correctiveCol}    AS corrective_commits,
        ${totalCommitsCol}  AS total_commits,
        ${ttrCol}           AS ttr_hours,
        ${failedReleasesCol} AS failed_releases,
        ${totalReleasesCol} AS total_releases`,
    // Union params share identical keys+values (same scope arrays), so merging
    // is safe — e.g. {ghRepos} appears in the PR, commit and issue subqueries.
    params: {
      ...prs.params,
      ...commits.params,
      ...issues.params,
      ...deployments.params,
      from: formatDateTime(from),
      to: formatDateTime(to),
    },
  };
}

registerBuilder('DORA_METRICS', buildDoraMetricsSql);
