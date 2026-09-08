import { DONE_STATUS_NAMES } from '@deckgauge/shared';
import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { chNormalizedStatusExpr, formatDateTime, resolveDays } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';
import { jiraScopeFilter } from '../../widgets/unions.js';

const DEFAULT_DAYS = 30;

// Completions-per-day from jira_transitions. Done-ness is matched on the status
// *name* (to_status IN DONE_STATUS_NAMES), NOT to_category: the Jira changelog
// carries no category, so jira_transitions.to_category is always 'Unknown'
// (see packages/shared status-rules.ts) and a to_category='Done' filter matched
// zero rows for every Jira board.
export function buildChCompletionTrendSql({ config, scope }: BuilderInputs): BuiltSql | null {
  if (scope.isEmpty || scope.jiraProjectKeys.length === 0) return null;

  const days = resolveDays((config as { days?: unknown }).days, DEFAULT_DAYS);
  const { from, to } = resolvePeriod(config, Date.now, days);
  const params: Record<string, unknown> = {};

  const sql = `
      SELECT
        toString(toDate(transitioned_at)) AS date,
        count() AS count
      FROM cockpit.jira_transitions
      WHERE ${jiraScopeFilter(scope, params, { keyColumn: 'issue_key' })}
        AND ${chNormalizedStatusExpr('to_status')} IN {doneStatuses:Array(String)}
        AND transitioned_at >= {from:DateTime}
        AND transitioned_at < {to:DateTime}
      GROUP BY date
      ORDER BY date ASC
    `;

  return {
    sql,
    params: {
      ...params,
      doneStatuses: [...DONE_STATUS_NAMES],
      from: formatDateTime(from),
      to: formatDateTime(to),
    },
  };
}

registerBuilder('CH_COMPLETION_TREND', buildChCompletionTrendSql);
