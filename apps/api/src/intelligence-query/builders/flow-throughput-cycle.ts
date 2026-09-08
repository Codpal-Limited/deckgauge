import { DONE_STATUS_NAMES } from '@deckgauge/shared';
import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { chNormalizedStatusExpr, formatDateTime, resolveWeeks } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';
import { jiraScopeFilter, adoScopeFilter } from '../../widgets/unions.js';

const DEFAULT_WEEKS = 12;
const DEFAULT_MAX_AGE_DAYS = 90;

// "Scissors" widget: bars = items delivered/period, line = median cycle time.
//
// Done-date source per the plan: Jira resolved_at is frequently NULL, so the
// Jira leg uses jira_transitions (first done transition per issue) INNER JOINed
// to jira_issues FINAL for created_at — mirroring ch-completion-trend.ts's
// done-date source. Done-ness is matched on the status *name* (to_status IN
// DONE_STATUS_NAMES), NOT to_category: the Jira changelog carries no category,
// so jira_transitions.to_category is always 'Unknown' (see status-rules.ts).
// ADO has no such gap: closed_at on ado_work_items directly reflects the done
// transition.
//
// Bulk-close guard (ref: Acme "345-day June" cleanup): items whose
// created→done span exceeds {maxAgeDays} are excluded from the cycle-time
// median and flag their period instead, so a mass historical-import close
// doesn't blow out the median or silently understate cycle time.
export function buildFlowThroughputCycleSql({ config, scope }: BuilderInputs): BuiltSql | null {
  if (scope.jiraProjectKeys.length === 0 && scope.adoProjects.length === 0) return null;

  const weeks = resolveWeeks((config as { weeks?: unknown }).weeks, DEFAULT_WEEKS);
  const { from, to } = resolvePeriod(config, Date.now, weeks * 7);
  const maxAgeDaysRaw = (config as { maxAgeDays?: unknown }).maxAgeDays;
  const maxAgeDays =
    typeof maxAgeDaysRaw === 'number' && maxAgeDaysRaw > 0 ? maxAgeDaysRaw : DEFAULT_MAX_AGE_DAYS;

  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.jiraProjectKeys.length) {
    legs.push(`
      SELECT
        i.created_at                                       AS created_at,
        jt.done_at                                          AS done_at
      FROM (
        SELECT
          issue_key                                         AS issue_key,
          min(transitioned_at)                              AS done_at
        FROM cockpit.jira_transitions
        WHERE ${jiraScopeFilter(scope, params, { keyColumn: 'issue_key' })}
          AND ${chNormalizedStatusExpr('to_status')} IN {doneStatuses:Array(String)}
          AND transitioned_at >= {from:DateTime}
          AND transitioned_at <  {to:DateTime}
        GROUP BY issue_key
      ) AS jt
      INNER JOIN cockpit.jira_issues AS i FINAL
        ON i.key = jt.issue_key
      WHERE ${jiraScopeFilter(scope, params, { alias: 'i' })}
    `);
    params.doneStatuses = [...DONE_STATUS_NAMES];
  }

  if (scope.adoProjects.length) {
    legs.push(`
      SELECT
        created_at                                          AS created_at,
        closed_at                                            AS done_at
      FROM cockpit.ado_work_items FINAL
      WHERE ${adoScopeFilter(scope, params, { areaPathColumn: 'area_path' })}
        AND closed_at IS NOT NULL
        AND closed_at >= {from:DateTime}
        AND closed_at <  {to:DateTime}
    `);
  }

  const sql = `
    WITH done_items AS (
      ${legs.join(' UNION ALL ')}
    ),
    aged AS (
      SELECT
        toMonday(done_at)                                   AS period,
        dateDiff('day', created_at, done_at)                AS cd
      FROM done_items
    )
    SELECT
      toString(period)                                                     AS period,
      toUInt64(count())                                                    AS delivered,
      quantile(0.5)(if(cd BETWEEN 0 AND {maxAgeDays:UInt32}, cd, NULL))
                                                                            AS cycle_days,
      toUInt64(countIf(cd BETWEEN 0 AND {maxAgeDays:UInt32}))              AS sample,
      countIf(cd > {maxAgeDays:UInt32}) > 0                                AS flagged
    FROM aged
    GROUP BY period
    ORDER BY period ASC
  `;

  return {
    sql,
    params: {
      ...params,
      from: formatDateTime(from),
      to: formatDateTime(to),
      maxAgeDays,
    },
  };
}

registerBuilder('FLOW_THROUGHPUT_CYCLE', buildFlowThroughputCycleSql);
