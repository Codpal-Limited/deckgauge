// `PreviewCountService` queries ClickHouse to estimate how many items match
// a board source's filter config (used by the UI to render "~N matched" hints).
//
// GitLab note: cockpit has no gitlab_issues table — `countGitLabIssues` queries
// `cockpit.gitlab_merge_requests` instead. The method name and route stay stable
// because the surface contract is "preview count for what will sync".
//
// ADO note: `AzureDevOpsProjectSync` does not carry the org URL (it lives on
// `AzureDevOpsInstance`). We scope by `project` only — same approach taken by
// `apps/api/src/intelligence/board-scope.ts:54` so the preview and the real
// intelligence queries stay consistent.

import type { PrismaClient } from '@deckgauge/db';
import type { ChReadClient } from '../analytics/ch-read-scope.js';

export interface PreviewCount {
  count: number;
  sampledAt: string;
}

export class PreviewSourceNotFoundError extends Error {
  constructor(provider: string, id: string) {
    super(`${provider} source ${id} not found`);
    this.name = 'PreviewSourceNotFoundError';
  }
}

interface Deps {
  prisma: PrismaClient;
  clickhouse: ChReadClient;
}

export class PreviewCountService {
  private readonly prisma: PrismaClient;
  private readonly clickhouse: ChReadClient;

  constructor(deps: Deps) {
    this.prisma = deps.prisma;
    this.clickhouse = deps.clickhouse;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async runCount(
    query: string,
    query_params: Record<string, unknown>,
  ): Promise<number> {
    const result = await this.clickhouse.query({ query, query_params, format: 'JSONEachRow' });
    const rows = (await result.json()) as Array<{ total: number | string }>;
    return Number(rows[0]?.total ?? 0);
  }

  async countJiraIssues(boardJiraSourceId: string): Promise<PreviewCount> {
    const row = await this.prisma.boardJiraSource.findUnique({
      where: { id: boardJiraSourceId },
      include: { jiraProjectSync: true },
    });
    if (!row) throw new PreviewSourceNotFoundError('jira', boardJiraSourceId);

    const hasTypes = row.allowedIssueTypes.length > 0;
    const query = `
      SELECT count() AS total
      FROM cockpit.jira_issues
      WHERE project_key = {projectKey:String}
      ${hasTypes ? 'AND issue_type IN {issueTypes:Array(String)}' : ''}
    `;
    const params: Record<string, unknown> = {
      projectKey: row.jiraProjectSync.jiraProjectKey,
    };
    if (hasTypes) params.issueTypes = row.allowedIssueTypes;

    const count = await this.runCount(query, params);
    return { count, sampledAt: this.now() };
  }

  async countGitHubIssues(boardGitHubSourceId: string): Promise<PreviewCount> {
    const row = await this.prisma.boardGitHubSource.findUnique({
      where: { id: boardGitHubSourceId },
      include: { gitHubRepoSync: true },
    });
    if (!row) throw new PreviewSourceNotFoundError('github', boardGitHubSourceId);

    const hasLabels = row.allowedLabels.length > 0;
    const openOnly = !row.includeClosedIssues;
    const query = `
      SELECT count() AS total
      FROM cockpit.github_issues
      WHERE repo_full_name = {repo:String}
      ${hasLabels ? 'AND arrayExists(l -> has({labels:Array(String)}, l), labels)' : ''}
      ${openOnly ? "AND state = 'open'" : ''}
    `;
    const params: Record<string, unknown> = { repo: row.gitHubRepoSync.repoFullName };
    if (hasLabels) params.labels = row.allowedLabels;

    const count = await this.runCount(query, params);
    return { count, sampledAt: this.now() };
  }

  async countAdoWorkItems(boardAdoSourceId: string): Promise<PreviewCount> {
    const row = await this.prisma.boardAdoSource.findUnique({
      where: { id: boardAdoSourceId },
      include: { azureDevOpsProjectSync: true },
    });
    if (!row) throw new PreviewSourceNotFoundError('ado', boardAdoSourceId);

    const hasTypes = row.allowedWorkItemTypes.length > 0;
    const project = row.azureDevOpsProjectSync.adoProject;
    const query = `
      SELECT count() AS total
      FROM cockpit.ado_work_items
      WHERE project = {project:String}
      ${hasTypes ? 'AND work_item_type IN {types:Array(String)}' : ''}
    `;
    const params: Record<string, unknown> = { project };
    if (hasTypes) params.types = row.allowedWorkItemTypes;

    const count = await this.runCount(query, params);
    return { count, sampledAt: this.now() };
  }

  async countGitLabIssues(boardGitLabSourceId: string): Promise<PreviewCount> {
    const row = await this.prisma.boardGitLabSource.findUnique({
      where: { id: boardGitLabSourceId },
      include: { gitlabProjectSync: true },
    });
    if (!row) throw new PreviewSourceNotFoundError('gitlab', boardGitLabSourceId);

    // See file header: no gitlab_issues table — count MRs.
    const projectPath = row.gitlabProjectSync.projectPath;
    const count = await this.runCount(
      `SELECT count() AS total
       FROM cockpit.gitlab_merge_requests
       WHERE project_path = {projectPath:String}`,
      { projectPath },
    );
    return { count, sampledAt: this.now() };
  }
}
