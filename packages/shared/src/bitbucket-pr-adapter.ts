// Bitbucket Cloud pull requests → cockpit.bitbucket_pull_requests (+ reviews).
//
// Mirrors GitLabPrAdapter: streams one list page at a time and, per PR, reads
// `/activity` (approvals, comments, state changes) and `/diffstat` (line
// counts; answers 302, which the client follows). Rows match
// cockpit.bitbucket_pull_requests (70_bitbucket_pull_requests.sql):
// gitlab_merge_requests renamed for Bitbucket (repo_full_name, pr_id, workspace)
// plus is_release / author_uuid, without labels / milestone / assignee, which
// Bitbucket PRs do not have. `state` is Bitbucket's own upper-case value
// (OPEN | MERGED | DECLINED | SUPERSEDED), as the table documents.
//
// `is_release` — the team's flow is feat/* → `stage`, then a release PR
// `stage` → `prod`. Counting both would count every feature twice, so a PR
// whose SOURCE branch is itself long-lived is flagged and the PR/review unions
// exclude it. `hotfix/*` → `prod` is real work and stays a normal PR.
//
// Bitbucket has no `merged_at` field: the merge time is the activity `update`
// event whose state is MERGED, falling back to `updated_on` (a merged PR is
// immutable, so its last update IS the merge in every case we observed).
import { detectAiAssistance } from './ai-detection.js';
import { extractTicketKeys } from './ticket-link-extractor.js';
import { chDateTime } from './clickhouse-datetime.js';
import { bitbucketRepoPath, type BitbucketClient } from './bitbucket-api.js';
import { buildBitbucketReviews, type BitbucketReviewRow } from './bitbucket-review-adapter.js';

export interface BitbucketPrFetchOpts {
  repoFullName: string;
  /** Watermark — only PRs updated at/after this. */
  updatedAfter?: Date;
  ticketPrefixes?: string[];
  /** Bitbucket caps pullrequests at 50 per page. */
  pageLen?: number;
  maxPages?: number;
}

export interface BitbucketPullRequestRow {
  id: string;
  repo_full_name: string;
  pr_id: number;
  workspace: string;
  instance_id: string;
  title: string;
  description: string;
  /** Bitbucket's state verbatim: OPEN | MERGED | DECLINED | SUPERSEDED. */
  state: string;
  is_draft: 0 | 1;
  is_release: 0 | 1;
  source_branch: string;
  target_branch: string;
  author_username: string;
  author_name: string | null;
  author_uuid: string | null;
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

export interface BitbucketPullRequestPage {
  pullRequests: BitbucketPullRequestRow[];
  reviews: BitbucketReviewRow[];
}

export interface BitbucketPrPort {
  fetchPullRequests(opts: BitbucketPrFetchOpts): Promise<BitbucketPullRequestRow[]>;
  streamPullRequests(opts: BitbucketPrFetchOpts): AsyncGenerator<BitbucketPullRequestPage>;
}

export interface BitbucketPrAdapterConfig {
  client: BitbucketClient;
  instanceId: string;
}

const LONG_LIVED_BRANCHES = new Set([
  'stage',
  'staging',
  'develop',
  'dev',
  'main',
  'master',
  'prod',
  'production',
]);

/** True when a PR's SOURCE branch is long-lived, i.e. the PR is a release/sync PR. */
export function isReleaseBranch(source: string): boolean {
  const b = source.trim().toLowerCase();
  return LONG_LIVED_BRANCHES.has(b) || b.startsWith('release');
}

interface RawUser {
  display_name?: string | null;
  uuid?: string | null;
  nickname?: string | null;
}

interface RawPr {
  id: number;
  title: string;
  description?: string | null;
  state: string;
  draft?: boolean;
  created_on: string;
  updated_on: string;
  source: { branch: { name: string } };
  destination: { branch: { name: string } };
  author?: RawUser | null;
  closed_by?: RawUser | null;
  merge_commit?: { hash?: string } | null;
  participants?: Array<{ role: string; approved?: boolean; user?: RawUser | null }>;
}

interface RawActivity {
  update?: { state?: string; date?: string; author?: RawUser | null };
  approval?: { date?: string; user?: RawUser | null };
  comment?: { created_on?: string; user?: RawUser | null };
}

interface RawDiffstat {
  lines_added?: number | null;
  lines_removed?: number | null;
}

const login = (u: RawUser | null | undefined): string | null => u?.nickname ?? u?.display_name ?? null;

function hoursBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Number(((t2 - t1) / 3_600_000).toFixed(2));
}

