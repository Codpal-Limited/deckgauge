import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { formatDateTime, resolveWeeks } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';
import { leadTimePerChangeSql } from './lead-time-per-change.js';

const DEFAULT_WEEKS = 12;

// Weekly p50 lead time, bucketed by merge week. Each week also reports how many
// of its changes were measured to a production deploy rather than to merge, so
// the service can say which endpoint the line actually shows — see
// lead-time-per-change.ts for the pairing.
export function buildLeadTimeForChangesSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const changes = leadTimePerChangeSql(scope);
  if (changes.sql === null) return null;

  const weeks = resolveWeeks((config as { weeks?: unknown }).weeks, DEFAULT_WEEKS);
  const { from, to } = resolvePeriod(config, Date.now, weeks * 7);

  return {
    sql: `
      WITH changes AS (${changes.sql})
      SELECT
        toString(toMonday(merged_at))      AS week_start,
        quantile(0.5)(lead_time_hours)     AS p50_hours,
        count()                            AS changes,
        countIf(measured_to = 'deploy')    AS changes_to_deploy
      FROM changes
      WHERE merged_at >= {from:DateTime}
        AND merged_at < {to:DateTime}
        AND lead_time_hours IS NOT NULL
      GROUP BY week_start
      ORDER BY week_start ASC
    `,
    params: { ...changes.params, from: formatDateTime(from), to: formatDateTime(to) },
  };
}

registerBuilder('LEAD_TIME_FOR_CHANGES', buildLeadTimeForChangesSql);
