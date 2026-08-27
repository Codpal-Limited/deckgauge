import type { PrismaClient } from '@deckgauge/db';

/**
 * What the Advisor can learn about the user's own configuration for the page
 * they asked from.
 *
 * `available: false` is a real answer, not a failure: it is what lets the model
 * say "I can't see your configuration for this, but here is how the feature
 * works" instead of inventing values. Every resolver returns it rather than
 * throwing — an unmapped page, an unbound board, and an empty configuration are
 * all ordinary outcomes.
 */
export type PageStateResult =
  | { available: true; page: string; state: Record<string, unknown> }
  | { available: false; reason: string };

export interface PageStateDeps {
  prisma: PrismaClient;
  /**
   * The authenticated caller, supplied by the route from `req.user.id` and
   * never from the request body or the model.
   *
   * Required, not optional: it is an authorization input, so a caller that
   * forgets it must fail to compile rather than silently degrade. The roadmap
   * read uses it to drop groups whose board the caller cannot view
   * (`RoadmapService.readDetail`) — without it the Advisor would be a way to
   * read project rows from boards the asker holds no role on.
   *
   * It authorizes; it does not attribute. Nothing in a page-state payload is
   * keyed by this id — `employeeId` and `orgTreeId` are not user ids — so it
   * still cannot tell the model which row belongs to the person asking (see
   * `internalIdentifiersNote`).
   */
  userId: string;
  /**
   * The organization the caller belongs to, from `request.membership` — never
   * from the request body and never from the model.
   *
   * Required, not optional, for the same reason `userId` is: it is the ONLY
   * predicate confining these reads to one tenant, so a caller that forgets it
   * must fail to compile rather than silently read every organization's rows.
   * That is not hypothetical — it is what these resolvers did until 2026-08-26
   * (TENANCY-PROGRAMME §5a). Every read below is instance-wide by design, which
   * makes the caller's organization the boundary; there is no entity id to
   * verify, and its absence was mistaken for the absence of anything to check.
   */
  organizationId: string;
  /**
   * Whether the caller is an ADMIN of THAT organization — `membership.role`,
   * resolved through `connectionCaller`, never `request.isAdmin` (which unions
   * the Keycloak realm role and `users.is_admin` and is not tenant-scoped).
   *
   * Required for the same reason as `organizationId`, and separate from it
   * because it governs a DIFFERENT boundary: connection ownership WITHIN one
   * tenant. The sources resolver lists sync rows hanging off connections, and a
   * member's personal connection is not visible to their colleagues — so
   * filtering on the organization alone would close the cross-tenant leak and
   * leave an in-tenant one. See `connections/connection-visibility.ts`.
   */
  isOrgAdmin: boolean;
  /**
   * The board the request was authorized against, if any. Supplied by the
   * route AFTER `hasBoardAccess`; a resolver must never accept a board id from
   * the model.
   *
   * **No resolver reads this today.** Every mapped page is instance-wide or
   * roadmap-scoped: the sources resolver was retargeted at the instance-wide
   * sync tables its pages actually list, and the board-shaped page keys
   * (`board`, `boards`, `comparison`) have no resolver at all. It stays because
   * the route still verifies a supplied `boardId` hint — so a bad id cannot
   * become a probe — and a future board-scoped resolver must receive the
   * verified value, never re-read the request body.
   */
  boardId?: string;
  /**
   * The standalone Roadmap entity the request was authorized against, if
   * any. Supplied by the route AFTER `RoadmapService.getRole` returned a
   * role; a resolver must never accept a roadmap id from the model.
   */
  roadmapId?: string;
}

export interface PageStateArgs {
  /** Roadmap only: which item the user is asking about, matched by name. */
  itemName?: string;
}

export function unavailable(reason: string): PageStateResult {
  return { available: false, reason };
}
