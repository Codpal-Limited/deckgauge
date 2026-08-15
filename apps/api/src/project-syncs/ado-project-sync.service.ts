import type { PrismaClient } from '@deckgauge/db';

export interface AdoProjectSyncRow {
  id: string;
  azureDevOpsInstanceId: string;
  adoProject: string;
  syncPrs: boolean;
  syncCommits: boolean;
  syncRepos: string[];
  syncAllRepos: boolean;
  /**
   * Which release pipelines / stages count as a PRODUCTION deploy for this
   * project. BOTH empty means "not configured" — deploy frequency falls back to
   * the stage-name heuristic in deploymentsUnion. Exposed read-only here so the
   * settings table can show the current state in one request; writes go through
   * PUT /azure-devops/instances/:id/project-syncs/:project/production-config,
   * which is gated on connection ownership.
   */
  prodReleaseDefinitions: string[];
  prodStages: string[];
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  boardCount: number;
}

export class AdoProjectSyncService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<AdoProjectSyncRow[]> {
    const rows = await this.prisma.azureDevOpsProjectSync.findMany({
      include: { _count: { select: { boardSources: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      azureDevOpsInstanceId: r.azureDevOpsInstanceId,
      adoProject: r.adoProject,
      syncPrs: r.syncPrs,
      syncCommits: r.syncCommits,
      syncRepos: r.syncRepos,
      syncAllRepos: r.syncAllRepos,
      prodReleaseDefinitions: r.prodReleaseDefinitions ?? [],
      prodStages: r.prodStages ?? [],
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      boardCount: r._count.boardSources,
    }));
  }

  async create(input: {
    azureDevOpsInstanceId: string;
    adoProject: string;
    syncPrs: boolean;
    syncCommits: boolean;
    syncRepos: string[];
    syncAllRepos: boolean;
  }) {
    return this.prisma.azureDevOpsProjectSync.create({ data: input });
  }

  async update(
    id: string,
    patch: Partial<{ syncPrs: boolean; syncCommits: boolean; syncRepos: string[]; syncAllRepos: boolean }>
  ) {
    return this.prisma.azureDevOpsProjectSync.update({ where: { id }, data: patch });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.azureDevOpsProjectSync.delete({ where: { id } });
  }

  async ensureSync(azureDevOpsInstanceId: string, adoProject: string) {
    return this.prisma.azureDevOpsProjectSync.upsert({
      where: { azureDevOpsInstanceId_adoProject: { azureDevOpsInstanceId, adoProject } },
      update: {},
      create: { azureDevOpsInstanceId, adoProject, syncPrs: false, syncCommits: false, syncRepos: [], syncAllRepos: false },
    });
  }
}
