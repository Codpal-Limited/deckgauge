import { DONE_STATUS_NAMES } from '@deckgauge/shared';
import { chNormalizedStatusExpr } from '../../widgets/widget-helpers.js';
import { jiraScopeFilter, adoScopeFilter } from '../../widgets/unions.js';
import type { BoardScope } from '../../intelligence/board-scope.js';

// Issue-based cycle time — the created→done span of a work item, in contrast to
// the PR-based cycle time (PR-open→merge) the other metrics use. For teams that
// do the work on a branch and open+complete the PR in minutes (common on ADO),
// the PR window collapses to ~0 while the work-item span is the meaningful
// number.
//
// Done-date resolution mirrors flow-throughput-cycle.ts's logic (keep the two in
// sync — edit both together):
//   Jira — resolved_at is frequently NULL, so use the first "done" transition
//          (matched on status *name*; the changelog carries no category), joined
//          to jira_issues for created_at.
//   ADO  — closed_at on ado_work_items directly reflects the done transition.
// GitHub/GitLab issues have no reliable "in progress → done" signal here and are
// intentionally excluded.
//
// Unlike flow-throughput-cycle.ts these reads omit the ClickHouse `FINAL`
// modifier: (1) it matches issuesUnion, which this same PERIOD_COMPARISON builder
// already uses to read jira_issues / ado_work_items for its throughput and
// time-to-restore legs (so the whole widget accepts the same bounded
// ReplacingMergeTree-duplicate tradeoff), and (2) `FINAL` is unparseable by the
// SQL-console round-trip parser (parser.test.ts), so keeping it out avoids a
// regression there.
//
// The window param keys are injected by the caller so one scope can be queried
// over multiple windows (period-over-period) from a single param set. Returns a
// SELECT yielding (created_at, done_at) rows, or null when the board has no
// issue source of a supported kind.
export function buildIssueDoneItemsSql(
  scope: BoardScope,
  fromKey: string,
  toKey: string,
): { sql: string | null; params: Record<string, unknown> } {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.jiraProjectKeys.length) {
    legs.push(`
      SELECT i.created_at AS created_at, jt.done_at AS done_at
      FROM (
        SELECT issue_key AS issue_key, min(transitioned_at) AS done_at
        FROM cockpit.jira_transitions
        WHERE ${jiraScopeFilter(scope, params, { keyColumn: 'issue_key' })}
          AND ${chNormalizedStatusExpr('to_status')} IN {icDoneStatuses:Array(String)}
          AND transitioned_at >= {${fromKey}:DateTime}
          AND transitioned_at <  {${toKey}:DateTime}
        GROUP BY issue_key
      ) AS jt
      INNER JOIN cockpit.jira_issues AS i ON i.key = jt.issue_key
      WHERE ${jiraScopeFilter(scope, params, { alias: 'i' })}
    `);
    params.icDoneStatuses = [...DONE_STATUS_NAMES];
  }

  if (scope.adoProjects.length) {
    legs.push(`
      SELECT created_at AS created_at, closed_at AS done_at
      FROM cockpit.ado_work_items
      WHERE ${adoScopeFilter(scope, params, { areaPathColumn: 'area_path' })}
        AND closed_at IS NOT NULL
        AND closed_at >= {${fromKey}:DateTime}
        AND closed_at <  {${toKey}:DateTime}
    `);
  }

  return { sql: legs.length ? legs.join(' UNION ALL ') : null, params };
}

// Median created→done span in HOURS over the done-items subquery, guarded so a
// mass historical close (created→done > maxAgeDays) cannot blow out the median.
// Stored in hours to stay consistent with the other duration metrics (the UI
// renders large hour values as days). Returns a NULL cast when no issue source
// is present so the column still exists in the row shape.
export function issueCycleMedianHoursSql(
  scope: BoardScope,
  fromKey: string,
  toKey: string,
): { sql: string; params: Record<string, unknown> } {
  const items = buildIssueDoneItemsSql(scope, fromKey, toKey);
  if (!items.sql) return { sql: `CAST(NULL AS Nullable(Float64))`, params: {} };
  return {
    sql: `(SELECT quantile(0.5)(if(
             dateDiff('hour', created_at, done_at) BETWEEN 0 AND {icMaxAgeDays:UInt32} * 24,
             dateDiff('hour', created_at, done_at),
             NULL))
           FROM (${items.sql}))`,
    params: items.params,
  };
}
