import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { resolveSprints } from '../../widgets/widget-helpers.js';
import { jiraScopeFilter, adoScopeFilter } from '../../widgets/unions.js';

const DEFAULT_SPRINTS = 6;

export function buildIterationPlanningAccuracySql({ config, scope }: BuilderInputs): BuiltSql | null {
  if (scope.isEmpty) return null;

  const hasJira = scope.jiraProjectKeys.length > 0;
  const hasAdo = scope.adoProjects.length > 0;
  if (!hasJira && !hasAdo) return null;

  const sprints = resolveSprints((config as { sprints?: unknown }).sprints, DEFAULT_SPRINTS);

  const legs: string[] = [];
  const params: Record<string, unknown> = { sprints };

  if (hasJira) {
    legs.push(
      `SELECT sprint_name AS iteration_name, status_category AS state, 'jira' AS source
         FROM cockpit.jira_issues
        WHERE ${jiraScopeFilter(scope, params)}
          AND sprint_state = 'closed'`
    );
  }

  if (hasAdo) {
    legs.push(
      `SELECT iteration_path AS iteration_name, state AS state, 'ado' AS source
         FROM cockpit.ado_work_items
        WHERE ${adoScopeFilter(scope, params, { areaPathColumn: 'area_path' })} AND iteration_path != ''`
    );
  }

  const iterationsCte = legs.join(' UNION ALL ');

  return {
    sql: `
      WITH iterations AS (${iterationsCte})
      SELECT
        iteration_name,
        countIf(state IN ('Done','Closed','Resolved'))                AS completed,
        count()                                                       AS committed,
        if(count() = 0, 0, 100 * countIf(state IN ('Done','Closed','Resolved')) / count())
                                                                      AS accuracy_pct
      FROM iterations
      GROUP BY iteration_name
      ORDER BY iteration_name DESC
      LIMIT {sprints:UInt32}
    `,
    params,
  };
}

registerBuilder('ITERATION_PLANNING_ACCURACY', buildIterationPlanningAccuracySql);
