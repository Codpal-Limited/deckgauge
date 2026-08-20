// The default provider-adapter factories for the board-source routes.
//
// Each one resolves a STORED credential — a Jira API token, a GitHub PAT, an
// ADO PAT — from an instance id and hands back an adapter that will spend it.
// They lived as three private copies of the same function, one per
// `board-*-source.routes.ts`, and every copy resolved its instance by id ALONE:
//
//   prisma.jiraInstance.findUniqueOrThrow({ where: { id: instanceId } })
//
// behind a `board(VIEWER)` gate, which says which board the caller may read and
// nothing at all about which organization owns the connection. Collapsed into
// one module so the tenant predicate exists in exactly one place rather than
// three that can drift.
//
// `organizationId` is the FIRST parameter on purpose: a mis-ordered call fails
// to compile instead of silently becoming a tenant bypass.
//
// On the layering: the `instanceId` these receive is row-derived — it comes off
// the board source's stored sync row, not off the request — so the first line of
// defence is the `attach()` guard that refuses to create a source pointing at a
// foreign connection. This is the second: a row that already crosses tenants
// still cannot get a credential handed out.

import type { PrismaClient } from '@deckgauge/db';
import {
  AzureDevOpsRestAdapter,
  GitHubRestAdapter,
  JiraCloudAdapter,
  type AzureDevOpsPort,
  type GitHubPort,
  type JiraPort,
} from '@deckgauge/shared';

/**
 * A connection id that does not resolve inside the caller's organization.
 *
 * Deliberately indistinguishable from "no such connection": telling a caller
 * that an id exists but belongs to someone else is itself a cross-tenant
 * disclosure. Routes map this to 404.
 */
export class SourceConnectionNotFoundError extends Error {
  constructor(provider: string, id: string) {
    super(`${provider} connection ${id} not found`);
    this.name = 'SourceConnectionNotFoundError';
  }
}

export async function defaultJiraAdapterFor(
  prisma: PrismaClient,
  organizationId: string,
  instanceId: string,
): Promise<JiraPort> {
  // `findFirst`, not `findUnique`: Prisma's unique-key lookup cannot express the
  // compound `{ id, organizationId }` predicate, so this is the correct shape
  // for a tenant-scoped resolve rather than a workaround for one.
  const instance = await prisma.jiraInstance.findFirst({
    where: { id: instanceId, organizationId },
  });
  if (!instance) throw new SourceConnectionNotFoundError('jira', instanceId);
  return new JiraCloudAdapter({
    atlassianUrl: instance.atlassianUrl,
    email: instance.email,
    apiToken: instance.apiToken,
    projectKeys: instance.projectKeys,
  });
}

export async function defaultGitHubAdapterFor(
  prisma: PrismaClient,
  organizationId: string,
  instanceId: string,
): Promise<GitHubPort> {
  const instance = await prisma.gitHubInstance.findFirst({
    where: { id: instanceId, organizationId },
  });
  if (!instance) throw new SourceConnectionNotFoundError('github', instanceId);
  return new GitHubRestAdapter({
    baseUrl: instance.baseUrl,
    accessToken: instance.accessToken,
  });
}

export async function defaultAdoAdapterFor(
  prisma: PrismaClient,
  organizationId: string,
  instanceId: string,
): Promise<AzureDevOpsPort> {
  const instance = await prisma.azureDevOpsInstance.findFirst({
    where: { id: instanceId, organizationId },
  });
  if (!instance) throw new SourceConnectionNotFoundError('ado', instanceId);
  return new AzureDevOpsRestAdapter({
    orgUrl: instance.orgUrl,
    authMethod: instance.authMethod as 'PAT' | 'BASIC',
    accessToken: instance.accessToken,
    username: instance.username ?? undefined,
  });
}
