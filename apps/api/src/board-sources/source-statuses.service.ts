// `SourceStatusesService` queries ClickHouse to surface the distinct status /
// label values the provider currently emits for a given Board*Source. The web
// status-mapping editor uses this list to show the user real choices (the
// "source side" of the mapping). Modeled after `PreviewCountService` —
// Postgres lookup for the source row, ClickHouse query for the values.
//
// GitHub note: `apps/worker/src/github-promote.service.ts` matches BOTH
// `labels` AND `state` against the status mapping (case-insensitive). To stay
// truthful about what the user can map against, we return distinct labels
// merged with `open` and `closed`.

import type { PrismaClient } from '@deckgauge/db';
import type { ChReadClient } from '../analytics/ch-read-scope.js';

export class SourceStatusesNotFoundError extends Error {
  constructor(provider: string, id: string) {
    super(`${provider} source ${id} not found`);
    this.name = 'SourceStatusesNotFoundError';
  }
}

interface Deps {
  prisma: PrismaClient;
  clickhouse: ChReadClient;
}

export class SourceStatusesService {
  private readonly prisma: PrismaClient;
  private readonly clickhouse: ChReadClient;

  constructor(deps: Deps) {
    this.prisma = deps.prisma;
    this.clickhouse = deps.clickhouse;
  }

  private async runStringList(
    query: string,
    query_params: Record<string, unknown>,
  ): Promise<string[]> {
    const result = await this.clickhouse.query({ query, query_params, format: 'JSONEachRow' });
    const rows = (await result.json()) as Array<{ value: string }>;
    return rows
      .map((r) => (r.value ?? '').trim())
      .filter((v) => v.length > 0);
  }

  async listJira(boardJiraSourceId: string): Promise<string[]> {
    const row = await this.prisma.boardJiraSource.findUnique({
      where: { id: boardJiraSourceId },
      include: { jiraProjectSync: true },
    });
    if (!row) throw new SourceStatusesNotFoundError('jira', boardJiraSourceId);

    return this.runStringList(
      `SELECT DISTINCT status AS value
       FROM cockpit.jira_issues
       WHERE project_key = {projectKey:String}
       ORDER BY value`,
      { projectKey: row.jiraProjectSync.jiraProjectKey },
    );
  }

  async listGitHub(boardGitHubSourceId: string): Promise<string[]> {
    const row = await this.prisma.boardGitHubSource.findUnique({
      where: { id: boardGitHubSourceId },
      include: { gitHubRepoSync: true },
    });
    if (!row) throw new SourceStatusesNotFoundError('github', boardGitHubSourceId);

    // Labels (array column flattened) + the two synthetic state values the
    // promote worker also matches against.
    const labels = await this.runStringList(
      `SELECT DISTINCT label AS value
       FROM cockpit.github_issues
       ARRAY JOIN labels AS label
       WHERE repo_full_name = {repo:String}
       ORDER BY value`,
      { repo: row.gitHubRepoSync.repoFullName },
    );
    return Array.from(new Set([...labels, 'open', 'closed']));
  }

  async listAdo(boardAdoSourceId: string): Promise<string[]> {
    const row = await this.prisma.boardAdoSource.findUnique({
      where: { id: boardAdoSourceId },
      include: { azureDevOpsProjectSync: true },
    });
    if (!row) throw new SourceStatusesNotFoundError('ado', boardAdoSourceId);

    return this.runStringList(
      `SELECT DISTINCT state AS value
       FROM cockpit.ado_work_items
       WHERE project = {project:String}
       ORDER BY value`,
      { project: row.azureDevOpsProjectSync.adoProject },
    );
  }
}
