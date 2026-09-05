// EI-0xx — GitLab issue row shape (parity with GitHubIssueRow).
import { extractTicketKeys } from './ticket-link-extractor.js';
import { gitlabApiBase } from './gitlab-api-base.js';
import { chDateTime, chDateTimeRequired } from './clickhouse-datetime.js';

export type GitLabIssueRow = {
  id: string;
  project_path: string;
  iid: number;
  instance_id: string;
  title: string;
  state: string;
  labels: string[];
  assignee_username: string | null;
  assignee_name: string | null;
  milestone_title: string | null;
  linked_ticket_keys: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export interface GitLabIssueFetchOpts {
  projectPath: string;
  since?: Date;
  ticketPrefixes?: string[];
  perPage?: number;
  maxPages?: number;
}

export interface GitLabIssuePort {
  /** Buffers all pages — convenience for callers that want the whole set. */
  fetchIssues(opts: GitLabIssueFetchOpts): Promise<GitLabIssueRow[]>;
  /** Yields one page at a time so the sync worker never buffers a full
   *  project's issues in memory (mirrors GitLabCommitAdapter.streamCommits). */
  streamIssues(opts: GitLabIssueFetchOpts): AsyncGenerator<GitLabIssueRow[]>;
}

interface GitLabIssueAdapterConfig {
  accessToken: string;
  baseUrl?: string;
  instanceId: string;
  fetchFn?: typeof fetch;
}

interface RawIssue {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  state: string;
  labels?: string[];
  assignee?: { username: string; name: string } | null;
  milestone?: { title: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function encodeProjectPath(p: string): string {
  return p.includes('%2F') ? p : encodeURIComponent(p);
}

export class GitLabIssueAdapter implements GitLabIssuePort {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly instanceId: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: GitLabIssueAdapterConfig) {
    this.baseUrl = gitlabApiBase(cfg.baseUrl ?? 'https://gitlab.com/api/v4');
    this.accessToken = cfg.accessToken;
    this.instanceId = cfg.instanceId;
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async *streamIssues(opts: GitLabIssueFetchOpts): AsyncGenerator<GitLabIssueRow[]> {
    const perPage = opts.perPage ?? 100;
    const maxPages = opts.maxPages ?? 100;
    const prefixes = opts.ticketPrefixes ?? [];
    const path = encodeProjectPath(opts.projectPath);

    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({
        order_by: 'created_at',
        sort: 'desc',
        per_page: String(perPage),
        page: String(page),
      });
      if (opts.since) params.set('updated_after', opts.since.toISOString());
      const url = `${this.baseUrl}/projects/${path}/issues?${params.toString()}`;
      const list = await this.gl<RawIssue[]>(url);
      if (!Array.isArray(list) || list.length === 0) break;
      yield list.map((issue) => this.transform(opts.projectPath, issue, prefixes));
      if (list.length < perPage) break;
    }
  }

  async fetchIssues(opts: GitLabIssueFetchOpts): Promise<GitLabIssueRow[]> {
    const rows: GitLabIssueRow[] = [];
    for await (const batch of this.streamIssues(opts)) rows.push(...batch);
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

  private transform(projectPath: string, raw: RawIssue, prefixes: string[]): GitLabIssueRow {
    const linkedKeys = extractTicketKeys({
      text: `${raw.title}\n${raw.description ?? ''}`,
      prefixes,
      source: 'gitlab',
    });

    return {
      id: `${projectPath}#${raw.iid}`,
      project_path: projectPath,
      iid: raw.iid,
      instance_id: this.instanceId,
      title: raw.title,
      state: raw.state,
      labels: raw.labels ?? [],
      assignee_username: raw.assignee?.username ?? null,
      assignee_name: raw.assignee?.name ?? null,
      milestone_title: raw.milestone?.title ?? null,
      linked_ticket_keys: linkedKeys,
      created_at: chDateTimeRequired(raw.created_at),
      updated_at: chDateTimeRequired(raw.updated_at),
      closed_at: chDateTime(raw.closed_at),
    };
  }
}

export class FakeGitLabIssueAdapter implements GitLabIssuePort {
  constructor(private readonly seed: GitLabIssueRow[]) {}
  async fetchIssues(_opts: GitLabIssueFetchOpts) {
    return this.seed;
  }
  async *streamIssues(_opts: GitLabIssueFetchOpts): AsyncGenerator<GitLabIssueRow[]> {
    yield this.seed;
  }
}
