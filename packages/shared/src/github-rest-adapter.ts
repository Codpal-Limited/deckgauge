import { GitHubPort } from './github-port.js';
import { GitHubIssue, GitHubMilestone } from './github-schemas.js';

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

interface GitHubAdapterConfig {
  accessToken: string;
  baseUrl?: string;
}

type FetchFn = typeof fetch;
type DelayFn = (ms: number) => Promise<void>;

interface RawMilestone {
  id: number;
  number: number;
  title: string;
  state: string;
  due_on: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface RawLabel {
  name: string;
}

interface RawMilestoneRef {
  number: number;
}

interface RawAssignee {
  login: string;
}

interface RawIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  milestone: RawMilestoneRef | null;
  assignee: RawAssignee | null;
  labels: RawLabel[];
  type: { name: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

const RATE_LIMIT_THRESHOLD = 10;
const MAX_RETRIES = 4;

export class GitHubRestAdapter implements GitHubPort {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchFn: FetchFn;
  private readonly delayFn: DelayFn;

  constructor(
    config: GitHubAdapterConfig,
    fetchFn: FetchFn = fetch,
    delayFn: DelayFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.baseUrl = config.baseUrl ?? 'https://api.github.com';
    this.accessToken = config.accessToken;
    this.fetchFn = fetchFn;
    this.delayFn = delayFn;
  }

  async fetchMilestones(repoFullName: string): Promise<GitHubMilestone[]> {
    const path = `/repos/${repoFullName}/milestones?state=all&per_page=100`;
    const raw = await this.fetchAllPages<RawMilestone>(path);
    return raw.map((m) => this.mapMilestone(repoFullName, m));
  }

  async fetchIssues(
    repoFullName: string,
    opts?: { milestoneNumber?: number; state?: 'open' | 'closed' | 'all' },
  ): Promise<GitHubIssue[]> {
    const state = opts?.state ?? 'open';
    let path = `/repos/${repoFullName}/issues?state=${state}&per_page=100`;
    if (opts?.milestoneNumber != null) {
      path += `&milestone=${opts.milestoneNumber}`;
    }

    const raw = await this.fetchAllPages<RawIssue>(path);
    // Exclude pull requests (GitHub REST returns PRs under /issues)
    return raw
      .filter((i) => i.pull_request == null)
      .map((i) => this.mapIssue(repoFullName, i));
  }

  async fetchRepoLabels(repoFullName: string): Promise<string[]> {
    const path = `/repos/${repoFullName}/labels?per_page=100`;
    const raw = await this.fetchAllPages<RawLabel>(path);
    return [...new Set(raw.map((l) => l.name))].sort();
  }

  async fetchOrgIssueTypes(orgLogin: string): Promise<string[]> {
    const url = `${this.baseUrl}/orgs/${encodeURIComponent(orgLogin)}/issue-types`;
    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (response.status === 404) return [];

    if (response.status === 401 || response.status === 403) {
      throw new GitHubAuthError(`GitHub authentication failed (${response.status})`);
    }

    if (!response.ok) {
      throw new Error(`GitHub /orgs/${orgLogin}/issue-types returned ${response.status}`);
    }

    const data = (await response.json()) as Array<{ name: string }>;
    return [...new Set(data.map((t) => t.name))].sort();
  }

  private async fetchAllPages<T>(initialPath: string): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = `${this.baseUrl}${initialPath}`;

    while (url) {
      const response = await this.makeRequest(url);
      const data = (await response.json()) as T[];
      results.push(...data);

      // Handle rate limit backoff
      const remaining = response.headers.get('X-RateLimit-Remaining');
      const reset = response.headers.get('X-RateLimit-Reset');
      if (remaining != null && Number(remaining) < RATE_LIMIT_THRESHOLD) {
        const resetAt = reset ? Number(reset) * 1000 : Date.now() + 60_000;
        const wait = Math.max(0, resetAt - Date.now());
        await this.delayFn(wait);
      }

      // Follow Link header pagination
      const linkHeader = response.headers.get('Link');
      url = this.extractNextUrl(linkHeader);
    }

    return results;
  }

  private async makeRequest(url: string): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await this.fetchFn(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (response.status === 401 || response.status === 403) {
        throw new GitHubAuthError(`GitHub authentication failed (${response.status})`);
      }

      if (response.ok) {
        return response;
      }

      if (response.status >= 500) {
        lastError = new Error(`GitHub API error: ${response.status}`);
        if (attempt < MAX_RETRIES) {
          await this.delayFn(Math.pow(2, attempt) * 1000);
        }
        continue;
      }

      throw new Error(`GitHub API error: ${response.status}`);
    }

    throw lastError ?? new Error('GitHub API request failed after retries');
  }

  private extractNextUrl(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] ?? null : null;
  }

  private mapMilestone(repoFullName: string, raw: RawMilestone): GitHubMilestone {
    return {
      id: `${repoFullName}#${raw.number}`,
      repoFullName,
      number: raw.number,
      title: raw.title,
      state: raw.state === 'open' ? 'open' : 'closed',
      dueOn: raw.due_on ? new Date(raw.due_on) : null,
      createdAt: new Date(raw.created_at),
      updatedAt: new Date(raw.updated_at),
      closedAt: raw.closed_at ? new Date(raw.closed_at) : null,
    };
  }

  private mapIssue(repoFullName: string, raw: RawIssue): GitHubIssue {
    return {
      id: `${repoFullName}#${raw.number}`,
      repoFullName,
      number: raw.number,
      milestoneId: raw.milestone ? `${repoFullName}#${raw.milestone.number}` : null,
      title: raw.title,
      body: raw.body ?? null,
      state: raw.state === 'open' ? 'open' : 'closed',
      assigneeLogin: raw.assignee?.login ?? null,
      labels: raw.labels.map((l) => l.name),
      type: raw.type?.name ?? null,
      createdAt: new Date(raw.created_at),
      updatedAt: new Date(raw.updated_at),
      closedAt: raw.closed_at ? new Date(raw.closed_at) : null,
    };
  }
}
