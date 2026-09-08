import { DONE_STATUS_NAMES } from '@deckgauge/shared';
import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { chNormalizedStatusExpr, formatDateTime, resolveWeeks } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';
import { jiraScopeFilter, adoScopeFilter } from '../../widgets/unions.js';

const DEFAULT_WEEKS = 12;

// Items-delivered-per-period for one board, Jira + ADO only. The service pairs
// the returned trend with calendar overlays (freezes/migrations) afterward.
// GitHub/GitLab are intentionally excluded — they have no issue done-date
// semantics — so a GitHub-/GitLab-only scope short-circuits to null and the
// caller surfaces emptyReason='no_issue_source'.
//
// Done-date source matches flow-throughput-cycle (one definition of
// "delivered"):
//   Jira — the first jira_transitions row per issue whose to_status is a
//          DONE_STATUS_NAMES name. NOT jira_issues.resolved_at (frequently
//          NULL — e.g. 6 of 1102 issues on some projects, which silently
//          under-counted delivery) and NOT to_category (always 'Unknown' — see
//          packages/shared status-rules.ts).
//   ADO  — ado_work_items.closed_at, which directly reflects the done transition.
export function buildDeliveryTrendAnnotatedSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const hasJira = scope.jiraProjectKeys.length > 0;
  const hasAdo = scope.adoProjects.length > 0;
  if (!hasJira && !hasAdo) return null;

  const weeks = resolveWeeks((config as { weeks?: unknown }).weeks, DEFAULT_WEEKS);
  const { from, to } = resolvePeriod(config, Date.now, weeks * 7);

  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (hasJira) {
    legs.push(`
      SELECT toMonday(done_at) AS period
      FROM (
        SELECT
          issue_key            AS issue_key,
          min(transitioned_at) AS done_at
        FROM cockpit.jira_transitions
        WHERE ${jiraScopeFilter(scope, params, { keyColumn: 'issue_key' })}
          AND ${chNormalizedStatusExpr('to_status')} IN {doneStatuses:Array(String)}
          AND transitioned_at >= {from:DateTime}
          AND transitioned_at <  {to:DateTime}
        GROUP BY issue_key
      )
    `);
    params.doneStatuses = [...DONE_STATUS_NAMES];
  }

  if (hasAdo) {
    legs.push(`
      SELECT toMonday(closed_at) AS period
      FROM cockpit.ado_work_items FINAL
      WHERE ${adoScopeFilter(scope, params, { areaPathColumn: 'area_path' })}
        AND closed_at IS NOT NULL
        AND closed_at >= {from:DateTime}
        AND closed_at <  {to:DateTime}
    `);
  }

  return {
    sql: `
      WITH delivered AS (
        ${legs.join(' UNION ALL ')}
      )
      SELECT
        toString(period)  AS period,
        toUInt64(count()) AS delivered,
        toUInt64(count()) AS sample
      FROM delivered
      GROUP BY period
      ORDER BY period ASC
    `,
    params: { ...params, from: formatDateTime(from), to: formatDateTime(to) },
  };
}

registerBuilder('DELIVERY_TREND_ANNOTATED', buildDeliveryTrendAnnotatedSql);
