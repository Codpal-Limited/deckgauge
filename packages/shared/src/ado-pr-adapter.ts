// EI-007 — AdoPrAdapter.
import { detectAiAssistance } from './ai-detection.js';
import { extractTicketKeys } from './ticket-link-extractor.js';
import { chDateTime, chDateTimeRequired } from './clickhouse-datetime.js';
import { resilientFetchJson } from './resilient-fetch.js';
import type { Throttle } from './request-throttle.js';

export interface AdoPrFetchOpts {
  project: string;
  repoIds?: string[];
  since?: Date;
  /**
   * Upper bound on PR creation time. Set only for backfill, where history is
   * walked backwards in bounded [since, until) chunks so each chunk terminates
   * inside the per-repo timeout. When set, a single `created`-range sweep runs
   * (see fetchPullRequests) instead of the incremental created+closed pair.
   */
  until?: Date;
  ticketPrefixes?: string[];
  pageSize?: number;
  maxPages?: number;
}

export interface AdoPullRequestRow {
  id: string;
  pr_id: number;
  org_url: string;
  project: string;
  repo_name: string;
  title: string;
  description: string;
  status: string;
  is_draft: 0 | 1;
  source_branch: string;
  target_branch: string;
  labels: string[];
  created_by_login: string;
  created_by_name: string | null;
  reviewers: string[];
  additions: number;
  deletions: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  first_vote_at: string | null;
  cycle_time_hours: number | null;
  review_time_hours: number | null;
  ai_assisted: 0 | 1;
  ai_confidence: number | null;
  ai_signals: string;
  linked_ticket_keys: string[];
  instance_id: string;
}

export interface AdoReviewRow {
  id: string;
  org_url: string;
  project: string;
  repo_id: string;
  repo_name: string;
  pull_request_id: number;
  pr_author_login: string;
  reviewer_login: string;
  reviewer_name: string | null;
  vote: number;
  state: string;
  body: string;
  comment_count: number;
  submitted_at: string;
  instance_id: string;
}

export interface AdoPrFetchResult {
  pullRequests: AdoPullRequestRow[];
  reviews: AdoReviewRow[];
  /**
   * Non-fatal degradations, e.g. a PR whose work-item links could not be read.
   * The caller is expected to log these — they are never silently dropped, but
   * they must not cost us the PR row itself.
   */
  warnings?: string[];
}

export interface AdoPrPort {
  fetchPullRequests(opts: AdoPrFetchOpts): Promise<AdoPrFetchResult>;
}

interface AdoPrAdapterConfig {
  orgUrl: string;
  authMethod: 'PAT' | 'BASIC';
  accessToken: string;
  username?: string;
  instanceId: string;
  fetchFn?: typeof fetch;
  /**
   * Optional client-side pacing, shared with the other ADO adapters so all ADO
   * traffic spends one account-wide budget. Omitted in tests.
   */
  throttle?: Throttle;
}

interface RawRepo {
  id: string;
  name: string;
}

interface RawIdentity {
  displayName: string;
  uniqueName?: string;
}

interface RawPr {
  pullRequestId: number;
  repository: RawRepo;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  sourceRefName: string;
  targetRefName: string;
  creationDate: string;
  closedDate?: string;
  labels?: Array<{ name: string; active?: boolean }>;
  createdBy?: RawIdentity;
  reviewers?: Array<RawIdentity & { vote: number; votedFor?: Array<{ value: number; timestamp: string }> }>;
}

// `/pullRequests/{id}/workitems` returns bare refs: { id, url }. The id is the
// work item's numeric ADO id as a string.
interface RawWorkItemRef {
  id?: string | number;
}

interface RawThreadProperty {
  $type?: string;
  $value?: string | number;
}

interface RawThread {
  publishedDate: string;
  isDeleted?: boolean;
  status?: string;
  comments?: Array<{ commentType?: string; publishedDate: string; author?: RawIdentity }>;
  properties?: Record<string, RawThreadProperty | undefined>;
}

