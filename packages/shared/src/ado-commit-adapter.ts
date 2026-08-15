// EI-007b — AdoCommitAdapter. Fetches commits across all branches of one repo.
import { detectAiAssistance } from './ai-detection';
import { extractTicketKeys } from './ticket-link-extractor';
import { chDateTimeRequired } from './clickhouse-datetime';
import { resilientFetchJson } from './resilient-fetch';
import type { Throttle } from './request-throttle';

export interface AdoCommitFetchOpts {
  project: string;
  repoId: string;
  repoName: string;
  since?: Date;
  ticketPrefixes?: string[];
  pageSize?: number;
  maxPagesPerBranch?: number;
  maxBranches?: number;
  // Branch selection (EI commit-sync fix). The repo's default branch is ALWAYS
  // synced — it can sort past any cap in ADO's alphabetical ref order, and it is
  // where merged work lands. `activeSince` additionally restricts the remaining
  // branches to those with a commit at/after the cutoff, so dead feature
  // branches are skipped. When `activeSince` is omitted, all branches qualify.
  defaultBranch?: string;
  activeSince?: Date;
  /**
   * Upper bound on commit time. Set only for backfill, where history is walked
   * backwards in bounded [since, until) chunks so each chunk terminates inside
   * the per-repo timeout.
   */
  until?: Date;
}

export interface AdoCommitRow {
  id: string;
  sha: string;
  org_url: string;
  project: string;
  repo_id: string;
  repo_name: string;
  repo_url: string;
  instance_id: string;
  author_login: string | null;
  author_name: string;
  author_email: string;
  committer_name: string;
  committer_email: string;
  message: string;
  message_subject: string;
  additions: number;
  deletions: number;
  changed_files: number;
  branch: string | null;
  pull_request_id: number | null;
  is_merge_commit: 0 | 1;
  committed_at: string;
  ai_assisted: 0 | 1;
  ai_confidence: number | null;
  ai_signals: string;
  linked_ticket_keys: string[];
}

export interface AdoCommitPort {
  fetchCommits(opts: AdoCommitFetchOpts): Promise<AdoCommitRow[]>;
}

