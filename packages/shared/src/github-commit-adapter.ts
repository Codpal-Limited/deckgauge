// EI-004 — GitHubCommitAdapter.
// Fetches commits with diff stats from a repository (default branch only),
// incremental via since-watermark. Outputs rows for cockpit.github_commits
// (CLICKHOUSE-ARCHITECTURE.md §5.5 — github_commits section).
// Does NOT write to ClickHouse; processor (EI-013) does that.

import { detectAiAssistance } from './ai-detection.js';
import { extractTicketKeys } from './ticket-link-extractor.js';
import { chDateTimeRequired } from './clickhouse-datetime.js';

export interface GitHubCommitFetchOpts {
  repoFullName: string;
  branch?: string;
  since?: Date;
  ticketPrefixes?: string[];
  perPage?: number;
  maxPages?: number;
  fetchDetailStats?: boolean;
}

export interface GitHubCommitRow {
  id: string;
  sha: string;
  repo_full_name: string;
  instance_id: string;
  author_login: string | null;
  author_name: string;
  author_email: string;
  committer_login: string | null;
  committer_name: string;
  message: string;
  message_subject: string;
  additions: number;
  deletions: number;
  changed_files: number;
  branch: string | null;
  pull_request_number: number | null;
  is_merge_commit: 0 | 1;
  committed_at: string;
  ai_assisted: 0 | 1;
  ai_confidence: number | null;
  ai_signals: string;
  linked_ticket_keys: string[];
}

export interface GitHubCommitPort {
  fetchCommits(opts: GitHubCommitFetchOpts): Promise<GitHubCommitRow[]>;
}

interface GitHubCommitAdapterConfig {
  accessToken: string;
  baseUrl?: string;
  instanceId: string;
  fetchFn?: typeof fetch;
}

interface RawCommitListEntry {
  sha: string;
  commit: {
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
    message: string;
  };
  author: { login: string } | null;
  committer: { login: string } | null;
  parents: Array<{ sha: string }>;
}

interface RawCommitDetail extends RawCommitListEntry {
  stats?: { additions: number; deletions: number };
  files?: Array<unknown>;
}

export class GitHubCommitAdapter implements GitHubCommitPort {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly instanceId: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: GitHubCommitAdapterConfig) {
    this.baseUrl = (cfg.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.accessToken = cfg.accessToken;
    this.instanceId = cfg.instanceId;
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async fetchCommits(opts: GitHubCommitFetchOpts): Promise<GitHubCommitRow[]> {
    const perPage = opts.perPage ?? 100;
    const maxPages = opts.maxPages ?? 100;
    const prefixes = opts.ticketPrefixes ?? [];
    const wantStats = opts.fetchDetailStats ?? true;

    const rows: GitHubCommitRow[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      if (opts.since) params.set('since', opts.since.toISOString());
      if (opts.branch) params.set('sha', opts.branch);
      const url = `${this.baseUrl}/repos/${opts.repoFullName}/commits?${params.toString()}`;
      const list = await this.gh<RawCommitListEntry[]>(url);
      if (!Array.isArray(list) || list.length === 0) break;

      for (const item of list) {
        let detail: RawCommitDetail = item;
        if (wantStats) {
          detail = await this.gh<RawCommitDetail>(
            `${this.baseUrl}/repos/${opts.repoFullName}/commits/${item.sha}`,
          );
        }
        rows.push(this.transform(opts.repoFullName, detail, opts.branch ?? null, prefixes));
      }
      if (list.length < perPage) break;
    }
    return rows;
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
    raw: RawCommitDetail,
    branch: string | null,
    prefixes: string[],
  ): GitHubCommitRow {
    const message = raw.commit.message;
    const subject = message.split('\n', 1)[0] ?? message;
    const isMerge: 0 | 1 = (raw.parents?.length ?? 0) > 1 ? 1 : 0;

    const ai = detectAiAssistance({
      commitMessage: message,
      branchName: branch ?? undefined,
      authorLogin: raw.author?.login ?? undefined,
    });

    const linkedKeys = extractTicketKeys({
      text: message,
      branchName: branch ?? undefined,
      prefixes,
      source: 'github',
    });

    return {
      id: `${repoFullName}#${raw.sha}`,
      sha: raw.sha,
      repo_full_name: repoFullName,
      instance_id: this.instanceId,
      author_login: raw.author?.login ?? null,
      author_name: raw.commit.author.name,
      author_email: raw.commit.author.email,
      committer_login: raw.committer?.login ?? null,
      committer_name: raw.commit.committer.name,
      message,
      message_subject: subject,
      additions: raw.stats?.additions ?? 0,
      deletions: raw.stats?.deletions ?? 0,
      changed_files: raw.files?.length ?? 0,
      branch,
      pull_request_number: null,
      is_merge_commit: isMerge,
      committed_at: chDateTimeRequired(raw.commit.author.date),
      ai_assisted: ai.aiAssisted ? 1 : 0,
      ai_confidence: ai.confidence,
      ai_signals: JSON.stringify(ai.signals),
      linked_ticket_keys: linkedKeys,
    };
  }
}

export class FakeGitHubCommitAdapter implements GitHubCommitPort {
  constructor(private readonly seed: GitHubCommitRow[]) {}
  async fetchCommits(_opts: GitHubCommitFetchOpts) {
    return this.seed;
  }
}
