import type { PrismaClient } from '@deckgauge/db';

export interface ResolvedScope {
  github: string[];
  jira: string[];
  ado: string[];
  gitlab: string[];
}

/**
 * The SQL console's board scope: the external identifiers a user's authored SQL
 * is rewritten to filter on.
 *
 * `organizationId` is REQUIRED — nullable, but required — so a call site that has
 * not thought about the tenant boundary fails to compile. `null` is the
 * membership-less break-glass identity and is deliberately UNSCOPED, matching
 * `intelligence/board-scope.ts` and `policy.ts`'s no-membership fallback.
 *
 * This is a THIRD board-scope resolver, alongside `getBoardScope` and
 * `getWidgetBoardScope` (which share `resolveBoardScope`). Those two gained this
 * predicate first and this one was missed, because that sweep followed a file
 * list rather than the shape. Kept separate rather than merged here because it
 * returns a different type (`ResolvedScope`, four plain string lists, consumed by
 * the SQL rewriter) — merging is a refactor, and a refactor is not what closes a
 * tenancy gap.
 *
 * The predicate goes through the `board` relation: these four source tables carry
 * no `organizationId` of their own, reaching a tenant through `Board`.
 */
export async function resolveScope(
  prisma: PrismaClient,
  boardId: string,
  organizationId: string | null,
): Promise<ResolvedScope> {
  const tenantFilter = organizationId ? { board: { organizationId } } : {};
  const [github, jira, ado, gitlab] = await Promise.all([
    prisma.boardGitHubSource.findMany({
      where: { boardId, ...tenantFilter },
      select: { gitHubRepoSync: { select: { repoFullName: true } } },
    }),
    prisma.boardJiraSource.findMany({
      where: { boardId, ...tenantFilter },
      select: { jiraProjectSync: { select: { jiraProjectKey: true } } },
    }),
    prisma.boardAdoSource.findMany({
      where: { boardId, ...tenantFilter },
      select: { azureDevOpsProjectSync: { select: { adoProject: true } } },
    }),
    prisma.boardGitLabSource.findMany({
      where: { boardId, ...tenantFilter },
      select: { gitlabProjectSync: { select: { projectPath: true } } },
    }),
  ]);

  return {
    github: github.map((r) => r.gitHubRepoSync.repoFullName),
    jira: jira.map((r) => r.jiraProjectSync.jiraProjectKey),
    ado: ado.map((r) => r.azureDevOpsProjectSync.adoProject),
    gitlab: gitlab.map((r) => r.gitlabProjectSync.projectPath),
  };
}
