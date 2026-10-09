// Issue #8 — what a manual sync would actually fetch, counted BEFORE enqueueing.
//
// A manual sync with no project or repo attached used to "succeed" silently: the
// route answered 202, the worker loaded the connection, found nothing to fetch and
// wrote nothing. These counters let the routes refuse up front with
// 409 NOTHING_TO_SYNC instead.
//
// Each count MIRRORS the worker handler the corresponding queue feeds, filter for
// filter. If a handler's selection changes, change its counter here too — a
// counter that answers 0 where the worker would sync something blocks a real
// sync, and one that answers >0 where it syncs nothing restores the silence.
//
//   jira   -> apps/worker/src/jira-intelligence-sync.handler.ts
//             non-demo instances; per instance the jiraProjectSync keys, else
//             instance.projectKeys (resolveInstanceProjectKeys).
//   github -> apps/worker/src/github-intelligence-fanout.handler.ts
//             gitHubRepoSync rows with disabledAt null on a non-demo instance.
//   ado    -> apps/worker/src/ado-intelligence-sync.handler.ts
//             project syncs opted in to repos (syncAllRepos or a syncRepos list)
//             AND to at least one of syncPrs / syncCommits.
//   gitlab -> apps/worker/src/gitlab-sync.handler.ts
//             every gitLabProjectSync row.
//
// Every query is scoped to the caller's organization — directly on the instance,
// or through the parent relation for the sync tables that carry no tenant column.
import type { PrismaClient } from '@deckgauge/db';
import { EXCLUDE_DEMO_INSTANCE } from '@deckgauge/db';

export type SyncSource = 'jira' | 'github' | 'ado' | 'gitlab';
export const SYNC_SOURCES: readonly SyncSource[] = ['jira', 'github', 'ado', 'gitlab'];
export type SyncableScope = Record<SyncSource, number>;

async function countJira(prisma: PrismaClient, organizationId: string): Promise<number> {
  const instances = await prisma.jiraInstance.findMany({
    where: { ...EXCLUDE_DEMO_INSTANCE, organizationId },
    select: { projectKeys: true, projectSyncs: { select: { jiraProjectKey: true } } },
  });
  let total = 0;
  for (const instance of instances) {
    total +=
      instance.projectSyncs.length > 0
        ? new Set(instance.projectSyncs.map((s) => s.jiraProjectKey)).size
        : instance.projectKeys.length;
  }
  return total;
}

function countGitHubIntelligence(prisma: PrismaClient, organizationId: string): Promise<number> {
  return prisma.gitHubRepoSync.count({
    where: { disabledAt: null, githubInstance: { ...EXCLUDE_DEMO_INSTANCE, organizationId } },
  });
}

function countAdo(prisma: PrismaClient, organizationId: string): Promise<number> {
  return prisma.azureDevOpsProjectSync.count({
    where: {
      azureDevOpsInstance: { organizationId },
      AND: [
        { OR: [{ syncAllRepos: true }, { syncRepos: { isEmpty: false } }] },
        { OR: [{ syncPrs: true }, { syncCommits: true }] },
      ],
    },
  });
}

function countGitLab(prisma: PrismaClient, organizationId: string): Promise<number> {
  return prisma.gitLabProjectSync.count({ where: { gitlabInstance: { organizationId } } });
}

/** Per source, how many projects/repos a manual intelligence sync would fetch. */
export async function countSyncableScope(
  prisma: PrismaClient,
  organizationId: string,
): Promise<SyncableScope> {
  const [jira, github, ado, gitlab] = await Promise.all([
    countJira(prisma, organizationId),
    countGitHubIntelligence(prisma, organizationId),
    countAdo(prisma, organizationId),
    countGitLab(prisma, organizationId),
  ]);
  return { jira, github, ado, gitlab };
}

/**
 * How many repos `POST /github/sync` would fetch. That route feeds
 * apps/worker/src/github-sync.handler.ts, which resolves repos differently from the
 * intelligence fan-out: per non-demo instance, its repo-sync rows (disabled ones
 * included — the handler applies only the demo exclusion), else `instance.repos`.
 */
export async function countGitHubBasicSyncScope(
  prisma: PrismaClient,
  organizationId: string,
): Promise<number> {
  const instances = await prisma.gitHubInstance.findMany({
    where: { ...EXCLUDE_DEMO_INSTANCE, organizationId },
    select: { repos: true, _count: { select: { repoSyncs: true } } },
  });
  let total = 0;
  for (const instance of instances) {
    total += instance._count.repoSyncs > 0 ? instance._count.repoSyncs : instance.repos.length;
  }
  return total;
}
