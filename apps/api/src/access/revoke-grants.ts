import type { PrismaClient, Prisma } from '@deckgauge/db';
import { ACCESS_ENTITIES, type AccessEntityKind } from '@deckgauge/shared';

/** The top-level client or an interactive-transaction handle — both expose the model delegates. */
type Db = PrismaClient | Prisma.TransactionClient;

/** The subset of a Prisma ACL delegate this module calls. */
interface DeletableDelegate {
  deleteMany(args: unknown): Promise<{ count: number }>;
}

/** How many grant rows were revoked, per entity kind. */
export type RevokedGrantCounts = Record<string, number>;

/**
 * Revokes every grant `userId` holds on entities belonging to `organizationId`.
 *
 * Written for offboarding. `OrgMembership` is not a parent of any grant table —
 * all five are keyed `(entityId, userId)` and hold a foreign key to the ENTITY
 * and to `User`, never to the membership — so deleting a membership can cascade
 * to nothing, and the revoke has to be issued explicitly. See
 * `MembershipService.remove`, its only caller.
 *
 * Scoped to ONE organization, deliberately: the same `User` may hold a
 * membership elsewhere, and leaving Acme must not cost them their Initech
 * boards. That scoping is the whole reason this reads the entity's tenant rather
 * than simply deleting every grant the user holds.
 *
 * Driven off `ACCESS_ENTITIES` rather than a hand-written list of five tables, so
 * a sixth shareable kind is covered by the descriptor row that adds it. A
 * board-only revoke was the shape this hole was first reported in; four of the
 * five kinds would have stayed open.
 *
 * Takes a `Db` so the caller can pass its transaction handle. It must be
 * transactional with the membership delete: a half-applied offboarding either
 * strips access while leaving the membership (locking a current member out) or
 * deletes the membership while leaving access (the leak this closes).
 */
export async function revokeOrganizationGrantsForUser(
  db: Db,
  organizationId: string,
  userId: string,
): Promise<RevokedGrantCounts> {
  const counts: RevokedGrantCounts = {};

  for (const kind of Object.keys(ACCESS_ENTITIES) as AccessEntityKind[]) {
    const descriptor = ACCESS_ENTITIES[kind];
    // `ACCESS_ENTITIES` is a Partial map, so this is reachable in types even
    // though every current kind has a row. THROW rather than `continue`: a
    // silently skipped kind is a grant this function promised to revoke and did
    // not, which is the exact failure it exists to prevent. `AccessService.describe`
    // throws on the same condition for the same reason.
    if (!descriptor) {
      throw new Error(
        `revokeOrganizationGrantsForUser: no ACCESS_ENTITIES descriptor for kind "${kind}" — ` +
          'refusing to offboard with a grant table unrevoked',
      );
    }

    // The same two shapes `AccessService.getEffectiveRole` uses to reach an
    // organization, applied one level further out — as a filter on the GRANT row
    // via its relation to the entity, rather than on the entity itself.
    //
    // `viaOrgTree` exists because `EmployeeBoardAccess` inherits tenancy through
    // its parent tree and carries no `organization_id` of its own (tenancy D6);
    // filtering it on a column it does not have would silently match nothing and
    // leave every employee-board grant behind.
    const entityIsInOrganization =
      descriptor.orgScope === 'own'
        ? { organizationId }
        : { orgTree: { organizationId } };

    const delegate = db[descriptor.delegate] as unknown as DeletableDelegate;
    const { count } = await delegate.deleteMany({
      // Both halves are load-bearing. Without `userId` this clears the entity's
      // whole ACL rather than one person's access; without the entity predicate
      // it reaches into organizations the user still belongs to.
      where: { userId, [descriptor.entityRelation]: entityIsInOrganization },
    });
    counts[kind] = count;
  }

  return counts;
}
