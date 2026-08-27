/**
 * Which connections a caller may use, as a Prisma `where` fragment.
 *
 * Spread into an existing scoped `where`, NEXT TO the organization predicate
 * rather than instead of it: the organization is the outer boundary (Phase C) and
 * this is an inner one within a single tenant.
 *
 *     where: { id, organizationId, ...visibleConnectionWhere(caller) }
 *
 * A connection the caller may not use then resolves to nothing, and the route
 * answers 404 — the same answer, and the same reasoning, as the cross-tenant
 * case: the guard never confirms the existence of an id the caller may not have.
 */

/** Undefined `userId` only on requests that resolved no local user. */
export interface ConnectionCaller {
  userId: string | undefined;
  organizationId: string;
  /**
   * ADMIN of THIS organization, read from the membership. Never `request.isAdmin`
   * — that unions the Keycloak realm role and `users.is_admin`, neither of which
   * is tenant-scoped. Phase C found two live privilege escalations from exactly
   * that confusion.
   */
  isOrgAdmin: boolean;
}

export type ConnectionVisibilityWhere =
  | Record<string, never>
  | { OR: Array<{ ownerUserId: string | null }> };

export function visibleConnectionWhere(caller: ConnectionCaller): ConnectionVisibilityWhere {
  if (caller.isOrgAdmin) return {};
  // `ownerUserId: undefined` would read as "no filter" in Prisma and match every
  // personal connection, so a caller with no user id gets the organization-wide
  // branch only.
  if (!caller.userId) return { OR: [{ ownerUserId: null }] };
  return { OR: [{ ownerUserId: null }, { ownerUserId: caller.userId }] };
}
