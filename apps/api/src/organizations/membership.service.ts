import type { PrismaClient, Prisma, OrgMembership } from '@deckgauge/db';
import {
  InviteMemberSchema,
  type InviteMemberInput,
  type OrgMemberDto,
  type OrgRoleValue,
  type OrgMembershipStatusValue,
} from '@deckgauge/shared';

/** Either the top-level client or an interactive-transaction handle — both expose the same model delegates. */
type Db = PrismaClient | Prisma.TransactionClient;

export class MemberAlreadyInvitedError extends Error {
  constructor(email: string) {
    super(`${email} already has a membership in this organization`);
    this.name = 'MemberAlreadyInvitedError';
  }
}

export class MemberNotFoundError extends Error {
  constructor(membershipId: string) {
    super(`Membership ${membershipId} not found in this organization`);
    this.name = 'MemberNotFoundError';
  }
}

/**
 * Raised when a status change targets a membership that is still PENDING.
 * Activation is first-login binding's job (see `resolveForUser`) — an admin
 * flipping a PENDING row to ACTIVE by hand would manufacture a membership
 * with no `userId`, which nobody can ever log in as.
 */
export class PendingMemberError extends Error {
  constructor(membershipId: string) {
    super(`Membership ${membershipId} is still PENDING; it activates on first login, not by admin action`);
    this.name = 'PendingMemberError';
  }
}

/**
 * Raised when an operation would leave the organization with no ACTIVE ADMIN.
 * Remove, demote, and suspend can each cause that, which is why the check is
 * shared rather than written into any one of them.
 */
export class LastAdminError extends Error {
  constructor() {
    super('The organization must keep at least one active admin');
    this.name = 'LastAdminError';
  }
}

export interface ResolvedMembership {
  organizationId: string;
  role: OrgRoleValue;
  status: 'ACTIVE' | 'SUSPENDED';
}

