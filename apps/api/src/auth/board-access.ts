import type { PrismaClient, BoardAccessRole } from '@deckgauge/db';
import type { OrgRoleValue } from '@deckgauge/shared';
import { effectiveBoardRole } from '../authz/policy.js';

/**
 * The caller's standing in their organization. **Optional and trailing** on the
 * functions below: a call site that has no membership to hand keeps the
 * historical raw-grant behaviour rather than failing to compile, and the
 * fail-closed contract holds either way.
 */
export type CallerMembership = { organizationId: string; role: OrgRoleValue } | null;

/** Board roles are totally ordered; a higher rank satisfies every lower one. */
export const ROLE_RANK: Record<BoardAccessRole, number> = { VIEWER: 0, EDITOR: 1, OWNER: 2 };

export function meetsRole(held: BoardAccessRole, required: BoardAccessRole): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

export interface BoardAccessLog {
  error: (obj: unknown, msg?: string) => void;
}

/**
 * The subset of `boardIds` the user holds at least `required` on, in one
 * query rather than N.
 *
 * This is the counterpart to `evaluatePolicy`'s `board` kind, for the places
 * a *declared route policy cannot reach*: a request whose board set lives in
 * the database rather than in the request (a comparison's member boards, a
 * roadmap's subscribed boards). Those need the same check applied twice — once
 * when a board is attached, and again every time the attached board's data is
 * read, so that access revoked after attachment actually takes effect.
 *
 * Fails closed: a lookup error yields the empty set (nothing accessible), so
 * callers deny or omit rather than leaking. The error is always logged — it is
 * never swallowed silently.
 *
 * Also fails closed on a missing `userId`: Prisma's `findMany` treats an
 * `undefined` value in a `where` clause as "no filter on this column", not
 * "match nothing" — `where: { userId: undefined, ... }` silently drops the
 * `userId` filter and returns every user's rows for the given boards. The
 * `userId: string` signature promises a caller always has one, but a future
 * caller reaching this with `undefined` (past a `!` assertion, say) must not
 * be rewarded with everyone's access — hence the explicit guard below rather
 * than trusting the type.
 */
export async function accessibleBoardIds(
  prisma: PrismaClient,
  userId: string,
  boardIds: readonly string[],
  required: BoardAccessRole,
  log?: BoardAccessLog,
  membership: CallerMembership = null,
): Promise<Set<string>> {
  if (!userId) return new Set();
  const unique = [...new Set(boardIds)].filter((id) => id.length > 0);
  if (unique.length === 0) return new Set();

  // The org-role ceiling (design D3), the same rule `evaluatePolicy` applies —
  // applied here too so the two cannot disagree. Before this, an org ADMIN with
  // no BoardAccess rows saw an EMPTY roadmap and was refused a sync detach,
  // while the policy layer treated them as an implicit OWNER of those same
  // boards. Under-permissive, so this closes a usability gap, not a hole.
  //
  // Deliberately AFTER the `!userId` and empty-set guards: a caller with no user
  // id must get nothing, membership or not.
  //
  // Boards are NOT re-read through the caller's organization here. That check
  // belongs with the entity load and is a documented, deferred multi-org
  // precondition — adding half of it here would make this helper disagree with
  // `evaluatePolicy` in the other direction.
  if (membership?.role === 'ADMIN') return new Set(unique);

  try {
    const rows = await prisma.boardAccess.findMany({
      where: { userId, boardId: { in: unique } },
      select: { boardId: true, role: true },
    });
    return new Set(
      rows
        .filter((r) => {
          // With no membership the raw grant decides, exactly as before —
          // mirroring the policy layer's own null-membership branch rather than
          // inventing a second rule.
          const effective = membership ? effectiveBoardRole(membership.role, r.role) : r.role;
          return effective !== null && meetsRole(effective, required);
        })
        .map((r) => r.boardId),
    );
  } catch (err) {
    log?.error(err, 'board-access: bulk access lookup failed — treating every board as inaccessible');
    return new Set();
  }
}

/**
 * The board ids from `boardIds` the user may NOT touch at `required`. Empty
 * means "all clear" — the shape write paths want, since they must name what
 * they are refusing.
 */
export async function forbiddenBoardIds(
  prisma: PrismaClient,
  userId: string,
  boardIds: readonly string[],
  required: BoardAccessRole,
  log?: BoardAccessLog,
  membership: CallerMembership = null,
): Promise<string[]> {
  const allowed = await accessibleBoardIds(prisma, userId, boardIds, required, log, membership);
  return [...new Set(boardIds)].filter((id) => !allowed.has(id));
}

/**
 * Tree ids the user holds any row on, for the one route a declarative policy
 * cannot reach: `GET /org-trees` has no tree id in the request to check
 * against — the set to check IS the response. Admins are handled by the
 * caller (they see every tree), not here — this stays a pure access-row
 * query so it composes the same way for every caller.
 *
 * Fails closed, mirroring `accessibleBoardIds` above for the same reason:
 * a lookup error yields the empty set rather than propagating, and the
 * error is always logged rather than swallowed. Also fails closed on a
 * missing `userId` — Prisma's `findMany` treats an `undefined` value in a
 * `where` clause as "no filter on this column", not "match nothing", so
 * `where: { userId: undefined, ... }` would silently drop the `userId`
 * filter and return every user's rows. The `userId: string` signature
 * promises a caller always has one, but a caller reaching this with
 * `undefined` (single-user mode's unresolved `req.user`, past a caller that
 * forgot to special-case it) must not be rewarded with everyone's access.
 */
export async function accessibleOrgTreeIds(
  prisma: PrismaClient,
  userId: string,
  log?: BoardAccessLog,
): Promise<string[]> {
  if (!userId) return [];
  try {
    const rows = await prisma.orgTreeAccess.findMany({
      where: { userId },
      select: { orgTreeId: true },
    });
    return rows.map((r) => r.orgTreeId);
  } catch (err) {
    log?.error(err, 'org-tree-access: bulk access lookup failed — treating every tree as inaccessible');
    return [];
  }
}

/**
 * Thrown by a service when a write names boards the caller cannot see. Carries
 * the offending ids so the route can 403 with something diagnosable. The whole
 * request is refused rather than the unseen boards being dropped: a partial
 * success would hide the attempt and confuse a legitimate caller.
 */
export class BoardAccessDeniedError extends Error {
  constructor(public readonly boardIds: string[]) {
    super(
      `Forbidden: no access to board(s) ${boardIds.join(', ')}`,
    );
    this.name = 'BoardAccessDeniedError';
  }
}
