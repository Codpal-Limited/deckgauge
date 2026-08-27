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
 * Which organization's grants a caller is asking about.
 *
 * **Required and positional, not optional and trailing** — deliberately unlike
 * `CallerMembership` above. An optional tenant argument fails OPEN and silently:
 * the caller that forgets it gets a wider answer and no signal, which is the
 * failure this programme keeps rediscovering. Required means forgetting does not
 * compile.
 *
 * The two arms are mutually exclusive at the type level (`?: never`), so a scope
 * that says both things at once is unwritable, and the unscoped read has to be
 * ASKED for by name. Omission and oversight look identical; `UNSCOPED_NO_MEMBERSHIP`
 * does not look like either.
 */
export type OrgTreeGrantScope =
  | { organizationId: string; unscoped?: never }
  | { unscoped: 'no-membership'; organizationId?: never };

/**
 * The one legitimate unscoped caller: a request with no membership at all, where
 * there is no organization to scope to. `GET /org-trees` keeps this arm because it
 * is the lockout-recovery path `bootstrap:admin` and the administration guide both
 * document.
 *
 * It is an OPEN residual, not a settled design — `planning/TENANCY-PROGRAMME.md`
 * §5c OPEN 2 records the decision it is waiting on, and
 * `__isolation__/org-tree-list-tenancy.test.ts` pins the current behaviour so
 * changing it is deliberate. Naming it here is what keeps the residual to ONE call
 * site instead of anywhere the argument was left off.
 *
 * Only one reason is spelled out because only one exists. Adding another should be
 * an edit to this union that someone has to justify, not a string a caller can
 * invent.
 */
export const UNSCOPED_NO_MEMBERSHIP: OrgTreeGrantScope = { unscoped: 'no-membership' };

/**
 * Tree ids the user holds a grant row on, within `scope`.
 *
 * Backs the places a declarative route policy cannot reach: `GET /org-trees` has
 * no tree id in the request to check against (the set to check IS the response),
 * and `NotificationService.list` resolves reachability for a whole page of rows at
 * once. Admins are handled by the caller — the two differ on whether an admin
 * holding no grant should see everything — so this stays a pure grant query and
 * composes the same way for both.
 *
 * ### The organization boundary
 *
 * **Invariant: the returned set lies within the organization the caller is acting
 * in.** A grant may NARROW reach inside a tenant; it must never ESTABLISH reach
 * into one. Stated as an invariant on purpose, because it is not a statement about
 * any caller: every caller composes this set with something else, so a set that
 * spans tenants is one forgotten predicate away from admitting a foreign tree, and
 * the set of callers changes while the invariant does not.
 *
 * Two independent reasons a grant list genuinely spans organizations, so the
 * boundary is required rather than theoretical:
 *
 *   - **Concurrent memberships.** Holding ACTIVE memberships in two organizations
 *     is a supported state — `listSwitchableFor` enumerates them and
 *     `setActiveOrganization` chooses between them — so such a user legitimately
 *     holds `OrgTreeAccess` rows in both at once, and
 *     `revokeOrganizationGrantsForUser` is scoped to ONE organization precisely so
 *     that leaving one does not cost them the other.
 *   - **Grants orphaned before the offboarding revoke shipped**, which is
 *     explicitly not retroactive.
 *
 * `OrgTreeAccess` carries no `organization_id` column of its own — class B, it
 * inherits tenancy through the tree — so the predicate travels the relation
 * (`orgTree: { organizationId }`). `OrgTree.organizationId` is required and
 * `@@index([organizationId])` covers it (see packages/db/prisma/schema.prisma), so
 * this stays one query.
 *
 * ### Fail-closed
 *
 * A lookup error yields the empty set rather than propagating, and is always
 * logged rather than swallowed — mirroring `accessibleBoardIds`.
 *
 * Two inputs fail closed BEFORE the query, for the same underlying reason:
 * Prisma's `findMany` treats an `undefined` value in a `where` clause as "no filter
 * on this column", not "match nothing", so a dropped clause silently widens the
 * answer instead of emptying it.
 *
 *   - a missing `userId`. The `userId: string` signature promises a caller always
 *     has one, but a caller reaching here with `undefined` (single-user mode's
 *     unresolved `req.user`, past a caller that forgot to special-case it) must
 *     not be rewarded with every user's grants.
 *   - a scope that does not name exactly one thing: a BLANK organization id (the
 *     caller believed it was scoping) or — past a cast, since `?: never` blocks it
 *     — BOTH arms at once, where resolving the ambiguity would silently pick the
 *     wider of the two reads asked for. See the body.
 */
export async function accessibleOrgTreeIds(
  prisma: PrismaClient,
  userId: string,
  scope: OrgTreeGrantScope,
  log?: BoardAccessLog,
): Promise<string[]> {
  if (!userId) return [];
  // A scope must name EXACTLY one thing, and both ways of failing that are
  // refused rather than resolved:
  //
  //   - NEITHER — `{ organizationId: '' }`, the shape a half-populated config or
  //     a trimmed env var arrives in. The caller believed it was scoping; Prisma
  //     drops an `undefined` value from a `where` rather than matching nothing, so
  //     answering it as though it had asked for the unscoped form is the silent
  //     widening the required argument exists to prevent.
  //   - BOTH — `{ organizationId: 'org-a', unscoped: 'no-membership' }`. Only
  //     reachable past a cast, since `?: never` blocks it, but the query below
  //     tests `scope.unscoped` first, so resolving the ambiguity instead of
  //     refusing it would silently pick the WIDER read of the two the caller
  //     asked for. Refusing an ambiguous boundary is never the wrong answer;
  //     picking one arm of it can be.
  //
  // Both checked at runtime and not left to the type, on the same standard as
  // `jira-jql-filter.ts`'s `instanceId`: the type is half the boundary, because a
  // cast or a `!` reaches here either way.
  const wantsUnscoped = !!scope.unscoped;
  const wantsOrganization = !!scope.organizationId;
  if (wantsUnscoped === wantsOrganization) {
    log?.error(
      {
        userId,
        unscoped: scope.unscoped ?? null,
        organizationId: scope.organizationId ?? null,
      },
      'org-tree-access: a grant scope must name exactly one of `organizationId` or `unscoped` — treating every tree as inaccessible',
    );
    return [];
  }
  try {
    const rows = await prisma.orgTreeAccess.findMany({
      // Written as two whole `where` objects rather than a spread of a
      // conditional clause: a spread that evaluates to `{}` (or to
      // `{ orgTree: undefined }`) produces a query indistinguishable from the
      // unscoped one, so the scoped and unscoped forms would differ only in the
      // author's intent. Here they differ in the query.
      where: scope.unscoped
        ? { userId }
        : { userId, orgTree: { organizationId: scope.organizationId } },
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
