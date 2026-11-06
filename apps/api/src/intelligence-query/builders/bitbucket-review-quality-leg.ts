import type { BoardScope } from '../../intelligence/board-scope.js';

/**
 * The Bitbucket leg of REVIEW_QUALITY_INDEX and REVIEW_QUALITY_TREND's
 * `all_prs` union: one row per merged PR with its peer-approval / peer-comment
 * flags. Shared by both builders so the two cannot disagree about what a
 * Bitbucket review is (the github / ado / gitlab legs are written out twice
 * and have to be kept in step by hand).
 *
 * Bitbucket-specific rules:
 *   - state is UPPERCASE (PR: MERGED; review: APPROVED | COMMENTED |
 *     CHANGES_REQUESTED), unlike gitlab's lowercase;
 *   - release PRs (`is_release = 1`, a stage→prod sync) are excluded, as in
 *     every PR union — their "approval" is a release sign-off on features that
 *     were already reviewed, and counting them would inflate coverage.
 *
 * Returns null when the board has no Bitbucket repository. Binds `bbRepos`.
 */
export function bitbucketReviewQualityLeg(
  scope: BoardScope,
  params: Record<string, unknown>,
  opts: { withCreatedAt: boolean },
): string | null {
  const repos = scope.bitbucketRepoFullNames ?? [];
  if (repos.length === 0) return null;
  params.bbRepos = repos;
  const createdAt = opts.withCreatedAt
    ? `
        pr.created_at                                                   AS created_at,`
    : '';
  return `
      SELECT${createdAt}
        dateDiff('minute', pr.created_at, pr.merged_at)                  AS open_min,
        (length(pr.linked_ticket_keys) > 0)                             AS has_ticket,
        coalesce(rv.has_approval, 0)                                    AS has_approval,
        coalesce(rv.has_comment, 0)                                     AS has_comment
      FROM cockpit.bitbucket_pull_requests AS pr FINAL
      LEFT JOIN (
        SELECT repo_full_name, pr_id,
          max(reviewer_username != pr_author_username AND state = 'APPROVED')                                    AS has_approval,
          max(reviewer_username != pr_author_username AND (state IN ('COMMENTED', 'CHANGES_REQUESTED') OR comment_count > 0)) AS has_comment
        FROM cockpit.bitbucket_reviews FINAL
        WHERE repo_full_name IN {bbRepos:Array(String)}
        GROUP BY repo_full_name, pr_id
      ) AS rv ON rv.repo_full_name = pr.repo_full_name AND rv.pr_id = pr.pr_id
      WHERE pr.repo_full_name IN {bbRepos:Array(String)}
        AND pr.state = 'MERGED'
        AND pr.is_release = 0
        AND pr.created_at >= {from:DateTime} AND pr.created_at < {to:DateTime}`;
}
