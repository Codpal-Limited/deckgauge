import type { PrismaClient, BoardAccessRole } from '@deckgauge/db';
import type { FastifyRequest, FastifyReply } from 'fastify';

const ROLE_RANK: Record<BoardAccessRole, number> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

/**
 * Grant-only board access. **Not** the general authorization path — prefer
 * `AccessService.getEffectiveRole` or a `board(role)` policy.
 *
 * Why it is not general: it decides on a `BoardAccess` row alone. It therefore
 * disagrees with `evaluatePolicy`, which treats an organization ADMIN as an
 * implicit OWNER of every board in their organization — an admin holds no grant
 * row and is refused here while being admitted everywhere else. It also has no
 * tenant predicate; that is *safe* (no grant, no access — it fails closed) but
 * it means this function can never admit anyone the policy layer would not, and
 * can refuse people it would.
 *
 * Two authorization axes that can disagree is the `connectionOwner` mistake
 * Phase C deleted. The MCP tool surface and three `intelligence-query` routes
 * were moved off it; these two callers remain, both deliberate rather than
 * overlooked, and neither is a drop-in swap:
 *
 * - `advisor/advisor-session.routes.ts` — a `requireBoardAccess` preHandler
 *   sitting alongside `config: { policy: board('VIEWER') }`. Redundant in
 *   production, exactly like the three removed from `intelligence-query`. It
 *   stays because its whole test suite runs a bare Fastify app with no policy
 *   plugin registered, so this preHandler is the only gate those tests exercise
 *   — removing it would make them pass with no gate at all rather than fail.
 *   Retiring it means converting that suite to register `buildPolicyPlugin`
 *   first, which is its own change.
 * - `advisor/advisor-help.routes.ts` — validates an OPTIONAL `boardId` HINT, so
 *   it is not the route's gate at all. Its 401/403 strings are matched
 *   character-for-character by the web client's `advisor-error-copy.ts`;
 *   changing the mechanism risks changing the string, so it needs the copy
 *   updated in lockstep.
 *
 * Do not add new callers.
 */
export async function hasBoardAccess(
  db: PrismaClient,
  userId: string,
  boardId: string,
  minRole: BoardAccessRole,
): Promise<boolean> {
  const access = await db.boardAccess.findUnique({
    where: { boardId_userId: { boardId, userId } },
  });
  return !!access && ROLE_RANK[access.role] >= ROLE_RANK[minRole];
}

export function requireBoardAccess(db: PrismaClient, minRole: BoardAccessRole) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { boardId } = request.params as { boardId: string };
    if (!(await hasBoardAccess(db, request.user.id, boardId, minRole))) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  };
}