function earliest(dates: Array<string | undefined>): string | null {
  let best: { iso: string; t: number } | null = null;
  for (const iso of dates) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    if (!best || t < best.t) best = { iso, t };
  }
  return best?.iso ?? null;
}

export class BitbucketPrAdapter implements BitbucketPrPort {
  private readonly client: BitbucketClient;
  private readonly instanceId: string;

  constructor(cfg: BitbucketPrAdapterConfig) {
    this.client = cfg.client;
    this.instanceId = cfg.instanceId;
  }

  async *streamPullRequests(opts: BitbucketPrFetchOpts): AsyncGenerator<BitbucketPullRequestPage> {
    const repoPath = bitbucketRepoPath(opts.repoFullName);
    const prefixes = opts.ticketPrefixes ?? [];
    const params = new URLSearchParams();
    for (const s of ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']) params.append('state', s);
    params.set('sort', '-updated_on');
    params.set('pagelen', String(opts.pageLen ?? 50));
    if (opts.updatedAfter) params.set('q', `updated_on>="${opts.updatedAfter.toISOString()}"`);

    for await (const list of this.client.paginate<RawPr>(
      `${repoPath}/pullrequests?${params.toString()}`,
      {},
      { maxPages: opts.maxPages ?? 200 },
    )) {
      const pullRequests: BitbucketPullRequestRow[] = [];
      const reviews: BitbucketReviewRow[] = [];
      for (const pr of list) {
        const activity = await this.collect<RawActivity>(`${repoPath}/pullrequests/${pr.id}/activity`, {
          pagelen: '50',
        });
        const diffstat = await this.collect<RawDiffstat>(`${repoPath}/pullrequests/${pr.id}/diffstat`);
        const authorLogin = login(pr.author) ?? '';
        const approvals = activity
          .filter((a) => a.approval?.date && login(a.approval.user))
          .map((a) => ({
            username: login(a.approval!.user)!,
            uuid: a.approval!.user?.uuid ?? null,
            name: a.approval!.user?.display_name ?? null,
            date: a.approval!.date!,
          }));
        const comments = activity
          .filter((a) => a.comment?.created_on && login(a.comment.user))
          .map((a) => ({
            username: login(a.comment!.user)!,
            uuid: a.comment!.user?.uuid ?? null,
            name: a.comment!.user?.display_name ?? null,
            createdAt: a.comment!.created_on!,
          }));
        pullRequests.push(
          this.transform(opts.repoFullName, pr, activity, approvals, comments, diffstat, prefixes),
        );
        reviews.push(
          ...buildBitbucketReviews({
            repoFullName: opts.repoFullName,
            instanceId: this.instanceId,
            prId: pr.id,
            prAuthorUsername: authorLogin,
            approvals,
            comments,
          }),
        );
      }
      yield { pullRequests, reviews };
    }
  }

  async fetchPullRequests(opts: BitbucketPrFetchOpts): Promise<BitbucketPullRequestRow[]> {
    const rows: BitbucketPullRequestRow[] = [];
    for await (const page of this.streamPullRequests(opts)) rows.push(...page.pullRequests);
    return rows;
  }

  private async collect<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.client.paginate<T>(path, params, { maxPages: 50 })) out.push(...page);
    return out;
  }

  private transform(
    repoFullName: string,
    pr: RawPr,
    activity: RawActivity[],
    approvals: Array<{ username: string; date: string }>,
    comments: Array<{ username: string; createdAt: string }>,
    diffstat: RawDiffstat[],
    prefixes: string[],
  ): BitbucketPullRequestRow {
    const state = pr.state.toUpperCase();
    const authorLogin = login(pr.author) ?? '';
    const sourceBranch = pr.source.branch.name;

    const closingEvent = activity.find(
      (a) => a.update?.state === pr.state && a.update.date && state !== 'OPEN',
    )?.update;
    const closedAtIso = state === 'OPEN' ? null : (closingEvent?.date ?? pr.updated_on);
    const mergedAtIso = state === 'MERGED' ? closedAtIso : null;
    const mergedBy =
      state === 'MERGED' ? (login(closingEvent?.author) ?? login(pr.closed_by)) : null;

    const byOthers = <T extends { username: string }>(xs: T[]) =>
      xs.filter((x) => x.username !== authorLogin);
    const firstApprovalIso = earliest(byOthers(approvals).map((a) => a.date));
    const firstReviewIso = earliest([
      ...byOthers(approvals).map((a) => a.date),
      ...byOthers(comments).map((c) => c.createdAt),
    ]);

    const ai = detectAiAssistance({
      prTitle: pr.title,
      prBody: pr.description ?? '',
      branchName: sourceBranch,
      authorLogin,
    });
    const linkedKeys = extractTicketKeys({
      text: `${pr.title}\n${pr.description ?? ''}`,
      branchName: sourceBranch,
      prefixes,
      source: 'bitbucket',
    });

    return {
      id: `${repoFullName}#${pr.id}`,
      repo_full_name: repoFullName,
      pr_id: pr.id,
      workspace: repoFullName.split('/')[0]!,
      instance_id: this.instanceId,
      title: pr.title,
      description: pr.description ?? '',
      state,
      is_draft: pr.draft ? 1 : 0,
      is_release: isReleaseBranch(sourceBranch) ? 1 : 0,
      source_branch: sourceBranch,
      target_branch: pr.destination.branch.name,
      author_username: authorLogin,
      author_name: pr.author?.display_name ?? null,
      author_uuid: pr.author?.uuid ?? null,
      reviewers: (pr.participants ?? [])
        .filter((p) => p.role === 'REVIEWER')
        .map((p) => login(p.user))
        .filter((l): l is string => l !== null),
      additions: diffstat.reduce((n, d) => n + (d.lines_added ?? 0), 0),
      deletions: diffstat.reduce((n, d) => n + (d.lines_removed ?? 0), 0),
      changed_files: diffstat.length,
      created_at: chDateTime(pr.created_on) ?? '',
      updated_at: chDateTime(pr.updated_on) ?? '',
      merged_at: chDateTime(mergedAtIso),
      closed_at: chDateTime(closedAtIso),
      first_review_at: chDateTime(firstReviewIso),
      first_approval_at: chDateTime(firstApprovalIso),
      cycle_time_hours: hoursBetween(pr.created_on, mergedAtIso),
      review_time_hours: hoursBetween(pr.created_on, firstReviewIso),
      ai_assisted: ai.aiAssisted ? 1 : 0,
      ai_confidence: ai.confidence,
      ai_signals: JSON.stringify(ai.signals),
      linked_ticket_keys: linkedKeys,
      merged_by_username: mergedBy,
      merge_commit_sha: state === 'MERGED' ? (pr.merge_commit?.hash ?? null) : null,
    };
  }
}

export class FakeBitbucketPrAdapter implements BitbucketPrPort {
  constructor(
    private readonly seed: BitbucketPullRequestRow[],
    private readonly reviews: BitbucketReviewRow[] = [],
  ) {}
  async fetchPullRequests(_opts: BitbucketPrFetchOpts) {
    return this.seed;
  }
  async *streamPullRequests(_opts: BitbucketPrFetchOpts): AsyncGenerator<BitbucketPullRequestPage> {
    yield { pullRequests: this.seed, reviews: this.reviews };
  }
}
