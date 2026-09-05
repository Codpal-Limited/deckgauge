// EI-003 — GitHubPrAdapter.
// Fetches all PRs (state=all — open, closed, merged, draft) plus reviews and
// per-PR commits from a GitHub repository. Outputs rows shaped for the
// cockpit.github_pull_requests ClickHouse table (CLICKHOUSE-ARCHITECTURE.md §5.5).
// The adapter does NOT write to ClickHouse — the processor (EI-013) does that.

import { detectAiAssistance } from './ai-detection.js';
import { extractTicketKeys } from './ticket-link-extractor.js';
import { chDateTime, chDateTimeRequired } from './clickhouse-datetime.js';

export interface GitHubPrFetchOpts {
  repoFullName: string;          // "owner/repo"
  since?: Date;                  // watermark — only PRs updated >= this
  ticketPrefixes?: string[];     // for linked_ticket_keys extraction
  perPage?: number;              // default 100
  maxPages?: number;             // safety cap, default 100
}

export interface GitHubPullRequestRow {
  id: string;
  repo_full_name: string;
  number: number;
  instance_id: string;
  title: string;
  body: string;
  state: string;                 // open / merged / closed / draft
  is_draft: 0 | 1;
  base_branch: string;
  head_branch: string;
  labels: string[];
  milestone_title: string | null;
  author_login: string;
  author_name: string | null;
  requested_reviewers: string[];
  additions: number;
  deletions: number;
  changed_files: number;
  commit_count: number;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  first_review_at: string | null;
  first_approval_at: string | null;
  cycle_time_hours: number | null;
  review_time_hours: number | null;
  approval_time_hours: number | null;
  merge_time_hours: number | null;
  ai_assisted: 0 | 1;
  ai_confidence: number | null;
  ai_signals: string;            // JSON string
  linked_ticket_keys: string[];
  merge_commit_sha: string | null;
  merged_by_login: string | null;
}

export interface GitHubReviewRow {
  id: string;
  repo_full_name: string;
  pull_request_number: number;
  pr_author_login: string;
  reviewer_login: string;
  reviewer_name: string | null;
  state: string;                 // approved / changes_requested / commented / dismissed
  body: string;
  comment_count: number;
  submitted_at: string;
}

export interface GitHubPrPort {
  fetchPullRequests(opts: GitHubPrFetchOpts): Promise<{
    pullRequests: GitHubPullRequestRow[];
    reviews: GitHubReviewRow[];
  }>;
}

interface GitHubPrAdapterConfig {
  accessToken: string;
  baseUrl?: string;
  instanceId: string;
  fetchFn?: typeof fetch;
}

export interface RawPr {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  merge_commit_sha: string | null;
  base: { ref: string };
  head: { ref: string };
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  milestone: { title: string } | null;
  requested_reviewers: Array<{ login: string }>;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  merged_by?: { login: string } | null;
}

export interface RawReview {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
}

// One inline review comment from GET /pulls/{n}/comments. Each carries the id of
// the review it belongs to, letting us tally comments per review (per reviewer).
// `pull_request_review_id` can be null for stray/legacy comments — those are dropped.
export interface RawReviewComment {
  pull_request_review_id: number | null;
}

interface RawPrCommit {
  commit: { message: string };
}

function hoursBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Number(((t2 - t1) / 3_600_000).toFixed(2));
}

function deriveState(pr: RawPr): string {
  if (pr.draft) return 'draft';
  if (pr.merged_at) return 'merged';
  return pr.state;
}

// GitHub's REST API returns review states uppercase (APPROVED, COMMENTED,
// CHANGES_REQUESTED, DISMISSED). The ClickHouse `github_reviews.state` column
// stores them lowercase (see `transform()` below). These helpers normalize to
// uppercase so derivation works regardless of where the input came from —
// either freshly fetched from the API or re-fed from stored rows.
function reviewState(r: RawReview): string {
  return r.state.toUpperCase();
}

function firstReviewAt(reviews: RawReview[], excludeLogin?: string): string | null {
  const candidates = reviews
    .filter((r) => r.submitted_at && reviewState(r) !== 'COMMENTED')
    .filter((r) => !excludeLogin || r.user?.login !== excludeLogin)
    .map((r) => r.submitted_at as string)
    .sort();
  return candidates[0] ?? null;
}

function firstApprovalAt(reviews: RawReview[]): string | null {
  const candidates = reviews
    .filter((r) => r.submitted_at && reviewState(r) === 'APPROVED')
    .map((r) => r.submitted_at as string)
    .sort();
  return candidates[0] ?? null;
}

