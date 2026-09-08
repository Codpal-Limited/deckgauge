import { pullRequestsUnion } from '../../widgets/unions.js';
import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { formatDateTime, resolveWeeks } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';

const DEFAULT_WEEKS = 12;

// The point identity a reader needs to act on an outlier: `repo #number` is what
// the provider itself displays and what a search box accepts, where the union's
// `id` is an internal identifier nobody can look up. `subtitle` carries the PR
// title so the tooltip can say which change the dot is, not just which number.
//
// `href` is still a placeholder. A real one needs the provider's WEB host, which
// ClickHouse does not hold — only the connection's API baseUrl in Postgres does
// (and per instance_id, since a board can span two GitHub instances). Building
// it belongs in the service layer, where Prisma is in scope; until then this
// widget's dot click drills by author and never reads href.

export function buildPrCycleTimeScatterSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const prs = pullRequestsUnion(scope);
  if (prs.sql === null) return null;

  const weeks = resolveWeeks((config as { weeks?: unknown }).weeks, DEFAULT_WEEKS);
  const { from, to } = resolvePeriod(config, Date.now, weeks * 7);

  return {
    sql: `
      WITH prs AS (${prs.sql})
      SELECT
        toString(toDate(merged_at))           AS x,
        cycle_time_hours                      AS y,
        concat(repo, ' #', toString(number))  AS label,
        title                                 AS subtitle,
        concat('#', toString(id))             AS href,
        author                                AS author
      FROM prs
      WHERE merged_at IS NOT NULL
        AND merged_at >= {from:DateTime}
        AND merged_at < {to:DateTime}
        AND cycle_time_hours IS NOT NULL
        AND state = 'merged'
      ORDER BY merged_at DESC
      LIMIT 500
    `,
    params: { ...prs.params, from: formatDateTime(from), to: formatDateTime(to) },
  };
}

registerBuilder('PR_CYCLE_TIME_SCATTER', buildPrCycleTimeScatterSql);
