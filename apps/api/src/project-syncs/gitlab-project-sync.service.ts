import type { PrismaClient } from '@deckgauge/db';
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';

export interface GitLabProjectSyncRow {
  id: string;
  gitlabInstanceId: string;
  projectPath: string;
  syncPrs: boolean;
  syncCommits: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  boardCount: number;
}

export class GitLabProjectSyncService {
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
  async list(caller: ConnectionCaller): Promise<GitLabProjectSyncRow[]> {
    const rows = await this.prisma.gitLabProjectSync.findMany({
      // Ownership rides on the SAME relation as tenancy: a sync row carries
      // neither an organization nor an owner of its own.
      where: { gitlabInstance: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) } },
      include: { _count: { select: { boardSources: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      gitlabInstanceId: r.gitlabInstanceId,
      projectPath: r.projectPath,
      syncPrs: r.syncPrs,
      syncCommits: r.syncCommits,
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      boardCount: r._count.boardSources,
    }));
  }

  async create(input: {
    gitlabInstanceId: string;
    projectPath: string;
    syncPrs: boolean;
    syncCommits: boolean;
  }) {
    return this.prisma.gitLabProjectSync.create({ data: input });
  }

  async update(id: string, patch: Partial<{ syncPrs: boolean; syncCommits: boolean }>) {
    return this.prisma.gitLabProjectSync.update({ where: { id }, data: patch });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.gitLabProjectSync.delete({ where: { id } });
  }

  async ensureSync(gitlabInstanceId: string, projectPath: string) {
    // Default the code-sync flags ON. This is the path the board "add source"
    // flow uses, and the board UI exposes no commits/PRs toggle for GitLab
    // (unlike ADO). Creating with the flags off meant a GitLab source added
    // from a board silently never synced commits/MRs — the SuperPay bug.
    return this.prisma.gitLabProjectSync.upsert({
      where: { gitlabInstanceId_projectPath: { gitlabInstanceId, projectPath } },
      update: {},
      create: { gitlabInstanceId, projectPath, syncPrs: true, syncCommits: true },
    });
  }
}
