import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { jiraScopeFilter } from '../../widgets/unions.js';

export function buildInitiativeRiskRadarSql({ scope }: BuilderInputs): BuiltSql | null {
  const hasJira = scope.jiraProjectKeys.length > 0;
  const hasGitHub = scope.githubRepoFullNames.length > 0;
  if (!hasJira && !hasGitHub) return null;

  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (hasJira) {
    legs.push(
      `SELECT summary AS name, toString(due_date) AS due_date, status_category AS status, 'jira' AS source
         FROM cockpit.jira_issues
        WHERE ${jiraScopeFilter(scope, params)}
          AND issue_type = 'Epic'
          AND due_date IS NOT NULL`
    );
  }

  if (hasGitHub) {
    legs.push(
      `SELECT title AS name, toString(due_on) AS due_date, state AS status, 'github' AS source
         FROM cockpit.github_milestones
        WHERE repo_full_name IN {ghRepos:Array(String)}
          AND due_on IS NOT NULL`
    );
    params.ghRepos = scope.githubRepoFullNames;
  }

  const sql = legs.join(' UNION ALL ');

  return {
    sql,
    params,
  };
}

registerBuilder('INITIATIVE_RISK_RADAR', buildInitiativeRiskRadarSql);
