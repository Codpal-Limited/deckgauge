// Bitbucket Cloud — pure processor bodies for one (instance × repository) sync.
//
// Two phases, deliberately separate functions: PRs + commits share the
// `lastSyncedAt` watermark, deployments have their own (`lastDeploymentSyncAt`,
// a different window and a different sort order). The handler stamps each
// watermark only when ITS phase succeeded, so a repository with Pipelines
// switched off still advances its PR watermark.
import type {
  BitbucketPrPort,
  BitbucketCommitPort,
  BitbucketDeploymentPort,
  BitbucketPullRequestRow,
  BitbucketReviewRow,
  BitbucketCommitRow,
  BitbucketDeploymentRow,
} from '@deckgauge/shared';

export interface ProcessBitbucketSyncOpts {
  repoFullName: string;
  /** Lower bound for both PR `updated_on` and commit date. */
  since: Date;
  syncPrs: boolean;
  syncCommits: boolean;
  /**
   * Resolves the branch commits are read from. Only called when commits are
   * synced, so a PR-only repository costs no extra request.
   * `null` means the repository has no main branch (it is empty): commits are
   * skipped, which is not an error.
   */
  resolveMainBranch: () => Promise<string | null>;
  ticketPrefixes: string[];
  prAdapter: BitbucketPrPort;
  commitAdapter: BitbucketCommitPort;
  /** Invoked once per page of pull requests; the caller persists the batch. */
  onPullRequests: (rows: BitbucketPullRequestRow[]) => Promise<void>;
  /** Invoked once per page of reviews co-emitted with the PR page. */
  onReviews: (rows: BitbucketReviewRow[]) => Promise<void>;
  /** Invoked once per page of commits. */
  onCommits: (rows: BitbucketCommitRow[]) => Promise<void>;
}

export interface ProcessBitbucketSyncResult {
  pullRequestsWritten: number;
  reviewsWritten: number;
  commitsWritten: number;
}

// Page by page, never buffered: see gitlab-sync.processor.ts for the OOM that
// buffering a whole repository's history caused on a first backfill.
export async function processBitbucketSync(
  opts: ProcessBitbucketSyncOpts,
): Promise<ProcessBitbucketSyncResult> {
  let pullRequestsWritten = 0;
  let reviewsWritten = 0;
  let commitsWritten = 0;

  if (opts.syncPrs) {
    for await (const page of opts.prAdapter.streamPullRequests({
      repoFullName: opts.repoFullName,
      updatedAfter: opts.since,
      ticketPrefixes: opts.ticketPrefixes,
    })) {
      if (page.pullRequests.length > 0) {
        await opts.onPullRequests(page.pullRequests);
        pullRequestsWritten += page.pullRequests.length;
      }
      if (page.reviews.length > 0) {
        await opts.onReviews(page.reviews);
        reviewsWritten += page.reviews.length;
      }
    }
  }

  if (opts.syncCommits) {
    const branch = await opts.resolveMainBranch();
    if (branch) {
      for await (const batch of opts.commitAdapter.streamCommits({
        repoFullName: opts.repoFullName,
        branch,
        since: opts.since,
        ticketPrefixes: opts.ticketPrefixes,
      })) {
        if (batch.length > 0) {
          await opts.onCommits(batch);
          commitsWritten += batch.length;
        }
      }
    }
  }

  return { pullRequestsWritten, reviewsWritten, commitsWritten };
}

export interface ProcessBitbucketDeploymentsOpts {
  repoFullName: string;
  since: Date;
  deploymentAdapter: BitbucketDeploymentPort;
  onDeployments: (rows: BitbucketDeploymentRow[]) => Promise<void>;
}

/**
 * The deployment port is not a stream — the adapter stops at the window itself
 * (newest first, 90 days on a first sync), so the result is bounded by the
 * window rather than by the repository's history.
 */
export async function processBitbucketDeployments(
  opts: ProcessBitbucketDeploymentsOpts,
): Promise<{ deploymentsWritten: number }> {
  const rows = await opts.deploymentAdapter.fetchDeployments({
    repoFullName: opts.repoFullName,
    since: opts.since,
  });
  if (rows.length > 0) await opts.onDeployments(rows);
  return { deploymentsWritten: rows.length };
}
