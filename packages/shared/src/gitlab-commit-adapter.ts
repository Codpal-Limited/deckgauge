// EI-006 — GitLabCommitAdapter.
import { detectAiAssistance } from './ai-detection.js';
import { extractTicketKeys } from './ticket-link-extractor.js';
import { gitlabApiBase } from './gitlab-api-base.js';

export interface GitLabCommitFetchOpts {
  projectPath: string;
  refName?: string;
  since?: Date;
  ticketPrefixes?: string[];
  perPage?: number;
  maxPages?: number;
}

export interface GitLabCommitRow {
  id: string;
  sha: string;
  project_path: string;
  instance_id: string;
  author_name: string;
  author_email: string;
  committer_name: string;
  message: string;
  message_subject: string;
  additions: number;
  deletions: number;
  changed_files: number;
  merge_request_iid: number | null;
  is_merge_commit: 0 | 1;
  committed_at: string;
  ai_assisted: 0 | 1;
  ai_confidence: number | null;
  ai_signals: string;
  linked_ticket_keys: string[];
}

export interface GitLabCommitPort {
  /** Buffers all pages — convenience for callers that want the whole set. */
  fetchCommits(opts: GitLabCommitFetchOpts): Promise<GitLabCommitRow[]>;
  /** Yields one page at a time so the sync worker never buffers a full repo
   *  in memory (mirrors the ADO adapter's streamWorkItems). */
  streamCommits(opts: GitLabCommitFetchOpts): AsyncGenerator<GitLabCommitRow[]>;
}

interface GitLabCommitAdapterConfig {
  accessToken: string;
  baseUrl?: string;
  instanceId: string;
  fetchFn?: typeof fetch;
}

interface RawCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  committer_name: string;
  committed_date: string;
  parent_ids: string[];
  stats?: { additions: number; deletions: number; total?: number };
}

function encodeProjectPath(p: string): string {
  return p.includes('%2F') ? p : encodeURIComponent(p);
}

export class GitLabCommitAdapter implements GitLabCommitPort {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly instanceId: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: GitLabCommitAdapterConfig) {
    this.baseUrl = gitlabApiBase(cfg.baseUrl ?? 'https://gitlab.com/api/v4');
    this.accessToken = cfg.accessToken;
    this.instanceId = cfg.instanceId;
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async *streamCommits(opts: GitLabCommitFetchOpts): AsyncGenerator<GitLabCommitRow[]> {
    const perPage = opts.perPage ?? 100;
    const maxPages = opts.maxPages ?? 100;
    const prefixes = opts.ticketPrefixes ?? [];
    const path = encodeProjectPath(opts.projectPath);

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({
        with_stats: 'true',
        per_page: String(perPage),
        page: String(page),
      });
      if (opts.refName) params.set('ref_name', opts.refName);
      if (opts.since) params.set('since', opts.since.toISOString());
      const url = `${this.baseUrl}/projects/${path}/repository/commits?${params.toString()}`;
      const list = await this.gl<RawCommit[]>(url);
      if (!Array.isArray(list) || list.length === 0) break;
      yield list.map((c) => this.transform(opts.projectPath, c, prefixes, opts.refName));
      if (list.length < perPage) break;
    }
  }

  async fetchCommits(opts: GitLabCommitFetchOpts): Promise<GitLabCommitRow[]> {
    const rows: GitLabCommitRow[] = [];
    for await (const batch of this.streamCommits(opts)) rows.push(...batch);
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
    raw: RawCommit,
    prefixes: string[],
    branch: string | undefined,
  ): GitLabCommitRow {
    const subject = raw.title ?? raw.message.split('\n', 1)[0] ?? raw.message;
    const isMerge: 0 | 1 = raw.parent_ids.length > 1 ? 1 : 0;
    const ai = detectAiAssistance({ commitMessage: raw.message, branchName: branch });
    const linkedKeys = extractTicketKeys({
      text: raw.message,
      branchName: branch,
      prefixes,
      source: 'gitlab',
    });

    return {
      id: `${projectPath}#${raw.id}`,
      sha: raw.id,
      project_path: projectPath,
      instance_id: this.instanceId,
      author_name: raw.author_name,
      author_email: raw.author_email,
      committer_name: raw.committer_name,
      message: raw.message,
      message_subject: subject,
      additions: raw.stats?.additions ?? 0,
      deletions: raw.stats?.deletions ?? 0,
      changed_files: 0,
      merge_request_iid: null,
      is_merge_commit: isMerge,
      committed_at: raw.committed_date,
      ai_assisted: ai.aiAssisted ? 1 : 0,
      ai_confidence: ai.confidence,
      ai_signals: JSON.stringify(ai.signals),
      linked_ticket_keys: linkedKeys,
    };
  }
}

export class FakeGitLabCommitAdapter implements GitLabCommitPort {
  constructor(private readonly seed: GitLabCommitRow[]) {}
  async fetchCommits(_opts: GitLabCommitFetchOpts) {
    return this.seed;
  }
  async *streamCommits(_opts: GitLabCommitFetchOpts): AsyncGenerator<GitLabCommitRow[]> {
    yield this.seed;
  }
}
