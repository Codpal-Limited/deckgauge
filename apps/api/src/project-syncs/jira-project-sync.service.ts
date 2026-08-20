import type { PrismaClient } from '@deckgauge/db';
import type { JiraProjectSyncDto } from '@deckgauge/shared';

export class JiraProjectSyncService {
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
  async list(organizationId: string): Promise<JiraProjectSyncDto[]> {
    const rows = await this.prisma.jiraProjectSync.findMany({
      where: { jiraInstance: { organizationId } },
      include: { _count: { select: { boardSources: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      jiraInstanceId: r.jiraInstanceId,
      jiraProjectKey: r.jiraProjectKey,
      syncChangelog: r.syncChangelog,
      syncWorklogs: r.syncWorklogs,
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      boardCount: r._count.boardSources,
    }));
  }

  async create(input: { jiraInstanceId: string; jiraProjectKey: string; syncChangelog: boolean; syncWorklogs: boolean }) {
    return this.prisma.jiraProjectSync.create({ data: input });
  }

  async update(id: string, patch: Partial<{ syncChangelog: boolean; syncWorklogs: boolean }>) {
    return this.prisma.jiraProjectSync.update({ where: { id }, data: patch });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.jiraProjectSync.delete({ where: { id } });
  }

  async ensureSync(jiraInstanceId: string, jiraProjectKey: string) {
    return this.prisma.jiraProjectSync.upsert({
      where: { jiraInstanceId_jiraProjectKey: { jiraInstanceId, jiraProjectKey } },
      update: {},
      create: { jiraInstanceId, jiraProjectKey, syncChangelog: true, syncWorklogs: false },
    });
  }
}