export class GitHubPrAdapter implements GitHubPrPort {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly instanceId: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: GitHubPrAdapterConfig) {
    this.baseUrl = (cfg.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.accessToken = cfg.accessToken;
    this.instanceId = cfg.instanceId;
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async fetchPullRequests(opts: GitHubPrFetchOpts): Promise<{
    pullRequests: GitHubPullRequestRow[];
    reviews: GitHubReviewRow[];
  }> {
    const perPage = opts.perPage ?? 100;
    const maxPages = opts.maxPages ?? 100;
    const prefixes = opts.ticketPrefixes ?? [];

    const pullRequests: GitHubPullRequestRow[] = [];
    const reviews: GitHubReviewRow[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const url = `${this.baseUrl}/repos/${opts.repoFullName}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
      const list = await this.gh<RawPr[]>(url);
      if (!Array.isArray(list) || list.length === 0) break;

      let stoppedByWatermark = false;
      for (const raw of list) {
        if (opts.since && Date.parse(raw.updated_at) < opts.since.getTime()) {
          stoppedByWatermark = true;
          break;
        }
        const detail = await this.gh<RawPr>(`${this.baseUrl}/repos/${opts.repoFullName}/pulls/${raw.number}`);
        const reviewRows = await this.gh<RawReview[]>(`${this.baseUrl}/repos/${opts.repoFullName}/pulls/${raw.number}/reviews`);
        // The AI signature (Co-Authored-By: Claude, "Generated with Claude Code",
        // 🤖) usually lives in the PR's commit trailers, not the title/body — so
        // we fetch the PR's commits and feed their messages to AI detection.
        // Tolerant: a commits-endpoint hiccup must not drop the whole PR row.
        let commitMessages: string[] = [];
        try {
          const prCommits = await this.gh<RawPrCommit[]>(
            `${this.baseUrl}/repos/${opts.repoFullName}/pulls/${raw.number}/commits?per_page=100`,
          );
          commitMessages = prCommits.map((c) => c.commit.message);
        } catch {
          commitMessages = [];
        }
        // Inline review comments, tallied per review into comment_count. Tolerant:
        // a comments-endpoint hiccup must not drop the whole PR row.
        let reviewComments: RawReviewComment[] = [];
        try {
          reviewComments = await this.gh<RawReviewComment[]>(
            `${this.baseUrl}/repos/${opts.repoFullName}/pulls/${raw.number}/comments?per_page=100`,
          );
        } catch {
          reviewComments = [];
        }
        const merged = this.transform(
          opts.repoFullName,
          detail,
          reviewRows,
          prefixes,
          commitMessages,
          reviewComments,
        );
        pullRequests.push(merged.pr);
        for (const r of merged.reviews) reviews.push(r);
      }
      if (stoppedByWatermark) break;
      if (list.length < perPage) break;
    }

    return { pullRequests, reviews };
  }

  private async gh<T>(url: string): Promise<T> {
    const resp = await this.doFetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!resp.ok) {
      throw new Error(`GitHub ${resp.status} ${resp.statusText} for ${url}`);
    }
    return (await resp.json()) as T;
  }

  private transform(
    repoFullName: string,
    pr: RawPr,
    rawReviews: RawReview[],
    prefixes: string[],
    commitMessages: string[] = [],
    reviewComments: RawReviewComment[] = [],
  ): { pr: GitHubPullRequestRow; reviews: GitHubReviewRow[] } {
    return transformGitHubPr({
      repoFullName,
      instanceId: this.instanceId,
      pr,
      rawReviews,
      prefixes,
      commitMessages,
      reviewComments,
    });
  }
}

// EI-013 — shared, pure PR transform. Maps a raw GitHub PR (+ its reviews) to
// the ClickHouse `github_pull_requests` row shape. Extracted from
// GitHubPrAdapter so the worker's bulk-tier intelligence sync handler can write
// identical full-fidelity rows (derived `state`, cycle/review/approval/merge
// times, AI detection, additions) instead of a degenerate hand-rolled mapping.
export function transformGitHubPr(args: {
  repoFullName: string;
  instanceId: string;
  pr: RawPr;
  rawReviews: RawReview[];
  prefixes: string[];
  // The PR's commit messages — AI signatures (Co-Authored-By: Claude, etc.)
  // usually live in commit trailers, not the PR title/body. Optional so the
  // worker's bulk-tier caller (which may not have them) stays compatible.
  commitMessages?: string[];
  // The PR's inline review comments (GET /pulls/{n}/comments). Tallied per review
  // to populate each review row's comment_count. Optional so callers without them
  // keep the prior behavior (count 0).
  reviewComments?: RawReviewComment[];
}): { pr: GitHubPullRequestRow; reviews: GitHubReviewRow[] } {
  const {
    repoFullName,
    instanceId,
    pr,
    rawReviews,
    prefixes,
    commitMessages = [],
    reviewComments = [],
  } = args;
  {
    const state = deriveState(pr);
    const authorLogin = pr.user?.login ?? 'unknown';

    const firstReview = firstReviewAt(rawReviews, authorLogin);
    const firstApproval = firstApprovalAt(rawReviews);

    const cycle = pr.merged_at ? hoursBetween(pr.created_at, pr.merged_at) : null;
    const review = firstReview ? hoursBetween(pr.created_at, firstReview) : null;
    const approval = firstReview && firstApproval ? hoursBetween(firstReview, firstApproval) : null;
    const merge = firstApproval && pr.merged_at ? hoursBetween(firstApproval, pr.merged_at) : null;

    const ai = detectAiAssistance({
      prTitle: pr.title,
      prBody: pr.body ?? '',
      branchName: pr.head.ref,
      authorLogin,
      commitMessages,
    });

    const linkedKeys = extractTicketKeys({
      text: `${pr.title}\n${pr.body ?? ''}`,
      branchName: pr.head.ref,
      prefixes,
      source: 'github',
    });

    const prRow: GitHubPullRequestRow = {
      id: `${repoFullName}#${pr.number}`,
      repo_full_name: repoFullName,
      number: pr.number,
      instance_id: instanceId,
      title: pr.title,
      body: pr.body ?? '',
      state,
      is_draft: pr.draft ? 1 : 0,
      base_branch: pr.base.ref,
      head_branch: pr.head.ref,
      labels: pr.labels.map((l) => l.name),
      milestone_title: pr.milestone?.title ?? null,
      author_login: authorLogin,
      author_name: null,
      requested_reviewers: pr.requested_reviewers.map((r) => r.login),
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changed_files: pr.changed_files ?? 0,
      commit_count: pr.commits ?? 0,
      created_at: chDateTimeRequired(pr.created_at),
      updated_at: chDateTimeRequired(pr.updated_at),
      merged_at: chDateTime(pr.merged_at),
      closed_at: chDateTime(pr.closed_at),
      first_review_at: chDateTime(firstReview),
      first_approval_at: chDateTime(firstApproval),
      cycle_time_hours: cycle,
      review_time_hours: review,
      approval_time_hours: approval,
      merge_time_hours: merge,
      ai_assisted: ai.aiAssisted ? 1 : 0,
      ai_confidence: ai.confidence,
      ai_signals: JSON.stringify(ai.signals),
      linked_ticket_keys: linkedKeys,
      merge_commit_sha: pr.merge_commit_sha,
      merged_by_login: pr.merged_by?.login ?? null,
    };

    // Tally inline comments per review id so each review row carries the count of
    // comments the reviewer left in it (github_reviews.comment_count was previously
    // hardcoded 0, zeroing the org-tree ranking's reviewComments metric).
    const commentCountByReview = new Map<number, number>();
    for (const c of reviewComments) {
      if (c.pull_request_review_id == null) continue;
      commentCountByReview.set(
        c.pull_request_review_id,
        (commentCountByReview.get(c.pull_request_review_id) ?? 0) + 1,
      );
    }

    const reviewRows: GitHubReviewRow[] = rawReviews
      .filter((r) => r.submitted_at !== null)
      .map((r) => ({
        id: `${repoFullName}#${pr.number}#${r.id}`,
        repo_full_name: repoFullName,
        pull_request_number: pr.number,
        pr_author_login: authorLogin,
        reviewer_login: r.user?.login ?? 'unknown',
        reviewer_name: null,
        state: r.state.toLowerCase(),
        body: r.body ?? '',
        comment_count: commentCountByReview.get(r.id) ?? 0,
        submitted_at: chDateTimeRequired(r.submitted_at as string),
      }));

    return { pr: prRow, reviews: reviewRows };
  }
}

export class FakeGitHubPrAdapter implements GitHubPrPort {
  constructor(
    private readonly seed: {
      pullRequests: GitHubPullRequestRow[];
      reviews: GitHubReviewRow[];
    },
  ) {}

  async fetchPullRequests(_opts: GitHubPrFetchOpts) {
    return this.seed;
  }
}
