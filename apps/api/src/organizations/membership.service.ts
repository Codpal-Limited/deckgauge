import type { PrismaClient, Prisma, OrgMembership } from '@deckgauge/db';
import {
  InviteMemberSchema,
  type InviteMemberInput,
  type OrgMemberDto,
  type OrgRoleValue,
  type OrgMembershipStatusValue,
  type OrgMembershipOptionDto,
} from '@deckgauge/shared';
import { revokeOrganizationGrantsForUser } from '../access/revoke-grants.js';

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
  /**
   * Set ONLY when this very call bound a PENDING invite to the account and
   * flipped it to ACTIVE. That transition is the one moment a workspace invite
   * has somebody to notify — before it, there is no bound user; after it, the
   * caller cannot tell a fresh activation from any other login.
   *
   * A membership id rather than a boolean, so the caller can hand it straight to
   * the notification trigger without re-querying to find which row it was.
   */
  justActivatedMembershipId?: string;
}

/** Narrows an unknown catch value to Prisma's unique-constraint-violation shape (P2002). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

export class MembershipService {
  /**
   * `logger` is optional so every existing `new MembershipService(prisma)` call
   * site keeps working. Its one current use is the offboarding revoke, which
   * deletes grants across five tables and should not do so silently.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger?: { info: (obj: unknown, msg: string) => void },
  ) {}

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
   * The membership named by `User.activeOrganizationId`, or `null` when there is
   * no choice recorded or the choice is no longer valid.
   *
   * The choice is PASSED IN rather than queried: the auth plugin already holds
   * the whole `User` row it upserted, so re-reading it would add a query to every
   * authenticated request for data already in hand. The membership validation
   * below is the one lookup that cannot be skipped — it is the whole point.
   */
  private async findChosenMembership(userId: string, activeOrganizationId: string | null) {
    if (!activeOrganizationId) return null;
    const organizationId = activeOrganizationId;

    return this.prisma.orgMembership.findFirst({
      where: { userId, organizationId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: { organizationId: true, role: true, status: true },
    });
  }

  /**
   * The caller's bound membership at one status, under a TOTAL order.
   *
   * Order: earliest `activatedAt` first, then `organizationId` ascending. The
   * second key is not decoration — two memberships activated in the same
   * transaction share an instant, and without a tiebreak that is exactly where
   * non-determinism hides. Postgres sorts NULLs last in ASC, which is also the
   * answer we want: an unknown join time is not "earliest".
   */
  private findBoundMembership(userId: string, status: 'ACTIVE' | 'SUSPENDED') {
    return this.prisma.orgMembership.findFirst({
      where: { userId, status },
      orderBy: [{ activatedAt: 'asc' }, { organizationId: 'asc' }],
      select: { organizationId: true, role: true, status: true },
    });
  }

  /**
   * Resolves the caller's organization once per request (spec §5.1):
   *   1. a membership already bound to this userId, or
   *   2. a PENDING invite matching the token's email — bind and activate it, or
   *   3. null, which the auth plugin turns into 403 NO_ORGANIZATION.
   *
   * **Deterministic when the caller holds more than one** (§11 precondition 2).
   * Both lookups here were unordered `findFirst` calls, so the answer was
   * whatever Postgres happened to return: the same user could resolve to a
   * different organization on two consecutive requests, and one of those
   * orderings was actively wrong — a SUSPENDED membership could win over an
   * ACTIVE one and hand someone a session in the organization that suspended
   * them. Latent under the one-organization cap; live the moment
   * DECKGAUGE_MULTI_ORG is enabled.
   *
   * ACTIVE is preferred over SUSPENDED by querying them SEPARATELY rather than
   * by ordering on `status`. Ordering on an enum column sorts by the enum's
   * declaration order in Postgres, which would make a correctness property
   * depend on where someone adds the next status value.
   *
   * This picks a DEFAULT, not a user's choice. An explicit switcher — a
   * persisted "active organization" a member can change — is the remaining half
   * of precondition 2 and is not built; see planning/TENANCY-PROGRAMME.md.
   */
  async resolveForUser(
    userId: string,
    email: string,
    activeOrganizationId: string | null = null,
  ): Promise<ResolvedMembership | null> {
    // An explicit choice wins over the default — but only while it still names a
    // membership this person holds. That check is what makes the column a
    // PREFERENCE and not a grant: revoking a membership takes effect without
    // anyone clearing it, a value pointing at an organization they never joined
    // does nothing, and a dangling id whose organization was deleted degrades to
    // "ignored" rather than to an error.
    //
    // ACTIVE or SUSPENDED, matching the default's own range: honouring a
    // suspended choice lets the auth plugin answer "your membership is
    // suspended", which is more use than silently relocating someone to another
    // organization without telling them.
    const chosen = await this.findChosenMembership(userId, activeOrganizationId);

    const bound =
      chosen ??
      (await this.findBoundMembership(userId, 'ACTIVE')) ??
      (await this.findBoundMembership(userId, 'SUSPENDED'));
    if (bound) {
      return {
        organizationId: bound.organizationId,
        role: bound.role as OrgRoleValue,
        status: bound.status as 'ACTIVE' | 'SUSPENDED',
      };
    }

    // Oldest invite wins, with the same total-order tiebreak. "The first person
    // who invited you" is explainable to a user; "whichever row came back" is
    // not.
    const pending = await this.prisma.orgMembership.findFirst({
      where: { email: email.toLowerCase(), userId: null, status: 'PENDING' },
      orderBy: [{ invitedAt: 'asc' }, { organizationId: 'asc' }],
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
      justActivatedMembershipId: pending.id,
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
  ): Promise<{
    id: string;
    role: OrgRoleValue;
    status: OrgMembershipStatusValue;
    /**
     * Null on a PENDING invite that no login has bound yet. `remove` needs it to
     * know WHOSE grants to revoke — and a null means there is nobody with grants,
     * so the revoke is skipped rather than issued with a null key.
     */
    userId: string | null;
  }> {
    const row = await db.orgMembership.findFirst({
      where: { id: membershipId, organizationId },
      select: { id: true, role: true, status: true, userId: true },
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

  /**
   * Ends a membership — and with it, the access that membership was the reason
   * for.
   *
   * The revoke is not housekeeping, it is the point. No grant table has a foreign
   * key to `OrgMembership` (all five are keyed `(entityId, userId)` and reference
   * the ENTITY and `User`), so deleting the membership row cascades to nothing
   * and an offboarded user kept every grant they held. Their next request
   * resolved `membership: null`, fell to `evaluatePolicy`'s no-membership path,
   * and the stale grant decided alone — at the role it granted. That was live in
   * the single-tenant product and reachable with a token; the web app only hid it
   * by redirecting a membership-less caller to `/no-organization`.
   *
   * Inside the EXISTING transaction, before the delete, so the lockout guard and
   * the revoke cannot half-apply: `assertNotLastAdmin` throwing rolls the revoke
   * back, rather than stripping the access of a member who was not removed.
   */
  async remove(organizationId: string, membershipId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const member = await this.requireMember(tx, organizationId, membershipId);
      await this.assertNotLastAdmin(tx, organizationId, member);
      // A PENDING invite has no bound user, so there is nobody holding grants.
      if (member.userId) {
        const revoked = await revokeOrganizationGrantsForUser(tx, organizationId, member.userId);
        // Logged, not discarded. Offboarding deletes rows across five tables, and
        // without this the only way to answer "what did removing Dana take away?"
        // is to query the database after the fact — by which point the rows are
        // gone. `logger` is optional so the service stays constructible in tests
        // that do not care.
        this.logger?.info(
          { organizationId, membershipId: member.id, userId: member.userId, revoked },
          'offboarding: revoked entity grants held in this organization',
        );
      }
      await tx.orgMembership.delete({ where: { id: member.id } });
    }, MembershipService.GUARDED_WRITE_OPTIONS);
  }

  /**
   * The organizations this person may act in, for the switcher.
   *
   * PENDING is excluded: an unbound invite is not somewhere you can act yet, and
   * offering it would imply a switch that must then fail. SUSPENDED IS included —
   * it is a place they have been, and hiding it would make "why can I not see
   * Acme any more?" unanswerable from the UI.
   */
  async listSwitchableFor(
    userId: string,
    activeOrganizationId: string | null,
  ): Promise<OrgMembershipOptionDto[]> {
    const rows = await this.prisma.orgMembership.findMany({
      where: { userId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      orderBy: [{ activatedAt: 'asc' }, { organizationId: 'asc' }],
      select: {
        organizationId: true,
        role: true,
        status: true,
        organization: { select: { name: true, slug: true } },
      },
    });
    return rows.map((r) => ({
      organizationId: r.organizationId,
      name: r.organization.name,
      slug: r.organization.slug,
      role: r.role as OrgRoleValue,
      status: r.status as 'ACTIVE' | 'SUSPENDED',
      isActive: r.organizationId === activeOrganizationId,
    }));
  }

  /**
   * Records an explicit choice of organization.
   *
   * **Refuses a membership the caller does not hold**, rather than writing the
   * value and letting `resolveForUser` ignore it later. Both would be safe, but
   * only one is honest: a switch that silently does nothing is indistinguishable
   * from a bug, and this endpoint's whole job is to take a tenant id from request
   * input — the one place in this codebase that deliberately does — so it has to
   * be the place that validates it.
   *
   * Returns `false` when the caller holds no such membership; the route 404s.
   */
  async setActiveOrganization(userId: string, organizationId: string): Promise<boolean> {
    const held = await this.prisma.orgMembership.findFirst({
      where: { userId, organizationId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: { id: true },
    });
    if (!held) return false;
    await this.prisma.user.update({ where: { id: userId }, data: { activeOrganizationId: organizationId } });
    return true;
  }

}
