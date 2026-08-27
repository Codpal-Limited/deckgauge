// Per-repo, watermark-driven intelligence sync used by the three-tier
// BullMQ queues (hot/warm/cold). One job = one repo.
import { PrismaClient } from '@deckgauge/db';
import { RateLimiter } from './github-rate-limiter.js';
import { buildJiraKeyRegex, reconcilePrLinks } from './github-jira-key-linker.js';
import {
  computeTier,
  transformGitHubPr,
  detectAiAssistance,
  type GitHubRawPr,
  type GitHubRawReview,
  type GitHubRawReviewComment,
  type GitHubPullRequestRow,
} from '@deckgauge/shared';

export interface ChClient {
  insertRows(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}

/**
 * Builds a ClickHouse client bound to one organization. See jira-dual-writer.ts
 * for why the ingest path takes the factory rather than a client: the repos this
 * runner is called for can belong to different tenants, and `organization_id` is
 * a sort-key column ClickHouse cannot correct afterwards.
 */
export type ChClientFactory = (organizationId: string) => ChClient;

// Structural type — avoids hard-deping @octokit/rest in the worker. Real Octokit
// instances satisfy this automatically. The api builds the real client and
// hands it in via deps.
export interface OctokitLike {
  paginate: (route: string, params: Record<string, unknown>) => Promise<unknown>;
  // Single-resource GET (e.g. PR detail). Real Octokit exposes this; the bulk
  // intelligence sync needs it to fetch per-PR additions/deletions/changed_files
  // that the list endpoint omits.
  request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
}

export interface RunIntelligenceSyncDeps {
  prisma: PrismaClient;
  octokit: OctokitLike;
  rateLimiter: RateLimiter;
  /**
   * Builds a ClickHouse client bound to one organization. Bound below, from the
   * organization owning the GitHub instance THIS repo belongs to — a client
   * bound by the caller would let either entry point (the three-tier workers or
   * the manual fan-out) write one tenant's repo under another's id.
   */
  chClientFor: ChClientFactory;
}

// Minimal structural views of the GitHub REST shapes we consume. Only the
// fields actually read are declared — paginate() returns `unknown`, so we
// cast at the boundary and let TypeScript check downstream property access.
interface GhPr {
  number: number;
  title: string;
  user: { login: string } | null;
  state: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  base: { ref: string };
  head: { ref: string; sha: string };
}
interface GhReview {
  id: number;
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
}
interface GhReviewComment {
  pull_request_review_id: number | null;
}
interface GhCommit {
  sha: string;
  author: { login: string } | null;
  committer: { login: string } | null;
  commit: {
    message: string;
    author: { name: string; date: string; email: string };
    committer: { name: string } | null;
  };
}
interface GhWorkflowRun {
  id: number;
  workflow_id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  actor: { login: string } | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
}
interface GhDeployment {
  id: number;
  ref: string;
  sha: string;
  task: string;
  environment: string;
  production_environment: boolean;
  creator: { login: string } | null;
  created_at: string;
  updated_at: string;
}
interface GhIssue {
  number: number;
  title: string;
  user: { login: string } | null;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: Array<string | { name: string }>;
  pull_request?: unknown;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Build a github_commits row. Shared by both write paths (PR-branch commits and
// default-branch commits) so their column set can't drift. `author_login` is ''
// when GitHub can't link the commit email to an account (common for external
// contractors); author_name/email are kept from the commit itself so per-person
// views can still attribute the work by name/email rather than collapsing every
// unlinked commit into one blank bucket. committer_* record squash/rebase authorship.
function buildCommitRow(
  repoFullName: string,
  c: GhCommit,
  ai: { aiAssisted: boolean; confidence: number | null; signals: unknown },
): Record<string, unknown> {
  return {
    id: `${repoFullName}#${c.sha}`,
    repo_full_name: repoFullName,
    sha: c.sha,
    author_login: c.author?.login ?? '',
    author_name: c.commit.author.name ?? '',
    author_email: c.commit.author.email,
    committer_login: c.committer?.login ?? null,
    committer_name: c.commit.committer?.name ?? '',
    message: c.commit.message,
    message_subject: c.commit.message.split(/\r?\n/)[0],
    committed_at: c.commit.author.date,
    ai_assisted: ai.aiAssisted ? 1 : 0,
    ai_confidence: ai.confidence,
    ai_signals: JSON.stringify(ai.signals),
  };
}

export async function runIntelligenceSync(
  deps: RunIntelligenceSyncDeps,
  repoSyncId: string,
): Promise<void> {
  const sync = await deps.prisma.gitHubRepoSync.findUniqueOrThrow({
    where: { id: repoSyncId },
    // The owning tenant travels with the repo: a GitHubRepoSync has no
    // organization of its own, its instance does.
    include: { githubInstance: { select: { organizationId: true } } },
  });
  if (sync.disabledAt) return;

  // Bind ClickHouse to the organization that owns THIS repo's GitHub connection.
  // Resolved here rather than by the caller so both entry points — the
  // three-tier workers and the manual fan-out — are correct by construction.
  const ch = deps.chClientFor(sync.githubInstance.organizationId);

  const [owner, repo] = sync.repoFullName.split('/');
  // Scoped to the organization that owns this repo, for the same reason the
  // ClickHouse client above is. This regex decides which Jira keys a pull request
  // title may link to, so an unscoped read let org A's PRs link to org B's issue
  // keys — and wrote those rows into pr_jira_links — on the strength of projects
  // org A neither sees nor syncs. Inert at one organization, which is why it
  // survived. Tenancy §11 precondition 4.
  const projectKeys = (
    await deps.prisma.jiraProjectSync.findMany({
      where: { jiraInstance: { organizationId: sync.githubInstance.organizationId } },
      select: { jiraProjectKey: true },
    })
  ).map((p) => p.jiraProjectKey);
  const regex = buildJiraKeyRegex(projectKeys);

  const since = (wm: Date | null): Date =>
    wm ?? new Date(Date.now() - sync.backfillMonths * 30 * 86_400_000);

  const errors: Record<string, string> = {};

  // ── 1) PRs (+ reviews + commits per PR) ────────────────────────────────────
  try {
    await deps.rateLimiter.acquire(10);
    const prs = (await deps.octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    })) as GhPr[];
    const filtered = prs.filter((p) => new Date(p.updated_at) > since(sync.prsWatermark));

    // Build a full-fidelity ClickHouse row for each changed PR. The list
    // endpoint omits additions/deletions/changed_files, so we fetch per-PR
    // detail and run it through the shared `transformGitHubPr` mapper — the same
    // transform GitHubPrAdapter uses. This derives `state` ('merged' when
    // merged_at is set, not the raw open/closed) plus cycle/review/approval/merge
    // times and AI detection, which the MV and board-scoped queries require.
    // Rows are collected and inserted after the loop so a mid-loop failure
    // leaves the watermark unadvanced and the batch retried next run.
    const prRows: GitHubPullRequestRow[] = [];
    // PR-branch commits, deduped by sha. github_commits is otherwise populated
    // only from the default branch (block 2), so commits on open/unmerged PRs
    // never reach the commit-heat sparkbar or the code-activity signal until
    // merge. Same row shape as block 2; RMT keyed by (repo, sha) dedups against
    // the eventual default-branch copy.
    const prCommitRows = new Map<string, Record<string, unknown>>();
    for (const pr of filtered) {
      await deps.rateLimiter.acquire(3);
      const [detailRaw, reviewsRaw, commitsRaw, reviewCommentsRaw] = await Promise.all([
        deps.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner,
          repo,
          pull_number: pr.number,
        }),
        deps.octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
          owner,
          repo,
          pull_number: pr.number,
        }),
        deps.octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
          owner,
          repo,
          pull_number: pr.number,
        }),
        // Inline review comments — tallied per review into comment_count.
        deps.octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
          owner,
          repo,
          pull_number: pr.number,
        }),
      ]);
      const detail = detailRaw.data as GitHubRawPr;
      const reviews = reviewsRaw as GhReview[];
      const commits = commitsRaw as GhCommit[];
      const reviewComments = reviewCommentsRaw as GhReviewComment[];

      for (const c of commits) {
        if (!c.sha || prCommitRows.has(c.sha)) continue;
        const ai = detectAiAssistance({
          commitMessage: c.commit.message,
          branchName: pr.head.ref,
          authorLogin: c.author?.login ?? undefined,
        });
        prCommitRows.set(c.sha, buildCommitRow(sync.repoFullName, c, ai));
      }

      const { pr: prRow, reviews: reviewRows } = transformGitHubPr({
        repoFullName: sync.repoFullName,
        instanceId: sync.githubInstanceId,
        pr: detail,
        rawReviews: reviews as unknown as GitHubRawReview[],
        prefixes: projectKeys,
        // The AI signature (Co-Authored-By: Claude, "Generated with Claude Code")
        // usually lives in the PR's commit trailers, not the title/body — feed
        // them in so AI-authored PRs with clean titles are still detected.
        commitMessages: commits.map((c) => c.commit.message),
        reviewComments: reviewComments as unknown as GitHubRawReviewComment[],
      });
      prRows.push(prRow);

      // Use the reviewRows produced by transformGitHubPr — they carry the
      // correct ClickHouse shape: `pull_request_number` (so review widgets can
      // join to github_pull_requests) and a lowercased `state` (so the
      // `state != 'commented'` filter works). The previous hand-rolled mapping
      // wrote `pr_number` (not a column → pull_request_number defaulted to 0)
      // and raw UPPERCASE state, which silently dropped every review from the
      // PR join in Review Mix / Review Pickup.
      if (reviewRows.length > 0)
        await ch.insertRows(
          'github_reviews',
          reviewRows as unknown as Array<Record<string, unknown>>,
        );

      await reconcilePrLinks(deps.prisma, regex, sync.githubInstance.organizationId, {
        id: `${sync.repoFullName}#${pr.number}`,
        repo: sync.repoFullName,
        title: pr.title,
        mergedAt: detail.merged_at ? new Date(detail.merged_at) : null,
        commits: commits.map((c) => ({ message: c.commit.message })),
      });
    }
    if (prRows.length > 0)
      await ch.insertRows(
        'github_pull_requests',
        prRows as unknown as Array<Record<string, unknown>>,
      );
    if (prCommitRows.size > 0)
      await ch.insertRows('github_commits', [...prCommitRows.values()]);

    const newWm = filtered.reduce<Date | null>(
      (max, p) => {
        const d = new Date(p.updated_at);
        return !max || d > max ? d : max;
      },
      sync.prsWatermark,
    );
    if (newWm) {
      await deps.prisma.gitHubRepoSync.update({
        where: { id: sync.id },
        data: { prsWatermark: newWm },
      });
    }
  } catch (e: unknown) {
    errors.prs = errMsg(e);
  }

  // ── 2) Commits on default branch (since watermark) ─────────────────────────
  try {
    await deps.rateLimiter.acquire(5);
    const commits = (await deps.octokit.paginate('GET /repos/{owner}/{repo}/commits', {
      owner,
      repo,
      sha: sync.defaultBranch,
      since: since(sync.commitsWatermark).toISOString(),
      per_page: 100,
    })) as GhCommit[];
    const rows = commits.map((c) => {
      const ai = detectAiAssistance({
        commitMessage: c.commit.message,
        branchName: sync.defaultBranch,
        authorLogin: c.author?.login ?? undefined,
      });
      return buildCommitRow(sync.repoFullName, c, ai);
    });
    if (rows.length > 0) await ch.insertRows('github_commits', rows);
    const maxDate = commits.reduce<Date | null>(
      (max, c) => {
        const d = new Date(c.commit.author.date);
        return !max || d > max ? d : max;
      },
      sync.commitsWatermark,
    );
    if (maxDate) {
      await deps.prisma.gitHubRepoSync.update({
        where: { id: sync.id },
        data: { commitsWatermark: maxDate },
      });
    }
  } catch (e: unknown) {
    errors.commits = errMsg(e);
  }

  // ── 3) Workflow runs ───────────────────────────────────────────────────────
  try {
    await deps.rateLimiter.acquire(5);
    const wm = since(sync.workflowRunsWatermark);
    const raw = await deps.octokit.paginate('GET /repos/{owner}/{repo}/actions/runs', {
      owner,
      repo,
      created: `>${wm.toISOString()}`,
      per_page: 100,
    });
    const runs: GhWorkflowRun[] = Array.isArray(raw)
      ? (raw as GhWorkflowRun[])
      : ((raw as { workflow_runs?: GhWorkflowRun[] } | null)?.workflow_runs ?? []);
    const rows = runs.map((r) => ({
      id: `${sync.repoFullName}#${r.id}`,
      org: owner,
      repo_full_name: sync.repoFullName,
      instance_id: sync.githubInstanceId,
      run_id: r.id,
      workflow_id: r.workflow_id,
      workflow_name: r.name,
      head_branch: r.head_branch,
      head_sha: r.head_sha,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion ?? '',
      run_attempt: r.run_attempt,
      actor_login: r.actor?.login ?? '',
      created_at: r.created_at,
      started_at: r.run_started_at,
      updated_at: r.updated_at,
      duration_ms:
        r.run_started_at && r.updated_at
          ? new Date(r.updated_at).getTime() - new Date(r.run_started_at).getTime()
          : null,
    }));
    if (rows.length > 0) await ch.insertRows('github_workflow_runs', rows);
    await deps.prisma.gitHubRepoSync.update({
      where: { id: sync.id },
      data: { workflowRunsWatermark: new Date() },
    });
  } catch (e: unknown) {
    errors.workflowRuns = errMsg(e);
  }

  // ── 4) Deployments ─────────────────────────────────────────────────────────
  try {
    await deps.rateLimiter.acquire(5);
    const wm = since(sync.deploymentsWatermark);
    const deployments = (await deps.octokit.paginate(
      'GET /repos/{owner}/{repo}/deployments',
      { owner, repo, per_page: 100 },
    )) as GhDeployment[];
    const fresh = deployments.filter((d) => new Date(d.created_at) > wm);
    const rows = fresh.map((d) => ({
      id: `${sync.repoFullName}#${d.id}`,
      org: owner,
      repo_full_name: sync.repoFullName,
      instance_id: sync.githubInstanceId,
      deployment_id: d.id,
      ref: d.ref,
      sha: d.sha,
      task: d.task,
      environment: d.environment,
      production: d.production_environment ? 1 : 0,
      creator_login: d.creator?.login ?? '',
      created_at: d.created_at,
      updated_at: d.updated_at,
      latest_status: null,
      latest_status_at: null,
    }));
    if (rows.length > 0) await ch.insertRows('github_deployments', rows);
    await deps.prisma.gitHubRepoSync.update({
      where: { id: sync.id },
      data: { deploymentsWatermark: new Date() },
    });
  } catch (e: unknown) {
    errors.deployments = errMsg(e);
  }

  // ── 5) Issues (exclude PRs) ────────────────────────────────────────────────
  try {
    await deps.rateLimiter.acquire(5);
    const wm = since(sync.issuesWatermark);
    const issues = (await deps.octokit.paginate('GET /repos/{owner}/{repo}/issues', {
      owner,
      repo,
      since: wm.toISOString(),
      state: 'all',
      filter: 'all',
      per_page: 100,
    })) as GhIssue[];
    const realIssues = issues.filter((i) => i.pull_request === undefined);
    const rows = realIssues.map((i) => ({
      id: `${sync.repoFullName}#${i.number}`,
      repo_full_name: sync.repoFullName,
      number: i.number,
      title: i.title,
      author_login: i.user?.login ?? '',
      state: i.state,
      created_at: i.created_at,
      updated_at: i.updated_at,
      closed_at: i.closed_at,
      labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    }));
    if (rows.length > 0) await ch.insertRows('github_issues', rows);
    const maxUpd = realIssues.reduce<Date | null>(
      (max, i) => {
        const d = new Date(i.updated_at);
        return !max || d > max ? d : max;
      },
      sync.issuesWatermark,
    );
    if (maxUpd) {
      await deps.prisma.gitHubRepoSync.update({
        where: { id: sync.id },
        data: { issuesWatermark: maxUpd },
      });
    }
  } catch (e: unknown) {
    errors.issues = errMsg(e);
  }

  // ── 6) Book-keeping ────────────────────────────────────────────────────────
  const fresh = await deps.prisma.gitHubRepoSync.findUniqueOrThrow({ where: { id: sync.id } });
  const ok = Object.keys(errors).length === 0;
  await deps.prisma.gitHubRepoSync.update({
    where: { id: sync.id },
    data: {
      tier: computeTier(fresh.lastPushedAt),
      lastSuccessAt: ok ? new Date() : sync.lastSuccessAt,
      lastErrorAt: ok ? null : new Date(),
      lastErrorMessage: ok ? null : JSON.stringify(errors),
      backfillCompleteAt: sync.backfillCompleteAt ?? (ok ? new Date() : null),
    },
  });
}
