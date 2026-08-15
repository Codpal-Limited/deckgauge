import type { PrismaClient, BoardAccessRole } from '@deckgauge/db';

export class LastOwnerError extends Error {
  constructor() {
    super('Cannot remove the last owner of an org tree');
    this.name = 'LastOwnerError';
  }
}

export class OrgTreeAccessService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(orgTreeId: string) {
    return this.prisma.orgTreeAccess.findMany({
      where: { orgTreeId },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async grant(orgTreeId: string, userId: string, role: BoardAccessRole) {
    return this.prisma.orgTreeAccess.upsert({
      where: { orgTreeId_userId: { orgTreeId, userId } },
      create: { orgTreeId, userId, role },
      update: { role },
    });
  }

  /**
   * Returns `null` when no access row exists for (orgTreeId, userId) — the
   * caller maps that to a 404, mirroring `BoardAccessService.updateRole`.
   */
  async updateRole(orgTreeId: string, userId: string, role: BoardAccessRole) {
    const existing = await this.prisma.orgTreeAccess.findUnique({
      where: { orgTreeId_userId: { orgTreeId, userId } },
    });
    if (!existing) return null;
    await this.assertNotLastOwner(orgTreeId, existing.role, role);
    return this.prisma.orgTreeAccess.update({
      where: { orgTreeId_userId: { orgTreeId, userId } },
      data: { role },
    });
  }

  /**
   * A no-op when no access row exists for (orgTreeId, userId) — idempotent,
   * mirroring `BoardAccessService.revokeAccess` (which returns early rather
   * than letting a missing row reach `delete` and throw P2025).
   */
  async revoke(orgTreeId: string, userId: string): Promise<void> {
    const existing = await this.prisma.orgTreeAccess.findUnique({
      where: { orgTreeId_userId: { orgTreeId, userId } },
    });
    if (!existing) return;
    await this.assertNotLastOwner(orgTreeId, existing.role, null);
    await this.prisma.orgTreeAccess.delete({
      where: { orgTreeId_userId: { orgTreeId, userId } },
    });
  }

  /**
   * A tree with no OWNER is administrable only by a Keycloak admin. Refuse the
   * operation rather than create that state — the same reasoning behind
   * refusing to delete the last board owner. Takes the target's *current*
   * role directly (already fetched by the caller) rather than re-querying it,
   * so this never masks a not-found row behind an owner-count check.
   */
  private async assertNotLastOwner(
    orgTreeId: string,
    currentRole: BoardAccessRole,
    nextRole: BoardAccessRole | null,
  ) {
    if (nextRole === 'OWNER') return;
    if (currentRole !== 'OWNER') return;
    const owners = await this.prisma.orgTreeAccess.count({
      where: { orgTreeId, role: 'OWNER' },
    });
    if (owners <= 1) throw new LastOwnerError();
  }
}
