// EI-005 — GitLabPrAdapter (Merge Requests).
import { detectAiAssistance } from './ai-detection.js';
import { extractTicketKeys } from './ticket-link-extractor.js';
import { gitlabApiBase } from './gitlab-api-base.js';
import { buildGitLabReviews, type GitLabReviewRow } from './gitlab-review-adapter.js';

export interface GitLabPrFetchOpts {
  projectPath: string;
  updatedAfter?: Date;
  ticketPrefixes?: string[];
  perPage?: number;
  maxPages?: number;
}

export interface GitLabMergeRequestRow {
  id: string;
  project_path: string;
  iid: number;
  instance_id: string;
  title: string;
  description: string;
  state: string;
  is_draft: 0 | 1;
  source_branch: string;
  target_branch: string;
  labels: string[];
  milestone_title: string | null;
  author_username: string;
  author_name: string | null;
  assignee_username: string | null;
  reviewers: string[];
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  first_review_at: string | null;
  first_approval_at: string | null;
  cycle_time_hours: number | null;
  review_time_hours: number | null;
  ai_assisted: 0 | 1;
  ai_confidence: number | null;
  ai_signals: string;
  linked_ticket_keys: string[];
  merged_by_username: string | null;
  merge_commit_sha: string | null;
}

export interface GitLabMergeRequestPage {
  mergeRequests: GitLabMergeRequestRow[];
  reviews: GitLabReviewRow[];
}

export interface GitLabPrPort {
  /** Buffers all pages — convenience for callers that want the whole set. */
  fetchMergeRequests(opts: GitLabPrFetchOpts): Promise<GitLabMergeRequestRow[]>;
  /** Yields one page at a time so the sync worker never buffers a project's
   *  full MR set in memory (mirrors the ADO adapter's streamWorkItems).
   *  Each page co-emits the review rows derived from the approvals + notes
   *  already fetched for that page's MRs. */
  streamMergeRequests(opts: GitLabPrFetchOpts): AsyncGenerator<GitLabMergeRequestPage>;
}

interface GitLabPrAdapterConfig {
  accessToken: string;
  baseUrl?: string;
  instanceId: string;
  fetchFn?: typeof fetch;
}

interface RawMr {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  labels: string[];
  milestone: { title: string } | null;
  author: { username: string; name?: string };
  assignee: { username: string } | null;
  reviewers: Array<{ username: string }>;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  merged_by: { username: string } | null;
  merge_commit_sha: string | null;
  changes_count?: string;
  diff_stats?: { additions: number; deletions: number };
}

interface RawApprovals {
  approved_by: Array<{ user: { username: string; name?: string } }>;
}

interface RawNote {
  system: boolean;
  body: string;
  author: { username: string; name?: string };
  created_at: string;
}

function hoursBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Number(((t2 - t1) / 3_600_000).toFixed(2));
}

function encodeProjectPath(p: string): string {
  return p.includes('%2F') ? p : encodeURIComponent(p);
}