// ADO exposes per-reviewer vote timestamps ONLY through system threads with
// properties.CodeReviewThreadType === 'VoteUpdate'. `reviewer.votedFor` is
// for delegated group votes (rare), so reading only that field misses
// reviews entirely. Returns the earliest vote thread's publishedDate.
function firstVoteAtFromThreads(threads: RawThread[]): string | null {
  const votes: string[] = [];
  for (const t of threads) {
    if (t.isDeleted) continue;
    const threadType = t.properties?.['CodeReviewThreadType']?.$value;
    if (threadType !== 'VoteUpdate') continue;
    if (typeof t.publishedDate === 'string') votes.push(t.publishedDate);
  }
  if (votes.length === 0) return null;
  return votes.sort()[0] ?? null;
}

function authHeader(cfg: AdoPrAdapterConfig): string {
  const raw = cfg.authMethod === 'BASIC' ? `${cfg.username ?? ''}:${cfg.accessToken}` : `:${cfg.accessToken}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function hoursBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Number(((t2 - t1) / 3_600_000).toFixed(2));
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

function voteToState(vote: number): string {
  if (vote >= 10) return 'approved';
  if (vote >= 5) return 'approved-with-suggestions';
  if (vote <= -10) return 'rejected';
  if (vote <= -5) return 'waiting-for-author';
  return 'no-vote';
}

export class AdoPrAdapter implements AdoPrPort {
  private readonly cfg: AdoPrAdapterConfig;
  private readonly orgUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: AdoPrAdapterConfig) {
    this.cfg = cfg;
    this.orgUrl = cfg.orgUrl.replace(/\/+$/, '');
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async fetchPullRequests(opts: AdoPrFetchOpts): Promise<AdoPrFetchResult> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? 100;
    const prefixes = opts.ticketPrefixes ?? [];
    const projectEnc = encodeURIComponent(opts.project);

    let repoIds: string[];
    if (opts.repoIds === undefined) {
      const repos = await this.ado<{ value: RawRepo[] }>(
        `${this.orgUrl}/${projectEnc}/_apis/git/repositories?api-version=7.1`,
      );
      repoIds = repos.value.map((r) => r.id);
    } else if (opts.repoIds.length === 0) {
      return { pullRequests: [], reviews: [] };
    } else {
      repoIds = opts.repoIds;
    }

    const pullRequests: AdoPullRequestRow[] = [];
    const reviews: AdoReviewRow[] = [];
    const warnings: string[] = [];
    for (const repoId of repoIds) {
      // An incremental run must sweep TWO time ranges. ADO applies
      // searchCriteria.minTime against queryTimeRangeType, which defaults to
      // `created` — so a created-only sweep never returns a PR opened before
      // the watermark, even after it merges. Those rows freeze in the state
      // they had at first capture: status stays 'active', closedDate stays
      // null, and because pullRequestsUnion synthesises merged_at from
      // status='completed', they silently vanish from deploy frequency, lead
      // time, PR cycle time and merge frequency. The `closed` sweep is what
      // brings the late merges (and abandonments) back.
      //
      // A first run has no watermark and must not be time-filtered at all —
      // one untimed sweep backfills the full history.
      //
      // Backfill mode (`until` set) walks a bounded window of history and needs
      // only the created range: every PR opened in the window comes back with
      // whatever state it holds now.
      const timeRanges: Array<'created' | 'closed' | null> = opts.until
        ? ['created']
        : opts.since
          ? ['created', 'closed']
          : [null];

      // Both sweeps return a PR that was created AND closed inside the window.
      // Dedupe by pullRequestId BEFORE fetching threads: threads are one
      // request per PR (the expensive N+1 in this adapter), so deduping after
      // would double the request cost of every incremental run.
      const rawById = new Map<number, RawPr>();
      for (const range of timeRanges) {
        for (let page = 0; page < maxPages; page++) {
          const params = new URLSearchParams({
            'api-version': '7.1',
            'searchCriteria.status': 'all',
            'searchCriteria.repositoryId': repoId,
            $top: String(pageSize),
            $skip: String(page * pageSize),
          });
          if (opts.since && range) {
            params.set('searchCriteria.queryTimeRangeType', range);
            params.set('searchCriteria.minTime', opts.since.toISOString());
            if (opts.until) params.set('searchCriteria.maxTime', opts.until.toISOString());
          }
          const url = `${this.orgUrl}/${projectEnc}/_apis/git/pullrequests?${params.toString()}`;
          const list = await this.ado<{ value: RawPr[] }>(url);
          if (!list.value || list.value.length === 0) break;
          for (const pr of list.value) rawById.set(pr.pullRequestId, pr);
          if (list.value.length < pageSize) break;
        }
      }

      for (const pr of rawById.values()) {
        const threads = await this.ado<{ value: RawThread[] }>(
          `${this.orgUrl}/${projectEnc}/_apis/git/repositories/${pr.repository.id}/pullRequests/${pr.pullRequestId}/threads?api-version=7.1`,
        );
        // ADO links work items to PRs relationally — the ids are not in the PR
        // title, body or branch name, so text extraction alone reports 0%
        // ticket coverage on every ADO board. This relation is the real signal.
        //
        // Best-effort: a PAT scoped without work-item read, or a permanent 403
        // on one project, must not cost us the PR row (which carries every
        // merge-based metric). Degrade to text extraction and report why.
        let workItemRefs: RawWorkItemRef[] = [];
        try {
          const workItems = await this.ado<{ value: RawWorkItemRef[] }>(
            `${this.orgUrl}/${projectEnc}/_apis/git/repositories/${pr.repository.id}/pullRequests/${pr.pullRequestId}/workitems?api-version=7.1`,
          );
          workItemRefs = workItems.value ?? [];
        } catch (err) {
          warnings.push(
            `work-item links unavailable for ${opts.project} PR #${pr.pullRequestId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        pullRequests.push(
          this.transform(opts.project, pr, threads.value, prefixes, workItemRefs),
        );
        for (const review of this.extractReviews(opts.project, pr, threads.value)) {
          reviews.push(review);
        }
      }
    }
    return warnings.length > 0 ? { pullRequests, reviews, warnings } : { pullRequests, reviews };
  }

  private extractReviews(project: string, pr: RawPr, threads: RawThread[]): AdoReviewRow[] {
    if (!pr.reviewers || pr.reviewers.length === 0) return [];
    const author = pr.createdBy?.uniqueName ?? pr.createdBy?.displayName ?? 'unknown';
    const commentCountByAuthor = new Map<string, number>();
    for (const thread of threads) {
      if (thread.isDeleted) continue;
      for (const c of thread.comments ?? []) {
        if (c.commentType && c.commentType !== 'text') continue;
        const key = c.author?.uniqueName ?? c.author?.displayName ?? '';
        if (!key) continue;
        commentCountByAuthor.set(key, (commentCountByAuthor.get(key) ?? 0) + 1);
      }
    }
    const out: AdoReviewRow[] = [];
    for (const r of pr.reviewers) {
      const reviewerLogin = r.uniqueName ?? r.displayName;
      const votedAt = (r.votedFor ?? [])
        .map((v) => v.timestamp)
        .filter((t): t is string => typeof t === 'string')
        .sort()
        .slice(-1)[0];
      out.push({
        id: `${this.orgUrl}/${project}#${pr.pullRequestId}#${reviewerLogin}`,
        org_url: this.orgUrl,
        project,
        repo_id: pr.repository.id,
        repo_name: pr.repository.name,
        pull_request_id: pr.pullRequestId,
        pr_author_login: author,
        reviewer_login: reviewerLogin,
        reviewer_name: r.displayName ?? null,
        vote: r.vote,
        state: voteToState(r.vote),
        body: '',
        comment_count: commentCountByAuthor.get(reviewerLogin) ?? 0,
        submitted_at: chDateTimeRequired(votedAt ?? pr.creationDate),
        instance_id: this.cfg.instanceId,
      });
    }
    return out;
  }

  private async ado<T>(url: string): Promise<T> {
    await this.cfg.throttle?.acquire();
    const r = await resilientFetchJson<T>(
      this.doFetch,
      url,
      {
        headers: {
          Authorization: authHeader(this.cfg),
          Accept: 'application/json',
        },
      },
      {
        // Feed the server's own backoff instruction back into the shared
        // throttle so the OTHER ADO sync slows down too — both spend the same
        // account budget.
        onThrottled: ({ waitMs }) => this.cfg.throttle?.backOff(waitMs),
      },
    );
    if (!r.ok) throw new Error(`ADO ${r.status} ${r.statusText} for ${url}`);
    return r.data as T;
  }

  private transform(
    project: string,
    pr: RawPr,
    threads: RawThread[],
    prefixes: string[],
    workItemRefs: RawWorkItemRef[],
  ): AdoPullRequestRow {
    const isDraft: 0 | 1 = pr.isDraft ? 1 : 0;
    const updatedAt =
      threads
        .map((t) => t.publishedDate)
        .filter((d): d is string => typeof d === 'string')
        .sort()
        .slice(-1)[0] ?? pr.creationDate;

    const delegatedVoteAt =
      pr.reviewers
        ?.flatMap((r) => (r.votedFor ?? []).map((v) => v.timestamp))
        .filter((t): t is string => typeof t === 'string')
        .sort()[0] ?? null;
    const threadVoteAt = firstVoteAtFromThreads(threads);
    const candidates = [threadVoteAt, delegatedVoteAt].filter(
      (t): t is string => typeof t === 'string',
    );
    const firstVoteAt = candidates.length > 0 ? candidates.sort()[0]! : null;

    const cycle = pr.status === 'completed' ? hoursBetween(pr.creationDate, pr.closedDate ?? null) : null;
    const review = firstVoteAt ? hoursBetween(pr.creationDate, firstVoteAt) : null;

    const source = branchName(pr.sourceRefName);
    const target = branchName(pr.targetRefName);
    const author = pr.createdBy?.uniqueName ?? pr.createdBy?.displayName ?? 'unknown';

    const ai = detectAiAssistance({
      prTitle: pr.title,
      prBody: pr.description ?? '',
      branchName: source,
      authorLogin: author,
    });
    // Work-item ids are emitted bare (e.g. '13614') to match
    // projects.ado_work_item_id, so the existing
    // has(linked_ticket_keys, {key}) timeline lookup resolves against a board
    // row's ADO id without any extra mapping. Prefix-extracted keys stay as a
    // second source for teams that do write 'BWAY-7' in PR titles.
    const workItemKeys = workItemRefs
      .map((ref) => (ref.id == null ? '' : String(ref.id).trim()))
      .filter((id) => id.length > 0);
    const linkedKeys = Array.from(
      new Set([
        ...workItemKeys,
        ...extractTicketKeys({
          text: `${pr.title}\n${pr.description ?? ''}`,
          branchName: source,
          prefixes,
          source: 'ado',
        }),
      ]),
    ).sort();

    return {
      id: `${this.orgUrl}/${project}#${pr.pullRequestId}`,
      pr_id: pr.pullRequestId,
      org_url: this.orgUrl,
      project,
      repo_name: pr.repository.name,
      title: pr.title,
      description: pr.description ?? '',
      status: pr.status,
      is_draft: isDraft,
      source_branch: source,
      target_branch: target,
      labels: (pr.labels ?? []).filter((l) => l.active !== false).map((l) => l.name),
      created_by_login: author,
      created_by_name: pr.createdBy?.displayName ?? null,
      reviewers: (pr.reviewers ?? []).map((r) => r.uniqueName ?? r.displayName),
      additions: 0,
      deletions: 0,
      created_at: chDateTimeRequired(pr.creationDate),
      updated_at: chDateTimeRequired(updatedAt),
      closed_at: chDateTime(pr.closedDate ?? null),
      first_vote_at: chDateTime(firstVoteAt),
      cycle_time_hours: cycle,
      review_time_hours: review,
      ai_assisted: ai.aiAssisted ? 1 : 0,
      ai_confidence: ai.confidence,
      ai_signals: JSON.stringify(ai.signals),
      linked_ticket_keys: linkedKeys,
      instance_id: this.cfg.instanceId,
    };
  }
}

export class FakeAdoPrAdapter implements AdoPrPort {
  constructor(private readonly seed: AdoPullRequestRow[] | AdoPrFetchResult) {}
  async fetchPullRequests(_opts: AdoPrFetchOpts): Promise<AdoPrFetchResult> {
    if (Array.isArray(this.seed)) return { pullRequests: this.seed, reviews: [] };
    return this.seed;
  }
}
