import type { PrismaClient, BoardAccessRole } from '@deckgauge/db';
import {
  ACCESS_ENTITIES,
  effectiveBoardRole,
  type AccessEntityKind,
  type OrgRoleValue,
} from '@deckgauge/shared';

/**
 * "Which of these candidates may be notified about this entity?"
 *
 * This is the reverse of every other access helper in the codebase.
 * `accessibleBoardIds` and friends answer *"which of these entities can this one
 * user reach"*; a mention needs *"which of these users can reach this one
 * entity"*. Same rule, opposite direction — so the rule itself is not
 * re-implemented here: both sides go through `effectiveBoardRole`, where the
 * organization role is a ceiling AND a floor.
 *
 * Two queries regardless of how many people were mentioned. Looping
 * `accessibleBoardIds` per candidate would be N round trips and would bury the
 * rule inside a loop body.
 *
 * Neither function trusts the candidate list for anything but narrowing: the ids
 * come from a comment body the browser wrote (design D2), so the answer is always
 * a subset of what was asked, and membership is what admits, never the id itself.
 */

/** Combines the two lookups through the shared rule. Shared by both variants. */
function admitted(
  memberships: ReadonlyArray<{ userId: string | null; role: string }>,
  grantOf: ReadonlyMap<string, BoardAccessRole>,
): Set<string> {
  const out = new Set<string>();
  for (const m of memberships) {
    // A membership row can exist with no user bound (an invite that was never
    // accepted). There is nobody to notify.
    if (!m.userId) continue;
    if (effectiveBoardRole(m.role as OrgRoleValue, grantOf.get(m.userId) ?? null)) {
      out.add(m.userId);
    }
  }
  return out;
}

function narrow(candidateIds: readonly string[]): string[] {
  return [...new Set(candidateIds)].filter((id) => id.length > 0);
}

export async function notifiableOnBoard(
  prisma: PrismaClient,
  boardId: string,
  organizationId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const unique = narrow(candidateIds);
  if (unique.length === 0) return new Set();

  const [grants, memberships] = await Promise.all([
    prisma.boardAccess.findMany({
      where: { boardId, userId: { in: unique } },
      select: { userId: true, role: true },
    }),
    prisma.orgMembership.findMany({
      where: { organizationId, status: 'ACTIVE', userId: { in: unique } },
      select: { userId: true, role: true },
    }),
  ]);

  // Iterating MEMBERSHIPS, not grants: an access row that outlived its
  // membership must not make an ex-colleague notifiable.
  return admitted(memberships, new Map(grants.map((g) => [g.userId, g.role])));
}

export async function notifiableOnOrgTree(
  prisma: PrismaClient,
  orgTreeId: string,
  organizationId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const unique = narrow(candidateIds);
  if (unique.length === 0) return new Set();

  const [grants, memberships] = await Promise.all([
    prisma.orgTreeAccess.findMany({
      where: { orgTreeId, userId: { in: unique } },
      select: { userId: true, role: true },
    }),
    prisma.orgMembership.findMany({
      where: { organizationId, status: 'ACTIVE', userId: { in: unique } },
      select: { userId: true, role: true },
    }),
  ]);

  return admitted(memberships, new Map(grants.map((g) => [g.userId, g.role])));
}

/**
 * The reverse access query for the five SHAREABLE kinds, driven by the same
 * `ACCESS_ENTITIES` descriptor map `AccessService.grant` uses — so "who may be
 * notified about this entity" cannot drift from "who may be granted it".
 *
 * Entity-specific widening rules (an OWNER grant on a parent org tree, the
 * personal-board flag) are deliberately NOT re-implemented here. They only ever
 * ADD access, and the recipient of a share notification is by definition someone
 * who just received an explicit grant row — so the narrow check admits exactly
 * the case this is used for, and errs toward silence rather than toward leaking.
 */
export async function notifiableOnEntity(
  prisma: PrismaClient,
  kind: AccessEntityKind,
  entityId: string,
  organizationId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const unique = narrow(candidateIds);
  if (unique.length === 0) return new Set();

  const descriptor = ACCESS_ENTITIES[kind];
  // A kind with no descriptor is a wiring bug, not a permission decision.
  if (!descriptor) throw new Error(`No access descriptor registered for kind "${kind}"`);

  const delegate = prisma[descriptor.delegate] as unknown as {
    findMany(args: unknown): Promise<{ userId: string; role: BoardAccessRole }[]>;
  };

  const [grants, memberships] = await Promise.all([
    delegate.findMany({
      where: { [descriptor.entityIdField]: entityId, userId: { in: unique } },
      select: { userId: true, role: true },
    }),
    prisma.orgMembership.findMany({
      where: { organizationId, status: 'ACTIVE', userId: { in: unique } },
      select: { userId: true, role: true },
    }),
  ]);

  return admitted(memberships, new Map(grants.map((g) => [g.userId, g.role])));
}
