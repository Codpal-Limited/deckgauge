import type { PrismaClient } from '@deckgauge/db';
import type { IntelligenceQueues } from '../intelligence/queues.js';

export interface EnqueueCounts {
  jira: number;
  github: number;
  ado: number;
  gitlab: number;
  bitbucket: number;
}

interface JiraSrc {
  jiraProjectSync: { jiraProjectKey: string; jiraInstance: { id: string } };
}
interface GitHubSrc {
  gitHubRepoSync: { repoFullName: string; githubInstance: { id: string } };
}
interface AdoSrc {
  azureDevOpsProjectSync: { adoProject: string; azureDevOpsInstance: { id: string } };
}
interface GitLabSrc {
  gitlabProjectSync: { projectPath: string; gitlabInstance: { id: string } };
}
interface BitbucketSrc {
  bitbucketRepoSync: { repoFullName: string; bitbucketInstance: { id: string; organizationId: string } };
}

function groupByInstance<T>(
  rows: T[],
  instanceId: (r: T) => string,
  key: (r: T) => string,
): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const id = instanceId(r);
    const set = map.get(id) ?? new Set<string>();
    set.add(key(r));
    map.set(id, set);
  }
  return new Map(Array.from(map, ([id, set]) => [id, Array.from(set)]));
}

