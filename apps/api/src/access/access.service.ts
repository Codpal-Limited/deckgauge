import type { PrismaClient } from '@deckgauge/db';
import {
  ACCESS_ROLE_RANK,
  type AccessEntityKind,
  type AccessEntry,
  type AccessRoleValue,
  type OrgRoleValue,
} from '@deckgauge/shared';
import { effectiveBoardRole } from '../authz/policy.js';
import { ACCESS_ENTITIES, type AccessEntityDescriptor } from './access.entities.js';
import {
  LastOwnerError,
  RoleExceedsOrgRoleError,
  TargetNotInOrganizationError,
} from './last-owner.error.js';

/** Any Prisma delegate over an access table, narrowed to what this service calls. */
interface AccessDelegate {
  findUnique(args: unknown): Promise<{ role: AccessRoleValue } | null>;
  findMany(args: unknown): Promise<unknown[]>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<{ role: AccessRoleValue }>;
  update(args: unknown): Promise<{ role: AccessRoleValue }>;
  delete(args: unknown): Promise<unknown>;
}

const USER_SELECT = { id: true, name: true, email: true, avatarUrl: true } as const;

/** Shape `list`'s `findMany` returns, with the optional `orgMemberships` join. */
interface ListRow {
  userId: string;
  role: AccessRoleValue;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    orgMemberships?: { role: OrgRoleValue }[];
  };
}

/**
 * One implementation of sharing for every shareable entity.
 *
 * Generalized from `OrgTreeAccessService`, not `BoardAccessService`: the org-tree
 * version was the only one of the three that guarded *demotion* as well as
 * revocation, which is the difference between "cannot remove the last owner" and
 * "cannot reach a state with no owner" (design D11).
 *
 * Every read-then-write runs at `Serializable`, because the invariant is a count
 * across rows the statement does not itself lock: two owners demoting each other
 * concurrently both read "2 owners", both pass, and the entity ends up ownerless
 * (D8). `MembershipService.assertNotLastAdmin` solves the same problem the same
 * way.
 */
export class AccessService {
  constructor(private readonly prisma: PrismaClient) {}

  private describe(kind: AccessEntityKind): AccessEntityDescriptor {
    const descriptor = ACCESS_ENTITIES[kind];
    // A kind reaching here with no descriptor is a wiring bug, not a permission
    // decision — surface it as a 500 rather than letting it read as "no access".
    if (!descriptor) throw new Error(`No access descriptor registered for kind "${kind}"`);
    return descriptor;
  }

  private delegate(kind: AccessEntityKind, tx: PrismaClient = this.prisma): AccessDelegate {
    return tx[this.describe(kind).delegate] as unknown as AccessDelegate;
  }

  private where(kind: AccessEntityKind, entityId: string) {
    return { [this.describe(kind).entityIdField]: entityId };
  }

  private key(kind: AccessEntityKind, entityId: string, userId: string) {
    const { compoundKey, entityIdField } = this.describe(kind);
    return { [compoundKey]: { [entityIdField]: entityId, userId } };
  }

  /**
   * `organizationId` joins each row's `orgRole` through the user's ACTIVE
   * membership in that organization — `null` when the caller has no
   * organization to join through (pre-bootstrap/break-glass), in which case
   * every entry's `orgRole` is `null` too. This is the same "caller's
   * organization, not a value looked up per-entity" shape as `grant` (see its
   * doc comment) — the entity-organization check itself is a documented,
   * deferred multi-org precondition.
   */
  async list(
    kind: AccessEntityKind,
    entityId: string,
    organizationId: string | null = null,
  ): Promise<AccessEntry[]> {
    const rows = (await this.delegate(kind).findMany({
      where: this.where(kind, entityId),
      select: {
        userId: true,
        role: true,
        user: {
          select: {
            ...USER_SELECT,
            ...(organizationId
              ? {
                  orgMemberships: {
                    where: { organizationId, status: 'ACTIVE' },
                    select: { role: true },
                    take: 1,
                  },
                }
              : {}),
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })) as ListRow[];

    return rows.map((row) => ({
      userId: row.userId,
      role: row.role,
      orgRole: row.user.orgMemberships?.[0]?.role ?? null,
      user: {
        id: row.user.id,
        name: row.user.name,
        email: row.user.email,
        avatarUrl: row.user.avatarUrl,
      },
    }));
  }

  async getRole(
    kind: AccessEntityKind,
    entityId: string,
    userId: string,
  ): Promise<AccessRoleValue | null> {
    const row = await this.delegate(kind).findUnique({
      where: this.key(kind, entityId, userId),
    });
    return row?.role ?? null;
  }

  /**
   * `organizationId` is the *caller's* organization, never a value from the
   * request body: it is what makes the target check a tenancy check.
   *
   * Pass `null` only where the policy layer deliberately admits a caller with no
   * membership — the pre-bootstrap admin and the break-glass path (design D9).
   * There is no organization for a target to be outside of in that state.
   */
  async grant(
    kind: AccessEntityKind,
    entityId: string,
    userId: string,
    role: AccessRoleValue,
    organizationId: string | null,
  ): Promise<AccessRoleValue> {
    const targetOrgRole = await this.assertTargetIsGrantable(userId, organizationId);
    this.assertRoleWithinCeiling(targetOrgRole, role);
    const created = await this.delegate(kind).create({
      data: { ...this.where(kind, entityId), userId, role },
    });
    return created.role;
  }

  /**
   * `organizationId` is the *caller's* organization, exactly like `grant` —
   * `null` only for the pre-bootstrap/break-glass case, where there is no
   * ceiling to enforce.
   */
  async updateRole(
    kind: AccessEntityKind,
    entityId: string,
    userId: string,
    role: AccessRoleValue,
    organizationId: string | null,
  ): Promise<AccessRoleValue | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await this.delegate(kind, tx as PrismaClient).findUnique({
          where: this.key(kind, entityId, userId),
        });
        if (!existing) return null;
        const targetOrgRole = await this.getTargetOrgRole(userId, organizationId, tx as PrismaClient);
        this.assertRoleWithinCeiling(targetOrgRole, role);
        await this.assertNotLastOwner(kind, entityId, existing.role, role, tx as PrismaClient);
        const updated = await this.delegate(kind, tx as PrismaClient).update({
          where: this.key(kind, entityId, userId),
          data: { role },
        });
        return updated.role;
      },
      { isolationLevel: 'Serializable' as const },
    );
  }

