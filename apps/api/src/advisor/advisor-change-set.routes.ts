import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import type { BoardOpErrorDto } from '@deckgauge/shared';
import { all, board, orgRole, viaBoardId, fromParam } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';
import { ChangeSetService } from './change-set/change-set.service.js';
import { ChangeSetApplyService } from './change-set/change-set-apply.service.js';

/**
 * The floor every route below declares. The `board('EDITOR', ...)` half is the
 * SECOND authorization check on a change-set, and the load-bearing one: a
 * change-set outlives the request that proposed it, so a role revoked in
 * between must take effect here, at list/apply/discard time — not just at
 * `propose_board_changes` (Task 7's MCP tool), which is UX and defence in
 * depth, not the gate.
 *
 * `orgRole('VIEWER')` is the second half, and it is not decoration. All three
 * handlers call `requireOrganizationId(req)`, whose own doc says the `orgRole`
 * policy is what guarantees a membership and which throws
 * `MissingOrganizationError` — a 500 — otherwise. With `MULTI_ORG` off, a
 * membership-less caller holding a raw `BoardAccess` EDITOR grant is ALLOWed by
 * the board policy alone and then hits that throw. The sibling advisor route
 * has always paired the two for exactly this reason (`advisor.routes.ts`: "a
 * break-glass admin holds board access with no membership"). VIEWER, not
 * EDITOR: the organization half supplies the tenant, while WHICH board may be
 * edited is the board half's decision.
 */
const CHANGE_SET_EDITOR_POLICY = all(
  board('EDITOR', viaBoardId(fromParam('boardId'))),
  orgRole('VIEWER'),
);

/**
 * The human half of the change-set gate.
 *
 * `organizationId` and `userId` come ONLY from the authenticated request —
 * `requireOrganizationId(req)` (which reads `req.membership`, itself set by
 * the auth plugin from the verified JWT) and `req.user.id` — NEVER from the
 * request body, a query parameter, or a client header. The board↔organization
 * pairing that `CHANGE_SET_EDITOR_POLICY` just proved is only true because it
 * was resolved by the policy layer THROUGH the caller's own membership;
 * accepting either value from the client would let a caller supply a
 * mismatched organization id for a real board and walk straight past that
 * proof.
 *
 * `ValidationError` (op-validator.ts, internal to the change-set module) and
 * `BoardOpErrorDto` (@deckgauge/shared, the public wire type) are structurally
 * identical — `{ opIndex: number; reason: string }`. Task 3 kept them as two
 * named types deliberately, one per module boundary, and its implementer
 * recommended converging them at the HTTP boundary rather than leaving the
 * question open a third time. This file is that boundary: `ChangeSetApplyService`
 * keeps talking `ValidationError` internally, and the apply route below is the
 * one place that relabels an outcome's `errors` as `BoardOpErrorDto[]` on the
 * way out. No cast is needed — the shapes already match — only the type
 * annotation, so a future divergence between the two interfaces would be a
 * compile error here, not a silent mismatch.
 *
 * `applier` is an optional second parameter, defaulted to a real
 * `ChangeSetApplyService(prisma)` — mirroring how `prisma` itself is just a
 * parameter, not a hidden singleton. `server.ts` calls this with one
 * argument, so production wiring is unchanged. The seam exists because
 * `ChangeSetApplyService.apply`'s `FAILED` outcome comes from a real
 * transaction rollback deep inside a `$transaction` callback — the only way
 * to provoke it from a route-level test without re-deriving Task 6's
 * `_afterOp` fault-injection machinery is to substitute a double here that
 * returns `{ ok: false, code: 'FAILED' }` directly, so the ROUTE's mapping of
 * that outcome to a status code (500, never 409) is what gets exercised.
 */
export function advisorChangeSetRoutes(
  prisma: PrismaClient,
  applier: ChangeSetApplyService = new ChangeSetApplyService(prisma),
) {
  const service = new ChangeSetService(prisma);

  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/advisor/change-sets',
      { config: { policy: CHANGE_SET_EDITOR_POLICY } },
      async (req, reply) => {
        const list = await service.listPending(
          req.params.boardId,
          requireOrganizationId(req),
          req.user.id,
        );
        return reply.send({ changeSets: list });
      },
    );

    app.post<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/advisor/change-sets/:id/apply',
      { config: { policy: CHANGE_SET_EDITOR_POLICY } },
      async (req, reply) => {
        // `req.params.boardId` — the board the policy above just proved EDITOR
        // on — is threaded through so the applier's lookup joins it onto the
        // change-set row. Without it the authorized board and the board the
        // transaction writes to (`cs.boardId`) were never compared.
        const out = await applier.apply(
          req.params.id,
          req.params.boardId,
          requireOrganizationId(req),
          req.user.id,
        );

        if (out.ok) {
          // `ChangeSetApplyService.apply` returns `applied: ops.length` — an OP
          // count, not a row count. A two-row `move_rows` op reports 1 here.
          // Renamed to `appliedOps` on the wire so this can never be misread as
          // "rows changed".
          return reply.send({ appliedOps: out.applied });
        }

        // 404 rather than 403 for someone else's change-set: whether a given id
        // exists at all is itself information the caller has no claim to (global
        // constraint — a board EDITOR who is not the creator gets exactly the
        // same answer as a caller who made the id up).
        //
        // STALE and NOT_PENDING both answer 409 but are NOT interchangeable to a
        // human, so the code — not just the status — must reach the response
        // body. STALE means the board moved under the approved preview; the fix
        // is to re-propose. NOT_PENDING means the change-set already resolved
        // (applied, discarded, or already flagged stale/expired) and there is
        // nothing left to retry against.
        //
        // FAILED is its own status, 500, deliberately NOT folded into STALE's
        // 409: FAILED means the transaction rolled back, the change-set is still
        // PENDING, and the correct next step is to RETRY the same id — the exact
        // opposite instruction from STALE's "re-propose". Collapsing the two
        // would have undone a fix already made two tasks ago
        // (change-set-apply.service.ts).
        const status =
          out.code === 'NOT_FOUND' ? 404
          : out.code === 'EXPIRED' ? 410
          : out.code === 'NOT_PENDING' ? 409
          : out.code === 'STALE' ? 409
          : 500; // FAILED

        // `out.errors` is only ever populated on STALE (see
        // ChangeSetApplyService.apply's drift-check branch); every other code
        // sends none. Passed through verbatim as `BoardOpErrorDto[]` — see the
        // class doc comment above for why that relabeling is safe and
        // deliberate. Nothing here indexes into an `ops` array with `opIndex`,
        // so an eventual `opIndex: -1` (the change-set-level total-row-cap
        // rejection `ChangeSetService.propose` can emit — unreachable from THIS
        // path today, since apply's own re-validation never produces one) would
        // pass through unharmed rather than being read as "op -1 of the list".
        const errors: BoardOpErrorDto[] | undefined = out.errors;
        return reply.code(status).send({ error: out.code, ...(errors ? { errors } : {}) });
      },
    );

    app.post<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/advisor/change-sets/:id/discard',
      { config: { policy: CHANGE_SET_EDITOR_POLICY } },
      async (req, reply) => {
        const ok = await service.discard(
          req.params.id,
          req.params.boardId,
          requireOrganizationId(req),
          req.user.id,
        );
        // Same 404-not-403 reasoning as apply above: discarding someone else's
        // change-set, discarding one that belongs to a DIFFERENT board than the
        // one in the URL, and discarding a nonexistent id must all be
        // indistinguishable.
        return ok ? reply.code(204).send() : reply.code(404).send({ error: 'NOT_FOUND' });
      },
    );
  };
}
