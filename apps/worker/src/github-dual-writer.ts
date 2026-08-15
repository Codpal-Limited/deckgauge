// apps/worker/src/github-dual-writer.ts
import type { ChClient } from './jira-dual-writer.js';
import type { DeveloperProfileSink } from './developer-profile-sink.js';
import type { GitHubIssue, GitHubMilestone } from '@deckgauge/shared';

export type { ChClient };

export interface GitHubDualWritePayload {
  pullRequests: ReadonlyArray<Record<string, unknown>>;
  reviews: ReadonlyArray<Record<string, unknown>>;
  commits: ReadonlyArray<Record<string, unknown>>;
}

export async function writeGitHubToClickHouse(
  ch: ChClient,
  payload: GitHubDualWritePayload,
  profileSink?: DeveloperProfileSink,
): Promise<void> {
  if (payload.pullRequests.length > 0)
    await ch.insertRows('github_pull_requests', payload.pullRequests);
  if (payload.reviews.length > 0) await ch.insertRows('github_reviews', payload.reviews);
  if (payload.commits.length > 0) await ch.insertRows('github_commits', payload.commits);

  // P8.5 — fan out unique author/reviewer/committer logins to the
  // DeveloperProfile sink. PR rows expose `author_login`; review rows expose
  // `reviewer_login` (and `pr_author_login`); commit rows expose
  // `author_login`, `author_name`, `author_email`. Idempotent via
  // (provider, login) unique index.
  if (profileSink) {
    const seen = new Set<string>();
    for (const row of payload.pullRequests) {
      await upsertGithubOnce(profileSink, seen, {
        login: pickString(row, 'author_login'),
        displayName: pickString(row, 'author_login'),
        email: null,
      });
    }
    for (const row of payload.reviews) {
      await upsertGithubOnce(profileSink, seen, {
        login: pickString(row, 'reviewer_login'),
        displayName: pickString(row, 'reviewer_login'),
        email: null,
      });
      // PR author can also appear on review rows — still de-duped by Set.
      await upsertGithubOnce(profileSink, seen, {
        login: pickString(row, 'pr_author_login'),
        displayName: pickString(row, 'pr_author_login'),
        email: null,
      });
    }
    for (const row of payload.commits) {
      await upsertGithubOnce(profileSink, seen, {
        login: pickString(row, 'author_login'),
        displayName: pickString(row, 'author_name') ?? pickString(row, 'author_login'),
        email: pickString(row, 'author_email'),
      });
    }
  }
}

function pickString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function upsertGithubOnce(
  sink: DeveloperProfileSink,
  seen: Set<string>,
  input: { login: string | null; displayName: string | null; email: string | null },
): Promise<void> {
  if (!input.login) return;
  const key = `github:${input.login}`;
  if (seen.has(key)) return;
  seen.add(key);
  await sink.upsertOnSync({
    provider: 'github',
    login: input.login,
    displayName: input.displayName,
    avatarUrl: null,
    email: input.email,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Basic-shape dual-write (P4.5): the GitHubPort adapter used by
// github-sync.processor returns the thin `GitHubIssue` / `GitHubMilestone`
// shapes — no PR/commit/review data. The richer `GitHubPrAdapter` /
// `GitHubCommitAdapter` used by github-intelligence-sync.handler fetches those
// separately. This helper lets the basic processor still dual-write its
// issues + milestones into the matching `github_issues` and `github_milestones`
// ClickHouse tables. ReplacingMergeTree merges the rows with the rich data the
// intelligence handler writes (different tables — no row collision today).
// Uses the same column mapping the original backfill used.

export interface GitHubBasicDualWritePayload {
  issues: ReadonlyArray<Record<string, unknown>>;
  milestones: ReadonlyArray<Record<string, unknown>>;
}

export async function writeGitHubBasicToClickHouse(
  ch: ChClient,
  payload: GitHubBasicDualWritePayload,
): Promise<void> {
  if (payload.issues.length > 0) await ch.insertRows('github_issues', payload.issues);
  if (payload.milestones.length > 0)
    await ch.insertRows('github_milestones', payload.milestones);
}

// ClickHouse DateTime input wants 'YYYY-MM-DD HH:MM:SS' (no ms, no trailing Z).
function fmt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function fmtOrNull(d: Date | null | undefined): string | null {
  return d ? fmt(d) : null;
}

export function mapGitHubToClickHouseRows(input: {
  issues: ReadonlyArray<GitHubIssue>;
  milestones: ReadonlyArray<GitHubMilestone>;
  instanceId?: string;
}): {
  issueRows: Array<Record<string, unknown>>;
  milestoneRows: Array<Record<string, unknown>>;
} {
  const instanceId = input.instanceId ?? '';

  const issueRows = input.issues.map((i) => ({
    id: i.id,
    repo_full_name: i.repoFullName,
    number: i.number,
    instance_id: instanceId,
    title: i.title,
    body: i.body ?? '',
    state: i.state,
    labels: i.labels ?? [],
    assignee_login: i.assigneeLogin ?? null,
    assignee_name: null,
    milestone_number: null,
    milestone_title: null,
    linked_ticket_keys: [],
    is_pull_request: 0,
    pull_request_number: null,
    created_at: fmt(i.createdAt),
    updated_at: fmt(i.updatedAt),
    closed_at: fmtOrNull(i.closedAt),
  }));

  const milestoneRows = input.milestones.map((m) => ({
    id: m.id,
    repo_full_name: m.repoFullName,
    number: m.number,
    instance_id: instanceId,
    title: m.title,
    description: '',
    state: m.state,
    due_on: fmtOrNull(m.dueOn),
    open_issues: 0,
    closed_issues: 0,
    created_at: fmt(m.createdAt),
    updated_at: fmt(m.updatedAt),
    closed_at: fmtOrNull(m.closedAt),
  }));

  return { issueRows, milestoneRows };
}
