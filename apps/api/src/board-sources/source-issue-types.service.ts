// `SourceIssueTypesService` returns the live issue / work-item type list for a
// given Board*Source so the web allowed-types picker can show real provider
// values instead of a free-text input.
//
// Unlike `SourceStatusesService` (which reads from ClickHouse), type
// discovery hits the upstream provider's REST API — Jira's
// `/rest/api/3/project/{key}/statuses` (via `JiraPort.fetchProjectIssueTypes`)
// and ADO's `/_apis/wit/workitemtypes` (via `AzureDevOpsPort.fetchWorkItemTypes`).
// Those calls are rate-limited, so a shared `TypeCache` dedupes inflight loads
// and remembers the result for ~60s.
//
// The boardId param is checked against the loaded source row to prevent a user
// with access to board A from probing the types of a source attached to board
// B (defense-in-depth — route auth already gates by board, but the service
// shouldn't trust the caller).
//
// `organizationId` leads every method for the same reason it leads the adapter
// factories: each factory resolves a STORED provider credential from an
// instance id, and that id is row-derived (it comes off the source's sync row,
// never off the request). A board source should never point at another
// organization's connection — Task 6's `attach()` guard is what stops one being
// created — so passing the caller's tenant down here is the second line: even a
// row that already crosses tenants cannot get a credential handed out, and the
// tenant also lands in the discovery cache key.

import type { PrismaClient } from '@deckgauge/db';
import type { AzureDevOpsPort, GitHubPort, JiraPort } from '@deckgauge/shared';
import type { TypeCache } from './type-cache.js';

export class SourceIssueTypesNotFoundError extends Error {
  constructor(provider: string, id: string) {
    super(`${provider} source ${id} not found`);
    this.name = 'SourceIssueTypesNotFoundError';
  }
}

interface Deps {
  prisma: PrismaClient;
  cache: TypeCache;
  // `organizationId` first, deliberately: a mis-ordered call fails to compile
  // rather than silently becoming a tenant bypass.
  jiraAdapterFor: (organizationId: string, instanceId: string) => Promise<JiraPort>;
  adoAdapterFor: (organizationId: string, instanceId: string) => Promise<AzureDevOpsPort>;
  githubAdapterFor: (organizationId: string, instanceId: string) => Promise<GitHubPort>;
}

// GitHub doesn't have a dedicated "org login" field on `GitHubInstance` — it
// lives in the first segment of `repoFullName` ("acme/api" → "acme"). Extract
// it consistently so cache keys + adapter calls agree.
function orgLoginFromRepo(repoFullName: string): string {
  const [org] = repoFullName.split('/');
  if (!org) throw new Error(`invalid repoFullName: ${repoFullName}`);
  return org;
}

export class SourceIssueTypesService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async listJira(
    organizationId: string,
    boardId: string,
    boardJiraSourceId: string,
  ): Promise<string[]> {
    const row = await this.deps.prisma.boardJiraSource.findUnique({
      where: { id: boardJiraSourceId },
      include: { jiraProjectSync: true },
    });
    if (!row || row.boardId !== boardId) {
      throw new SourceIssueTypesNotFoundError('jira', boardJiraSourceId);
    }

    const projectKey = row.jiraProjectSync.jiraProjectKey;
    const instanceId = row.jiraProjectSync.jiraInstanceId;

    return this.deps.cache.getOrFetch(
      { organizationId, instanceId, provider: 'jira', kind: 'issue-types', resource: projectKey },
      async () => {
        const adapter = await this.deps.jiraAdapterFor(organizationId, instanceId);
        const types = await adapter.fetchProjectIssueTypes(projectKey);
        return Array.from(new Set(types)).sort();
      },
    );
  }

  async listGitHubLabels(
    organizationId: string,
    boardId: string,
    boardGitHubSourceId: string,
  ): Promise<string[]> {
    const row = await this.deps.prisma.boardGitHubSource.findUnique({
      where: { id: boardGitHubSourceId },
      include: { gitHubRepoSync: true },
    });
    if (!row || row.boardId !== boardId) {
      throw new SourceIssueTypesNotFoundError('github', boardGitHubSourceId);
    }

    const repoFullName = row.gitHubRepoSync.repoFullName;
    const instanceId = row.gitHubRepoSync.githubInstanceId;

    return this.deps.cache.getOrFetch(
      { organizationId, instanceId, provider: 'github', kind: 'labels', resource: repoFullName },
      async () => {
        const adapter = await this.deps.githubAdapterFor(organizationId, instanceId);
        const labels = await adapter.fetchRepoLabels(repoFullName);
        return Array.from(new Set(labels)).sort();
      },
    );
  }

  async listGitHubIssueTypes(
    organizationId: string,
    boardId: string,
    boardGitHubSourceId: string,
  ): Promise<string[]> {
    const row = await this.deps.prisma.boardGitHubSource.findUnique({
      where: { id: boardGitHubSourceId },
      include: { gitHubRepoSync: true },
    });
    if (!row || row.boardId !== boardId) {
      throw new SourceIssueTypesNotFoundError('github', boardGitHubSourceId);
    }

    const instanceId = row.gitHubRepoSync.githubInstanceId;
    const orgLogin = orgLoginFromRepo(row.gitHubRepoSync.repoFullName);

    return this.deps.cache.getOrFetch(
      {
        organizationId,
        instanceId,
        provider: 'github',
        kind: 'org-issue-types',
        resource: orgLogin,
      },
      async () => {
        const adapter = await this.deps.githubAdapterFor(organizationId, instanceId);
        const types = await adapter.fetchOrgIssueTypes(orgLogin);
        return Array.from(new Set(types)).sort();
      },
    );
  }

  async listAdo(
    organizationId: string,
    boardId: string,
    boardAdoSourceId: string,
  ): Promise<string[]> {
    const row = await this.deps.prisma.boardAdoSource.findUnique({
      where: { id: boardAdoSourceId },
      include: { azureDevOpsProjectSync: true },
    });
    if (!row || row.boardId !== boardId) {
      throw new SourceIssueTypesNotFoundError('ado', boardAdoSourceId);
    }

    const project = row.azureDevOpsProjectSync.adoProject;
    const instanceId = row.azureDevOpsProjectSync.azureDevOpsInstanceId;

    return this.deps.cache.getOrFetch(
      { organizationId, instanceId, provider: 'ado', kind: 'work-item-types', resource: project },
      async () => {
        const adapter = await this.deps.adoAdapterFor(organizationId, instanceId);
        const types = await adapter.fetchWorkItemTypes(project);
        return Array.from(new Set(types)).sort();
      },
    );
  }
}
