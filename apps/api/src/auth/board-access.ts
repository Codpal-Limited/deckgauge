import type { PrismaClient, BoardAccessRole } from '@deckgauge/db';

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
): Promise<Set<string>> {
  if (!userId) return new Set();
  const unique = [...new Set(boardIds)].filter((id) => id.length > 0);
  if (unique.length === 0) return new Set();
  try {
    const rows = await prisma.boardAccess.findMany({
      where: { userId, boardId: { in: unique } },
      select: { boardId: true, role: true },
    });
    return new Set(rows.filter((r) => meetsRole(r.role, required)).map((r) => r.boardId));
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
): Promise<string[]> {
  const allowed = await accessibleBoardIds(prisma, userId, boardIds, required, log);
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
