// BitbucketRepoSync configuration — one row per (instance, repoFullName).
// Mirrors gitlab-project-sync.service.ts, with one deliberate difference: EVERY
// method here resolves the instance (or the sync's instance) through the caller
// first. GitLab's create/ensure/update/delete take ids straight off the request,
// so a member could enrol a repo for ingestion under another tenant's stored
// token; that is not copied.
import type { PrismaClient } from '@deckgauge/db';
import type { BitbucketRepoSyncDto } from '@deckgauge/shared';
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';

/** The instance or sync is not one the caller may use. Routes answer 404. */
export class BitbucketRepoSyncNotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`Bitbucket ${what} ${id} not found`);
    this.name = 'BitbucketRepoSyncNotFoundError';
  }
}

/** The repository is not in the connection's workspace. Routes answer 400. */
export class BitbucketRepoWorkspaceMismatchError extends Error {
  constructor(repoFullName: string, workspace: string) {
    super(`Repository "${repoFullName}" is not in the connection's workspace "${workspace}".`);
    this.name = 'BitbucketRepoWorkspaceMismatchError';
  }
}

export interface BitbucketRepoSyncFlags {
  syncPrs?: boolean;
  syncCommits?: boolean;
  syncDeployments?: boolean;
}

type SyncRow = {
  id: string;
  bitbucketInstanceId: string;
  repoFullName: string;
  projectKey: string | null;
  syncPrs: boolean;
  syncCommits: boolean;
  syncDeployments: boolean;
  lastSyncedAt: Date | null;
  lastDeploymentSyncAt: Date | null;
};

export function toBitbucketRepoSyncDto(r: SyncRow, boardCount: number): BitbucketRepoSyncDto {
  return {
    id: r.id,
    bitbucketInstanceId: r.bitbucketInstanceId,
    repoFullName: r.repoFullName,
    projectKey: r.projectKey,
    syncPrs: r.syncPrs,
    syncCommits: r.syncCommits,
    syncDeployments: r.syncDeployments,
    lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    lastDeploymentSyncAt: r.lastDeploymentSyncAt?.toISOString() ?? null,
    boardCount,
  };
}

/**
 * The connection's workspace must own the repo: the worker spends this
 * instance's token on `repoFullName`, and a repo from another workspace would
 * either fail every sync or — worse — ingest a workspace nobody chose.
 * An instance with no workspace yet accepts nothing.
 */
export function assertRepoInWorkspace(repoFullName: string, workspace: string): void {
  const [ws] = repoFullName.split('/');
  if (!workspace || ws !== workspace) throw new BitbucketRepoWorkspaceMismatchError(repoFullName, workspace);
}

export class BitbucketRepoSyncService {
  constructor(private readonly prisma: PrismaClient) {}

  private instanceWhere(caller: ConnectionCaller) {
    return { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) };
  }

  private async resolveInstance(caller: ConnectionCaller, instanceId: string) {
    const instance = await this.prisma.bitbucketInstance.findFirst({
      where: { id: instanceId, ...this.instanceWhere(caller) },
      select: { id: true, workspace: true },
    });
    if (!instance) throw new BitbucketRepoSyncNotFoundError('instance', instanceId);
    return instance;
  }

  /** Whether the caller may see this sync at all — resolved BEFORE any detach guard. */
  async isVisible(caller: ConnectionCaller, id: string): Promise<boolean> {
    return (await this.findOwnSync(caller, id)) !== null;
  }

  private findOwnSync(caller: ConnectionCaller, id: string) {
    return this.prisma.bitbucketRepoSync.findFirst({
      where: { id, bitbucketInstance: this.instanceWhere(caller) },
      select: { id: true },
    });
  }

  async list(caller: ConnectionCaller): Promise<BitbucketRepoSyncDto[]> {
    const rows = await this.prisma.bitbucketRepoSync.findMany({
      where: { bitbucketInstance: this.instanceWhere(caller) },
      include: { _count: { select: { boardSources: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => toBitbucketRepoSyncDto(r, r._count.boardSources));
  }

  async create(
    caller: ConnectionCaller,
    input: { bitbucketInstanceId: string; repoFullName: string; projectKey?: string | null } & BitbucketRepoSyncFlags,
  ) {
    const instance = await this.resolveInstance(caller, input.bitbucketInstanceId);
    assertRepoInWorkspace(input.repoFullName, instance.workspace);
    return this.prisma.bitbucketRepoSync.create({
      data: {
        bitbucketInstanceId: instance.id,
        repoFullName: input.repoFullName,
        projectKey: input.projectKey ?? null,
        syncPrs: input.syncPrs ?? true,
        syncCommits: input.syncCommits ?? true,
        syncDeployments: input.syncDeployments ?? true,
      },
    });
  }

  /**
   * Find-or-create, the board "add source" path. Flags default ON (the
   * GitLab "SuperPay bug": a sync created with them off never synced anything,
   * and the board UI has no toggle to notice). An existing row keeps its flags;
   * only a missing projectKey is filled in.
   */
  async ensure(caller: ConnectionCaller, instanceId: string, repoFullName: string, projectKey?: string | null) {
    const instance = await this.resolveInstance(caller, instanceId);
    assertRepoInWorkspace(repoFullName, instance.workspace);
    return this.prisma.bitbucketRepoSync.upsert({
      where: { bitbucketInstanceId_repoFullName: { bitbucketInstanceId: instance.id, repoFullName } },
      update: projectKey ? { projectKey } : {},
      create: {
        bitbucketInstanceId: instance.id,
        repoFullName,
        projectKey: projectKey ?? null,
        syncPrs: true,
        syncCommits: true,
        syncDeployments: true,
      },
    });
  }

  /** Null when the sync is not the caller's. */
  async update(caller: ConnectionCaller, id: string, patch: BitbucketRepoSyncFlags) {
    if (!(await this.findOwnSync(caller, id))) return null;
    return this.prisma.bitbucketRepoSync.update({ where: { id }, data: patch });
  }

  /** False when the sync is not the caller's. Cascades its board sources. */
  async delete(caller: ConnectionCaller, id: string): Promise<boolean> {
    if (!(await this.findOwnSync(caller, id))) return false;
    await this.prisma.bitbucketRepoSync.delete({ where: { id } });
    return true;
  }
}
