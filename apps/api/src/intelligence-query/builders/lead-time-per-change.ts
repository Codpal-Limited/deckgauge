import type { BoardScope } from '../../intelligence/board-scope.js';
import {
  adoScopeFilter,
  deploymentsUnion,
  pullRequestsUnion,
  type UnionResult,
} from '../../widgets/unions.js';

// Lead time for changes, one row per merged PR: merged_at, measured_to
// ('deploy' | 'merge') and lead_time_hours. LEAD_TIME_FOR_CHANGES and
// DORA_METRICS both aggregate over this, so the two cannot disagree about what
// a change's lead time is.
//
// DORA defines lead time as commit → running in production. What is observable:
//
//   START: PR opened. Nothing ingested links a PR to its commits, so the first
//   commit is not available; PR open is the earliest event we actually see. A
//   team that commits for days before opening a PR reads shorter than DORA's
//   number, and the docs say so.
//
//   END: the first SUCCESSFUL PRODUCTION deploy of the PR's repository at or
//   after the merge — the release that shipped it, on the usual
//   "main is deployed in order" assumption. A failed run, or a deploy to a
//   non-production environment, ships nothing and is skipped. Production is
//   decided exactly as deploy frequency decides it (deploymentsUnion).
//
// A repository with NO production deploys on record cannot be measured to
// production at all, so its PRs fall back to PR opened → merged and are tagged
// measured_to = 'merge'. A PR in a repository that DOES deploy but that no deploy
// has followed yet is excluded: it has no lead time until it ships, and counting
// it at merge would pull the median down with changes still waiting to release.
//
// Pairing is arrayFirst over one sorted array of deploy times per repository,
// not an ASOF JOIN: the SQL console's parser (scope/parser.ts), which every
// builder's SQL must round-trip through, does not accept ASOF.
//
// Repository identity per deploy: GitHub names it. ado_deployments has none, so
// the release's source commit is looked up in ado_commits; a commit that does not
// resolve (or a deploy with no source commit) pairs with nothing.
export function leadTimePerChangeSql(scope: BoardScope): UnionResult {
  const prs = pullRequestsUnion(scope);
  if (prs.sql === null) return { sql: null, params: prs.params };

  const deployments = deploymentsUnion(scope);
  const params: Record<string, unknown> = { ...prs.params, ...deployments.params };

  const merged = `
    SELECT repo, created_at, assumeNotNull(merged_at) AS merged_at, cycle_time_hours
    FROM (${prs.sql})
    WHERE state = 'merged' AND merged_at IS NOT NULL`;

  // No deployment source in scope: every change is measured to merge.
  if (deployments.sql === null) {
    return {
      sql: `SELECT merged_at, 'merge' AS measured_to, cycle_time_hours AS lead_time_hours
        FROM (${merged})`,
      params,
    };
  }

  const adoRepoBySha = scope.adoProjects.length
    ? `SELECT sha, any(concat(project, '/', repo_name)) AS repo
       FROM cockpit.ado_commits
       WHERE ${adoScopeFilter(scope, params, { repoColumn: 'repo_name' })}
       GROUP BY sha`
    : `SELECT '' AS sha, '' AS repo WHERE 0`;

  return {
    sql: `
      WITH
        lt_ado_repo AS (${adoRepoBySha}),
        lt_deploys AS (
          SELECT if(d.repo != '', d.repo, r.repo) AS repo, assumeNotNull(d.deployed_at) AS deployed_at
          FROM (${deployments.sql}) AS d
          LEFT JOIN lt_ado_repo AS r ON d.sha = r.sha
          WHERE d.is_success AND d.is_production AND d.deployed_at IS NOT NULL
            AND if(d.repo != '', d.repo, r.repo) != ''
        ),
        lt_deploy_times AS (
          SELECT repo, arraySort(groupArray(deployed_at)) AS times
          FROM lt_deploys
          GROUP BY repo
        ),
        lt_paired AS (
          SELECT p.repo AS repo, p.created_at AS created_at, p.merged_at AS merged_at,
                 p.cycle_time_hours AS cycle_time_hours,
                 t.repo != '' AS repo_deploys,
                 arrayExists(x -> x >= p.merged_at, t.times) AS shipped,
                 arrayFirst(x -> x >= p.merged_at, t.times) AS deployed_at
          FROM (${merged}) AS p
          LEFT JOIN lt_deploy_times AS t ON p.repo = t.repo
        )
      SELECT
        merged_at,
        if(repo_deploys, 'deploy', 'merge') AS measured_to,
        if(repo_deploys,
           dateDiff('second', created_at, deployed_at) / 3600,
           cycle_time_hours) AS lead_time_hours
      FROM lt_paired
      WHERE NOT repo_deploys OR shipped`,
    params,
  };
}