export class GitLabPrAdapter implements GitLabPrPort {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly instanceId: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: GitLabPrAdapterConfig) {
    this.baseUrl = gitlabApiBase(cfg.baseUrl ?? 'https://gitlab.com/api/v4');
    this.accessToken = cfg.accessToken;
    this.instanceId = cfg.instanceId;
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async *streamMergeRequests(opts: GitLabPrFetchOpts): AsyncGenerator<GitLabMergeRequestPage> {
    const perPage = opts.perPage ?? 100;
    const maxPages = opts.maxPages ?? 100;
    const prefixes = opts.ticketPrefixes ?? [];
    const path = encodeProjectPath(opts.projectPath);

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({
        state: 'all',
        order_by: 'updated_at',
        sort: 'desc',
        per_page: String(perPage),
        page: String(page),
      });
      if (opts.updatedAfter) params.set('updated_after', opts.updatedAfter.toISOString());
      const url = `${this.baseUrl}/projects/${path}/merge_requests?${params.toString()}`;
      const list = await this.gl<RawMr[]>(url);
      if (!Array.isArray(list) || list.length === 0) break;
      const mergeRequests: GitLabMergeRequestRow[] = [];
      const reviews: GitLabReviewRow[] = [];
      for (const mr of list) {
        const approvals = await this.gl<RawApprovals>(
          `${this.baseUrl}/projects/${path}/merge_requests/${mr.iid}/approvals`,
        );
        const notes = await this.gl<RawNote[]>(
          `${this.baseUrl}/projects/${path}/merge_requests/${mr.iid}/notes?per_page=100&sort=asc&order_by=created_at`,
        );
        mergeRequests.push(this.transform(opts.projectPath, mr, approvals, notes, prefixes));
        reviews.push(
          ...buildGitLabReviews({
            projectPath: opts.projectPath,
            instanceId: this.instanceId,
            mrIid: mr.iid,
            mrAuthorUsername: mr.author.username,
            approvedBy: approvals.approved_by.map((a) => ({
              username: a.user.username,
              name: a.user.name,
            })),
            notes: notes.map((n) => ({
              system: n.system,
              body: n.body,
              authorUsername: n.author.username,
              authorName: n.author.name,
              createdAt: n.created_at,
            })),
          }),
        );
      }
      yield { mergeRequests, reviews };
      if (list.length < perPage) break;
    }
  }

  async fetchMergeRequests(opts: GitLabPrFetchOpts): Promise<GitLabMergeRequestRow[]> {
    const rows: GitLabMergeRequestRow[] = [];
    for await (const page of this.streamMergeRequests(opts)) rows.push(...page.mergeRequests);
    return rows;
  }

  private async gl<T>(url: string): Promise<T> {
    const resp = await this.doFetch(url, {
      headers: {
        'PRIVATE-TOKEN': this.accessToken,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) throw new Error(`GitLab ${resp.status} ${resp.statusText} for ${url}`);
    return (await resp.json()) as T;
  }

  private transform(
    projectPath: string,
    mr: RawMr,
    approvals: RawApprovals,
    notes: RawNote[],
    prefixes: string[],
  ): GitLabMergeRequestRow {
    const isDraft: 0 | 1 = mr.draft || mr.work_in_progress ? 1 : 0;
    const firstReview =
      notes.find((n) => !n.system && n.author.username !== mr.author.username)?.created_at ?? null;
    const firstApproval =
      approvals.approved_by.length > 0
        ? notes.find((n) => n.system && /\bapproved\b/i.test(n.body))?.created_at ?? null
        : null;

    const cycle = mr.merged_at ? hoursBetween(mr.created_at, mr.merged_at) : null;
    const review = firstReview ? hoursBetween(mr.created_at, firstReview) : null;

    const ai = detectAiAssistance({
      prTitle: mr.title,
      prBody: mr.description ?? '',
      branchName: mr.source_branch,
      authorLogin: mr.author.username,
    });
    const linkedKeys = extractTicketKeys({
      text: `${mr.title}\n${mr.description ?? ''}`,
      branchName: mr.source_branch,
      prefixes,
      source: 'gitlab',
    });

    return {
      id: `${projectPath}!${mr.iid}`,
      project_path: projectPath,
      iid: mr.iid,
      instance_id: this.instanceId,
      title: mr.title,
      description: mr.description ?? '',
      state: mr.state,
      is_draft: isDraft,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      labels: mr.labels,
      milestone_title: mr.milestone?.title ?? null,
      author_username: mr.author.username,
      author_name: mr.author.name ?? null,
      assignee_username: mr.assignee?.username ?? null,
      reviewers: mr.reviewers.map((r) => r.username),
      additions: mr.diff_stats?.additions ?? 0,
      deletions: mr.diff_stats?.deletions ?? 0,
      changed_files: mr.changes_count ? Number(mr.changes_count) || 0 : 0,
      created_at: mr.created_at,
      updated_at: mr.updated_at,
      merged_at: mr.merged_at,
      closed_at: mr.closed_at,
      first_review_at: firstReview,
      first_approval_at: firstApproval,
      cycle_time_hours: cycle,
      review_time_hours: review,
      ai_assisted: ai.aiAssisted ? 1 : 0,
      ai_confidence: ai.confidence,
      ai_signals: JSON.stringify(ai.signals),
      linked_ticket_keys: linkedKeys,
      merged_by_username: mr.merged_by?.username ?? null,
      merge_commit_sha: mr.merge_commit_sha,
    };
  }
}

export class FakeGitLabPrAdapter implements GitLabPrPort {
  constructor(private readonly seed: GitLabMergeRequestRow[]) {}
  async fetchMergeRequests(_opts: GitLabPrFetchOpts) {
    return this.seed;
  }
  async *streamMergeRequests(_opts: GitLabPrFetchOpts): AsyncGenerator<GitLabMergeRequestPage> {
    yield { mergeRequests: this.seed, reviews: [] };
  }
}