export class BoardSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queues: IntelligenceQueues,
  ) {}

  async enqueueBoardSync(
    boardId: string,
    skipInstanceIds: Set<string> = new Set(),
  ): Promise<EnqueueCounts> {
    const [jiraSrcs, githubSrcs, adoSrcs, gitlabSrcs, bitbucketSrcs] = await Promise.all([
      this.prisma.boardJiraSource.findMany({
        where: { boardId },
        include: { jiraProjectSync: { include: { jiraInstance: true } } },
      }) as unknown as Promise<JiraSrc[]>,
      this.prisma.boardGitHubSource.findMany({
        where: { boardId },
        include: { gitHubRepoSync: { include: { githubInstance: true } } },
      }) as unknown as Promise<GitHubSrc[]>,
      this.prisma.boardAdoSource.findMany({
        where: { boardId },
        include: { azureDevOpsProjectSync: { include: { azureDevOpsInstance: true } } },
      }) as unknown as Promise<AdoSrc[]>,
      this.prisma.boardGitLabSource.findMany({
        where: { boardId },
        include: { gitlabProjectSync: { include: { gitlabInstance: true } } },
      }) as unknown as Promise<GitLabSrc[]>,
      this.prisma.boardBitbucketSource.findMany({
        where: { boardId },
        include: { bitbucketRepoSync: { include: { bitbucketInstance: true } } },
      }) as unknown as Promise<BitbucketSrc[]>,
    ]);

    const jiraGroups = groupByInstance(
      jiraSrcs,
      (r) => r.jiraProjectSync.jiraInstance.id,
      (r) => r.jiraProjectSync.jiraProjectKey,
    );
    const githubGroups = groupByInstance(
      githubSrcs,
      (r) => r.gitHubRepoSync.githubInstance.id,
      (r) => r.gitHubRepoSync.repoFullName,
    );
    const adoGroups = groupByInstance(
      adoSrcs,
      (r) => r.azureDevOpsProjectSync.azureDevOpsInstance.id,
      (r) => r.azureDevOpsProjectSync.adoProject,
    );
    const gitlabGroups = groupByInstance(
      gitlabSrcs,
      (r) => r.gitlabProjectSync.gitlabInstance.id,
      (r) => r.gitlabProjectSync.projectPath,
    );

    const bitbucketGroups = groupByInstance(
      bitbucketSrcs,
      (r) => r.bitbucketRepoSync.bitbucketInstance.id,
      (r) => r.bitbucketRepoSync.repoFullName,
    );
    // The tenant of each Bitbucket instance, carried on its job so the worker's
    // resolveSyncJobScope scopes it directly (a manual job naming no organization
    // relies on the instance lookup instead — explicit is the stronger form).
    const bitbucketOrg = new Map(
      bitbucketSrcs.map((r) => [r.bitbucketRepoSync.bitbucketInstance.id, r.bitbucketRepoSync.bitbucketInstance.organizationId]),
    );

    for (const groups of [jiraGroups, githubGroups, adoGroups, gitlabGroups, bitbucketGroups]) {
      for (const instanceId of skipInstanceIds) groups.delete(instanceId);
    }

    const firstError: { current: Error | null } = { current: null };
    const tryAdd = async (
      q: { add: (n: string, p: unknown) => Promise<unknown> },
      payload: unknown,
    ): Promise<boolean> => {
      try {
        await q.add('manual', payload);
        return true;
      } catch (err) {
        if (!firstError.current) {
          firstError.current = err instanceof Error ? err : new Error(String(err));
        }
        return false;
      }
    };

    // For Jira/GitHub/ADO: enqueue to BOTH the intelligence-sync queue (writes to
    // ClickHouse for analytics) AND the legacy promote queue (writes to Postgres
    // Project rows for the board view). A group counts as one success if at least
    // one of its two queues accepted the job.
    const jiraResults = await Promise.all(
      Array.from(jiraGroups, async ([instanceId, projectKeys]) => {
        const payload = { trigger: 'manual', instanceId, projectKeys };
        const intel = await tryAdd(this.queues.jira, payload);
        const legacy = await tryAdd(this.queues.jiraSync, payload);
        return intel || legacy;
      }),
    );
    const githubResults = await Promise.all(
      Array.from(githubGroups, async ([instanceId, repos]) => {
        const payload = { trigger: 'manual', instanceId, repos };
        const intel = await tryAdd(this.queues.github, payload);
        const legacy = await tryAdd(this.queues.githubSync, payload);
        return intel || legacy;
      }),
    );
    const adoResults = await Promise.all(
      Array.from(adoGroups, async ([instanceId, projects]) => {
        const payload = { trigger: 'manual', instanceId, projects };
        const intel = await tryAdd(this.queues.ado, payload);
        const legacy = await tryAdd(this.queues.adoSync, payload);
        return intel || legacy;
      }),
    );
    // GitLab uses the same `gitlab-sync` queue for both pipelines, so a single
    // enqueue covers both intelligence and board updates.
    const gitlabResults = await Promise.all(
      Array.from(gitlabGroups, ([instanceId, projectPaths]) =>
        tryAdd(this.queues.gitlab, { trigger: 'manual', instanceId, projectPaths }),
      ),
    );

    // Bitbucket feeds intelligence only — one queue, no promote pipeline.
    const bitbucketResults = await Promise.all(
      Array.from(bitbucketGroups, ([instanceId, repoFullNames]) =>
        tryAdd(this.queues.bitbucket, {
          trigger: 'manual',
          instanceId,
          organizationId: bitbucketOrg.get(instanceId),
          repoFullNames,
        }),
      ),
    );

    const allResults = [...jiraResults, ...githubResults, ...adoResults, ...gitlabResults, ...bitbucketResults];
    const attempted = allResults.length;
    const succeeded = allResults.filter(Boolean).length;

    if (attempted > 0 && succeeded === 0) {
      // Every group failed both of its queues. Surface the underlying error
      // (Redis down, network timeout) instead of masking it.
      throw firstError.current ?? new Error('all queue enqueues failed');
    }

    return {
      jira: jiraResults.filter(Boolean).length,
      github: githubResults.filter(Boolean).length,
      ado: adoResults.filter(Boolean).length,
      gitlab: gitlabResults.filter(Boolean).length,
      bitbucket: bitbucketResults.filter(Boolean).length,
    };
  }

  async getBoardSyncStatus(boardId: string): Promise<{
    status: 'IDLE' | 'RUNNING';
    finishedAt: string | null;
    sourceCount: number;
  }> {
    const [jira, github, ado, gitlab, bitbucket] = await Promise.all([
      this.prisma.boardJiraSource.findMany({
        where: { boardId },
        select: { jiraProjectSync: { select: { lastSyncedAt: true } } },
      }),
      this.prisma.boardGitHubSource.findMany({
        where: { boardId },
        // After Task 16 GitHubRepoSync no longer has `lastSyncedAt`; the
        // bulk-repo ingestion writes `lastSuccessAt` on every successful run.
        select: { gitHubRepoSync: { select: { lastSuccessAt: true } } },
      }),
      this.prisma.boardAdoSource.findMany({
        where: { boardId },
        select: { azureDevOpsProjectSync: { select: { lastSyncedAt: true } } },
      }),
      this.prisma.boardGitLabSource.findMany({
        where: { boardId },
        select: { gitlabProjectSync: { select: { lastSyncedAt: true } } },
      }),
      this.prisma.boardBitbucketSource.findMany({
        where: { boardId },
        select: { bitbucketRepoSync: { select: { lastSyncedAt: true } } },
      }),
    ]);

    const timestamps: number[] = [];
    for (const r of jira as Array<{ jiraProjectSync: { lastSyncedAt: Date | null } }>) {
      if (r.jiraProjectSync?.lastSyncedAt) timestamps.push(r.jiraProjectSync.lastSyncedAt.getTime());
    }
    for (const r of github as Array<{ gitHubRepoSync: { lastSuccessAt: Date | null } }>) {
      if (r.gitHubRepoSync?.lastSuccessAt) timestamps.push(r.gitHubRepoSync.lastSuccessAt.getTime());
    }
    for (const r of ado as Array<{ azureDevOpsProjectSync: { lastSyncedAt: Date | null } }>) {
      if (r.azureDevOpsProjectSync?.lastSyncedAt) timestamps.push(r.azureDevOpsProjectSync.lastSyncedAt.getTime());
    }
    for (const r of gitlab as Array<{ gitlabProjectSync: { lastSyncedAt: Date | null } }>) {
      if (r.gitlabProjectSync?.lastSyncedAt) timestamps.push(r.gitlabProjectSync.lastSyncedAt.getTime());
    }
    for (const r of bitbucket as Array<{ bitbucketRepoSync: { lastSyncedAt: Date | null } }>) {
      if (r.bitbucketRepoSync?.lastSyncedAt) timestamps.push(r.bitbucketRepoSync.lastSyncedAt.getTime());
    }

    const max = timestamps.length ? Math.max(...timestamps) : null;
    return {
      status: 'IDLE',
      finishedAt: max ? new Date(max).toISOString() : null,
      sourceCount: jira.length + github.length + ado.length + gitlab.length + bitbucket.length,
    };
  }
}
