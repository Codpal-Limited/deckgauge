import type { PrismaClient } from '@deckgauge/db';
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';

export interface GitHubRepoSyncRow {
  id: string;
  githubInstanceId: string;
  repoFullName: string;
  // Tier replaces the per-repo syncPrs/syncCommits flags removed in Task 16.
  // Tier governs how often the three-tier BullMQ queue re-runs the per-repo
  // bulk sync (hot=1h, warm=6h, cold=24h).
  tier: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
  boardCount: number;
}

export class GitHubRepoSyncService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Every sync row reachable from the caller’s organization, and only those.
   *
   * Scoped through the INSTANCE, which is where the tenant boundary lives — the
   * sync row itself carries no organization. Before this predicate the list
   * enumerated every organization's rows: no credential, but another tenant's
   * instance ids, project names and cadence, and the instance ids are the input
   * other routes take. The route is orgRole(MEMBER) so the membership this
   * argument comes from is guaranteed.
   */
  async list(caller: ConnectionCaller): Promise<GitHubRepoSyncRow[]> {
    const rows = await this.prisma.gitHubRepoSync.findMany({
      // Ownership rides on the SAME relation as tenancy: a sync row carries
      // neither an organization nor an owner of its own.
      where: { githubInstance: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) } },
      include: { _count: { select: { boardSources: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      githubInstanceId: r.githubInstanceId,
      repoFullName: r.repoFullName,
      tier: r.tier,
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
      lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      boardCount: r._count.boardSources,
    }));
  }

  async create(input: { githubInstanceId: string; repoFullName: string }) {
    return this.prisma.gitHubRepoSync.create({ data: input });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.gitHubRepoSync.delete({ where: { id } });
  }

  async ensureSync(githubInstanceId: string, repoFullName: string) {
    return this.prisma.gitHubRepoSync.upsert({
      where: { githubInstanceId_repoFullName: { githubInstanceId, repoFullName } },
      update: {},
      create: { githubInstanceId, repoFullName },
    });
  }
}
