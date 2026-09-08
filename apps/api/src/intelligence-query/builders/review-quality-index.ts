import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { formatDateTime, resolveWeeks } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';
import { adoScopeFilter } from '../../widgets/unions.js';

const DEFAULT_WEEKS = 12;

// One row of five review-QUALITY KPIs over merged PRs in the period.
// Per-PR flags (has_approval / has_comment) come from a per-PR review
// aggregate LEFT-JOINed to the PR (no review row → 0). Cohort by created_at.
export function buildReviewQualityIndexSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const hasGh = scope.githubRepoFullNames.length > 0;
  const hasAdo = scope.adoProjects.length > 0;
  const hasGl = scope.gitlabProjectPaths.length > 0;
  if (!hasGh && !hasAdo && !hasGl) return null;

  const weeks = resolveWeeks((config as { weeks?: unknown }).weeks, DEFAULT_WEEKS);
  const { from, to } = resolvePeriod(config, Date.now, weeks * 7);

  const legs: string[] = [];
  const params: Record<string, unknown> = { from: formatDateTime(from), to: formatDateTime(to) };

  if (hasGh) {
    params.ghRepos = scope.githubRepoFullNames;
    legs.push(`
      SELECT
        dateDiff('minute', pr.created_at, pr.merged_at)                  AS open_min,
        (length(pr.linked_ticket_keys) > 0)                             AS has_ticket,
        coalesce(rv.has_approval, 0)                                    AS has_approval,
        coalesce(rv.has_comment, 0)                                     AS has_comment
      FROM cockpit.github_pull_requests AS pr FINAL
      LEFT JOIN (
        SELECT repo_full_name, pull_request_number,
          max(reviewer_login != pr_author_login AND lower(state) = 'approved')                            AS has_approval,
          max(reviewer_login != pr_author_login AND (lower(state) IN ('commented','changes_requested') OR comment_count > 0)) AS has_comment
        FROM cockpit.github_reviews FINAL
        WHERE repo_full_name IN {ghRepos:Array(String)}
        GROUP BY repo_full_name, pull_request_number
      ) AS rv ON rv.repo_full_name = pr.repo_full_name AND rv.pull_request_number = pr.number
      WHERE pr.repo_full_name IN {ghRepos:Array(String)}
        AND pr.state = 'merged'
        AND NOT endsWith(pr.author_login, '[bot]')
        AND pr.created_at >= {from:DateTime} AND pr.created_at < {to:DateTime}`);
  }

  if (hasAdo) {
    legs.push(`
      SELECT
        dateDiff('minute', pr.created_at, pr.closed_at)                 AS open_min,
        (length(pr.linked_ticket_keys) > 0)                            AS has_ticket,
        coalesce(rv.has_approval, 0)                                   AS has_approval,
        coalesce(rv.has_comment, 0)                                    AS has_comment
      FROM cockpit.ado_pull_requests AS pr FINAL
      LEFT JOIN (
        SELECT org_url, project, pull_request_id,
          max(reviewer_login != pr_author_login AND vote >= 5)         AS has_approval,
          max(reviewer_login != pr_author_login AND comment_count > 0) AS has_comment
        FROM cockpit.ado_reviews FINAL
        WHERE ${adoScopeFilter(scope, params, { repoColumn: 'repo_name' })}
        GROUP BY org_url, project, pull_request_id
      ) AS rv ON rv.org_url = pr.org_url AND rv.project = pr.project AND rv.pull_request_id = pr.pr_id
      WHERE ${adoScopeFilter(scope, params, { repoColumn: 'repo_name', alias: 'pr' })}
        AND pr.status = 'completed'
        AND pr.created_at >= {from:DateTime} AND pr.created_at < {to:DateTime}`);
  }

  if (hasGl) {
    params.glPaths = scope.gitlabProjectPaths;
    legs.push(`
      SELECT
        dateDiff('minute', mr.created_at, mr.merged_at)                 AS open_min,
        (length(mr.linked_ticket_keys) > 0)                            AS has_ticket,
        coalesce(rv.has_approval, 0)                                   AS has_approval,
        coalesce(rv.has_comment, 0)                                    AS has_comment
      FROM cockpit.gitlab_merge_requests AS mr FINAL
      LEFT JOIN (
        SELECT project_path, merge_request_iid,
          max(reviewer_username != mr_author_username AND state = 'approved')                          AS has_approval,
          max(reviewer_username != mr_author_username AND (state = 'commented' OR comment_count > 0))   AS has_comment
        FROM cockpit.gitlab_reviews FINAL
        WHERE project_path IN {glPaths:Array(String)}
        GROUP BY project_path, merge_request_iid
      ) AS rv ON rv.project_path = mr.project_path AND rv.merge_request_iid = mr.iid
      WHERE mr.project_path IN {glPaths:Array(String)}
        AND mr.state = 'merged'
        AND mr.created_at >= {from:DateTime} AND mr.created_at < {to:DateTime}`);
  }

  return {
    sql: `
      WITH all_prs AS (${legs.join(' UNION ALL ')})
      SELECT
        round(100 * countIf(has_approval) / nullIf(count(), 0))        AS coverage_pct,
        round(quantile(0.5)(open_min) / 60, 1)                         AS median_open_h,
        round(100 * countIf(open_min < 10) / nullIf(count(), 0))       AS instant_pct,
        round(100 * countIf(has_comment) / nullIf(count(), 0))         AS comment_pct,
        round(100 * countIf(has_ticket) / nullIf(count(), 0))          AS ticket_pct,
        toUInt64(count())                                              AS merged_prs
      FROM all_prs
    `,
    params,
  };
}

registerBuilder('REVIEW_QUALITY_INDEX', buildReviewQualityIndexSql);