  async revoke(kind: AccessEntityKind, entityId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const existing = await this.delegate(kind, tx as PrismaClient).findUnique({
          where: this.key(kind, entityId, userId),
        });
        if (!existing) return;
        await this.assertNotLastOwner(kind, entityId, existing.role, null, tx as PrismaClient);
        await this.delegate(kind, tx as PrismaClient).delete({
          where: this.key(kind, entityId, userId),
        });
      },
      { isolationLevel: 'Serializable' as const },
    );
  }

  /**
   * Takes the target's *current* role from the caller rather than re-querying it,
   * so this never masks a not-found row behind an owner-count check. `nextRole`
   * is `null` for a revocation and the new role for a change — which is what
   * makes demotion covered, not only removal.
   */
  private async assertNotLastOwner(
    kind: AccessEntityKind,
    entityId: string,
    currentRole: AccessRoleValue,
    nextRole: AccessRoleValue | null,
    tx: PrismaClient,
  ): Promise<void> {
    if (nextRole === 'OWNER') return;
    if (currentRole !== 'OWNER') return;
    const owners = await this.delegate(kind, tx).count({
      where: { ...this.where(kind, entityId), role: 'OWNER' },
    });
    if (owners <= 1) throw new LastOwnerError(kind);
  }

  /**
   * Returns the target's organization role rather than discarding it, so
   * `grant` can enforce the ceiling (below) without a second query. `null`
   * only in the no-organization branch — there is no membership to have a
   * role in.
   */
  private async assertTargetIsGrantable(
    userId: string,
    organizationId: string | null,
  ): Promise<OrgRoleValue | null> {
    if (!organizationId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new TargetNotInOrganizationError();
      return null;
    }
    const membership = await this.prisma.orgMembership.findFirst({
      where: { organizationId, userId, status: 'ACTIVE' },
      select: { role: true },
    });
    if (!membership) throw new TargetNotInOrganizationError();
    return membership.role as OrgRoleValue;
  }

  /**
   * `updateRole` has no existing-grantable check to piggyback on the way
   * `grant` does — the target already holds an access row by definition, so
   * this is purely a lookup for the ceiling check below. `null` when there is
   * no organization to check against, or the target holds no ACTIVE
   * membership in it (an edge case `grant` already prevents from arising via
   * `assertTargetIsGrantable`, but this method does not re-verify it — an
   * access row outliving a membership is a revoke/administration concern, not
   * this check's job).
   */
  private async getTargetOrgRole(
    userId: string,
    organizationId: string | null,
    tx: PrismaClient,
  ): Promise<OrgRoleValue | null> {
    if (!organizationId) return null;
    const membership = await tx.orgMembership.findFirst({
      where: { organizationId, userId, status: 'ACTIVE' },
      select: { role: true },
    });
    return (membership?.role as OrgRoleValue | undefined) ?? null;
  }

  /**
   * The ceiling rule (spec D3/D7), enforced once at the service layer so
   * every caller — invite, per-row role change, or a future API consumer —
   * gets it for free. `targetOrgRole` of `null` means there is nothing to cap
   * against (pre-bootstrap/break-glass), so the request is admitted as-is.
   *
   * A RANK comparison, not an identity comparison: `effectiveBoardRole`
   * short-circuits an org ADMIN to `'OWNER'` regardless of the requested
   * role (`authz/policy.ts`), so `effective !== requestedRole` would also
   * reject granting an ADMIN target `EDITOR` or `VIEWER` — an ELEVATION
   * above what was asked, not an excess of it. The ceiling only exists to
   * stop a grant from reaching higher than the org role allows; it must
   * never fire because the org role would honour *more* than was requested.
   * Only `effective < requested` is a real excess — and given
   * `effectiveBoardRole`'s definition, that is only ever reachable when
   * `targetOrgRole` is `'VIEWER'` and `requestedRole` is `'EDITOR'` or
   * `'OWNER'`.
   */
  private assertRoleWithinCeiling(
    targetOrgRole: OrgRoleValue | null,
    requestedRole: AccessRoleValue,
  ): void {
    if (targetOrgRole === null) return;
    const effective = effectiveBoardRole(targetOrgRole, requestedRole);
    if (!effective || ACCESS_ROLE_RANK[effective] < ACCESS_ROLE_RANK[requestedRole]) {
      throw new RoleExceedsOrgRoleError();
    }
  }
}