interface AdoCommitAdapterConfig {
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

interface RawBranchStat {
  name: string;
  commit?: { committer?: { date?: string }; author?: { date?: string } };
}
interface RawCommit {
  commitId: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  comment: string;
  parents?: string[];
  changeCounts?: { Add?: number; Edit?: number; Delete?: number };
}
interface RawCommitChanges { changes?: Array<unknown>; }

function authHeader(cfg: AdoCommitAdapterConfig): string {
  const raw = cfg.authMethod === 'BASIC' ? `${cfg.username ?? ''}:${cfg.accessToken}` : `:${cfg.accessToken}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function branchFromRef(refName: string): string {
  return refName.replace(/^refs\/heads\//, '');
}

export class AdoCommitAdapter implements AdoCommitPort {
  private readonly cfg: AdoCommitAdapterConfig;
  private readonly orgUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: AdoCommitAdapterConfig) {
    this.cfg = cfg;
    this.orgUrl = cfg.orgUrl.replace(/\/+$/, '');
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async fetchCommits(opts: AdoCommitFetchOpts): Promise<AdoCommitRow[]> {
    const pageSize = opts.pageSize ?? 100;
    const maxPagesPerBranch = opts.maxPagesPerBranch ?? 50;
    const maxBranches = opts.maxBranches ?? 500;
    const prefixes = opts.ticketPrefixes ?? [];
    const projectEnc = encodeURIComponent(opts.project);
    const repoUrl = `${this.orgUrl}/${projectEnc}/_apis/git/repositories/${opts.repoId}`;

    const branches = await this.selectBranches(repoUrl, opts, maxBranches);

    // Commit-time floor. Prefer the incremental watermark; on a backfill
    // (no `since`) fall back to `activeSince` so we pull the recent window
    // rather than every branch's entire history — the latter is unbounded and
    // never completes inside the job lock on a large repo.
    const commitsSince = opts.since ?? opts.activeSince;

    const seen = new Map<string, AdoCommitRow>();
    for (const branch of branches) {
      for (let page = 0; page < maxPagesPerBranch; page++) {
        const params = new URLSearchParams({
          'api-version': '7.1',
          'searchCriteria.itemVersion.version': branch,
          'searchCriteria.itemVersion.versionType': 'branch',
          $top: String(pageSize),
          $skip: String(page * pageSize),
        });
        if (commitsSince) params.set('searchCriteria.fromDate', commitsSince.toISOString());
        if (opts.until) params.set('searchCriteria.toDate', opts.until.toISOString());
        const list = await this.ado<{ value: RawCommit[] }>(`${repoUrl}/commits?${params.toString()}`);
        if (!list.value || list.value.length === 0) break;
        for (const raw of list.value) {
          if (seen.has(raw.commitId)) continue;
          seen.set(raw.commitId, await this.transform(opts, raw, branch, repoUrl, prefixes));
        }
        if (list.value.length < pageSize) break;
      }
    }
    return Array.from(seen.values());
  }

  // Select which branches to sync via the one-call `stats/branches` endpoint
  // (returns every branch WITH its last-commit date — no per-branch fetch). The
  // default branch is always included; the rest are kept only when active since
  // `opts.activeSince`. Survivors are sorted newest-first so a `maxBranches` cap
  // keeps the most recently active branches rather than an alphabetical prefix.
  private async selectBranches(
    repoUrl: string,
    opts: AdoCommitFetchOpts,
    maxBranches: number,
  ): Promise<string[]> {
    // A repository with no commits answers this endpoint with 400, not an empty
    // list, and that 400 used to fail the whole repo. The cost was not the
    // handful of commits it did not find: the sync handler's per-repo catch
    // fires BEFORE the watermark upsert, so such a repo never got a sync-state
    // row — and with no watermark its next pass ran the PR sweep untimed (full
    // history) and 400'd again, every hour, forever. Three repos on one install
    // were in that loop, all with zero refs upstream.
    //
    // Deliberately narrow: ONLY branch enumeration tolerates a 400, and only by
    // returning no branches. A 400 from the commits endpoint stays fatal —
    // silently reporting zero commits there would be indistinguishable from a
    // genuinely quiet repo.
    const stats = await this.adoAllowEmpty<{ value: RawBranchStat[] }>(
      `${repoUrl}/stats/branches?api-version=7.1`,
    );
    if (stats === null) return [];
    const def = opts.defaultBranch ? branchFromRef(opts.defaultBranch) : null;
    const activeSinceMs = opts.activeSince ? opts.activeSince.getTime() : null;

    const dateOf = (b: RawBranchStat): number => {
      const raw = b.commit?.committer?.date ?? b.commit?.author?.date;
      const t = raw ? Date.parse(raw) : NaN;
      return Number.isNaN(t) ? 0 : t;
    };

    const candidates = (stats.value ?? [])
      .map((b) => ({ name: branchFromRef(b.name), at: dateOf(b) }))
      .filter((b) => b.name.length > 0);

    const selected = candidates
      .filter((b) => {
        if (def && b.name === def) return true; // default branch always wins
        if (activeSinceMs === null) return true; // no activity filter configured
        return b.at >= activeSinceMs;
      })
      .sort((a, b) => {
        // Keep the default branch even if the cap is tight, then newest-first.
        if (def && a.name === def) return -1;
        if (def && b.name === def) return 1;
        return b.at - a.at;
      })
      .slice(0, maxBranches)
      .map((b) => b.name);

    return Array.from(new Set(selected));
  }

  /**
   * Like {@link ado}, but resolves to null on a 400 instead of throwing.
   *
   * Reserved for branch enumeration on a repository that may be empty — see the
   * call site. Every other 400 is a real fault and must stay fatal.
   */
  private async adoAllowEmpty<T>(url: string): Promise<T | null> {
    await this.cfg.throttle?.acquire();
    const r = await resilientFetchJson<T>(
      this.doFetch,
      url,
      { headers: { Authorization: authHeader(this.cfg), Accept: 'application/json' } },
      { onThrottled: ({ waitMs }) => this.cfg.throttle?.backOff(waitMs) },
    );
    if (r.status === 400) return null;
    if (!r.ok) throw new Error(`ADO ${r.status} ${r.statusText} for ${url}`);
    return r.data as T;
  }

  private async ado<T>(url: string): Promise<T> {
    await this.cfg.throttle?.acquire();
    const r = await resilientFetchJson<T>(
      this.doFetch,
      url,
      { headers: { Authorization: authHeader(this.cfg), Accept: 'application/json' } },
      { onThrottled: ({ waitMs }) => this.cfg.throttle?.backOff(waitMs) },
    );
    if (!r.ok) throw new Error(`ADO ${r.status} ${r.statusText} for ${url}`);
    return r.data as T;
  }

  private async transform(opts: AdoCommitFetchOpts, raw: RawCommit, branch: string, repoUrl: string, prefixes: string[]): Promise<AdoCommitRow> {
    const message = raw.comment ?? '';
    const subject = message.split('\n', 1)[0] ?? message;
    const isMerge: 0 | 1 = (raw.parents?.length ?? 0) > 1 ? 1 : 0;
    const counts = raw.changeCounts ?? {};
    const additions = counts.Add ?? 0;
    const deletions = counts.Delete ?? 0;
    let changedFiles = (counts.Add ?? 0) + (counts.Edit ?? 0) + (counts.Delete ?? 0);
    if (changedFiles === 0) {
      try {
        const detail = await this.ado<RawCommitChanges>(`${repoUrl}/commits/${raw.commitId}/changes?api-version=7.1`);
        changedFiles = detail.changes?.length ?? 0;
      } catch { changedFiles = 0; }
    }
    const ai = detectAiAssistance({ commitMessage: message, branchName: branch, authorLogin: raw.author?.email ?? undefined });
    const linkedKeys = extractTicketKeys({
      text: message,
      branchName: branch,
      prefixes,
      source: 'ado',
    });
    return {
      id: `${repoUrl}#${raw.commitId}`,
      sha: raw.commitId,
      org_url: this.orgUrl,
      project: opts.project,
      repo_id: opts.repoId,
      repo_name: opts.repoName,
      repo_url: repoUrl,
      instance_id: this.cfg.instanceId,
      author_login: null,
      author_name: raw.author?.name ?? 'unknown',
      author_email: raw.author?.email ?? '',
      committer_name: raw.committer?.name ?? raw.author?.name ?? 'unknown',
      committer_email: raw.committer?.email ?? raw.author?.email ?? '',
      message,
      message_subject: subject,
      additions,
      deletions,
      changed_files: changedFiles,
      branch,
      pull_request_id: null,
      is_merge_commit: isMerge,
      committed_at: chDateTimeRequired(raw.author?.date ?? raw.committer?.date),
      ai_assisted: ai.aiAssisted ? 1 : 0,
      ai_confidence: ai.confidence,
      ai_signals: JSON.stringify(ai.signals),
      linked_ticket_keys: linkedKeys,
    };
  }
}

export class FakeAdoCommitAdapter implements AdoCommitPort {
  constructor(private readonly seed: AdoCommitRow[]) {}
  async fetchCommits(_opts: AdoCommitFetchOpts) { return this.seed; }
}