/** Narrows an unknown catch value to Prisma's unique-constraint-violation shape (P2002). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

export class MembershipService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * `count` then `update`/`delete` is two statements over rows that can
   * differ from the one being written (the "other" admins), so a plain
   * READ COMMITTED transaction does not close the race: two admins in a
   * two-admin org, removed concurrently, can each read the other as cover
   * and both commit — the classic write-skew anomaly. SERIALIZABLE makes
   * Postgres detect that read/write conflict and abort one side instead of
   * letting both through.
   */
  private static readonly GUARDED_WRITE_OPTIONS = {
    isolationLevel: 'Serializable' as const,
  };

  async invite(
    organizationId: string,
    input: InviteMemberInput,
    invitedByUserId: string | null,
  ): Promise<OrgMembership> {
    const validated = InviteMemberSchema.parse(input);

    const existing = await this.prisma.orgMembership.findUnique({
      where: { organizationId_email: { organizationId, email: validated.email } },
    });
    if (existing) throw new MemberAlreadyInvitedError(validated.email);

    try {
      return await this.prisma.orgMembership.create({
        data: {
          organizationId,
          email: validated.email,
          role: validated.role,
          status: 'PENDING',
          invitedByUserId,
        },
      });
    } catch (err: unknown) {
      // The pre-check above closes the common case with a clean error, but two
      // near-simultaneous invites for the same organization+email can both pass
      // it and race to create(); the loser hits the (organizationId, email)
      // unique constraint (P2002) instead. Translate that into the same domain
      // error so the method's contract holds under concurrency too.
      if (isUniqueConstraintViolation(err)) {
        throw new MemberAlreadyInvitedError(validated.email);
      }
      throw err;
    }
  }

  /**
   * Resolves the caller's organization once per request (spec §5.1):
   *   1. a membership already bound to this userId, or
   *   2. a PENDING invite matching the token's email — bind and activate it, or
   *   3. null, which the auth plugin turns into 403 NO_ORGANIZATION.
   *
   * Assumes a user belongs to at most one organization, which
   * DECKGAUGE_MULTI_ORG=false guarantees. See spec §11 precondition 2.
   */
  async resolveForUser(userId: string, email: string): Promise<ResolvedMembership | null> {
    const bound = await this.prisma.orgMembership.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: { organizationId: true, role: true, status: true },
    });
    if (bound) {
      return {
        organizationId: bound.organizationId,
        role: bound.role as OrgRoleValue,
        status: bound.status as 'ACTIVE' | 'SUSPENDED',
      };
    }

    const pending = await this.prisma.orgMembership.findFirst({
      where: { email: email.toLowerCase(), userId: null, status: 'PENDING' },
      select: { id: true, organizationId: true, role: true },
    });
    if (!pending) return null;

    await this.prisma.orgMembership.update({
      where: { id: pending.id },
      data: { userId, status: 'ACTIVE', activatedAt: new Date() },
    });

    return {
      organizationId: pending.organizationId,
      role: pending.role as OrgRoleValue,
      status: 'ACTIVE',
    };
  }

  async listMembers(organizationId: string): Promise<OrgMemberDto[]> {
    const rows = await this.prisma.orgMembership.findMany({
      where: { organizationId },
      orderBy: [{ status: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        email: true,
        userId: true,
        role: true,
        status: true,
        invitedAt: true,
        activatedAt: true,
        user: { select: { name: true } },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.user?.name ?? null,
      userId: r.userId,
      role: r.role,
      status: r.status,
      invitedAt: r.invitedAt.toISOString(),
      activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
    }));
  }

  /** Loads a membership, scoped to the organization so another tenant's id is simply absent. */
  private async requireMember(
    db: Db,
    organizationId: string,
    membershipId: string,
  ): Promise<{ id: string; role: OrgRoleValue; status: OrgMembershipStatusValue }> {
    const row = await db.orgMembership.findFirst({
      where: { id: membershipId, organizationId },
      select: { id: true, role: true, status: true },
    });
    if (!row) throw new MemberNotFoundError(membershipId);
    return row;
  }

  /**
   * The predicate for "an admin who can actually log in and fix things": ADMIN,
   * ACTIVE, and bound to a User. Shared by `assertNotLastAdmin` and
   * `countActiveAdmins` so the lockout guard and the boot warning can never
   * disagree about what counts as admin cover.
   */
  private static readonly LIVING_ADMIN = {
    role: 'ADMIN',
    status: 'ACTIVE',
    userId: { not: null },
  } as const;

  /**
   * How many administrators exist who could log in right now, across the whole
   * deployment. Deliberately **not** organization-scoped: the only caller is the
   * boot warning, which asks "does this deployment have any administrator at
   * all?" — and at boot there is no request, so no organization to scope to.
   * Under the enforced single-organization cap the two questions coincide.
   */
  async countActiveAdmins(): Promise<number> {
    return this.prisma.orgMembership.count({ where: MembershipService.LIVING_ADMIN });
  }

  /**
   * Throws when `membership` is the organization's only ACTIVE ADMIN and the
   * pending change would stop it being one. PENDING and SUSPENDED admins do not
   * count as cover — neither can log in and restore access. Neither does an
   * ACTIVE ADMIN row with no `userId`: no User is bound to it, so nobody can
   * ever authenticate as it either — the `userId: { not: null }` filter is
   * what makes that true regardless of how such a row came to exist.
   */
  private async assertNotLastAdmin(
    db: Db,
    organizationId: string,
    membership: { id: string; role: OrgRoleValue; status: OrgMembershipStatusValue },
  ): Promise<void> {
    if (membership.role !== 'ADMIN' || membership.status !== 'ACTIVE') return;

    const otherActiveAdmins = await db.orgMembership.count({
      where: {
        ...MembershipService.LIVING_ADMIN,
        organizationId,
        id: { not: membership.id },
      },
    });
    if (otherActiveAdmins === 0) throw new LastAdminError();
  }

  async updateRole(
    organizationId: string,
    membershipId: string,
    role: OrgRoleValue,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const member = await this.requireMember(tx, organizationId, membershipId);
      if (role !== 'ADMIN') await this.assertNotLastAdmin(tx, organizationId, member);
      await tx.orgMembership.update({ where: { id: member.id }, data: { role } });
    }, MembershipService.GUARDED_WRITE_OPTIONS);
  }

  async updateStatus(
    organizationId: string,
    membershipId: string,
    status: 'ACTIVE' | 'SUSPENDED',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const member = await this.requireMember(tx, organizationId, membershipId);
      // Activation is first-login binding's job (`resolveForUser`). Letting an
      // admin flip a PENDING row straight to ACTIVE would create a membership
      // with role/status matching a real admin but no `userId` behind it —
      // exactly the unrecoverable fake-cover state `assertNotLastAdmin` has to
      // defend against elsewhere. Refuse it at the source instead.
      if (member.status === 'PENDING') throw new PendingMemberError(membershipId);
      if (status !== 'ACTIVE') await this.assertNotLastAdmin(tx, organizationId, member);
      await tx.orgMembership.update({ where: { id: member.id }, data: { status } });
    }, MembershipService.GUARDED_WRITE_OPTIONS);
  }

  async remove(organizationId: string, membershipId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const member = await this.requireMember(tx, organizationId, membershipId);
      await this.assertNotLastAdmin(tx, organizationId, member);
      await tx.orgMembership.delete({ where: { id: member.id } });
    }, MembershipService.GUARDED_WRITE_OPTIONS);
  }
}
