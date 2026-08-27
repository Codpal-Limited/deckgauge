import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { GrantAccessSchema, UpdateAccessRoleSchema } from '@deckgauge/shared';
import { AccessService } from '../access/access.service.js';
import {
  RoleExceedsOrgRoleError,
  TargetNotInOrganizationError,
} from '../access/last-owner.error.js';
import {
  isForeignKeyViolation,
  isUniqueViolation,
  isWriteConflict,
  mapWriteError,
} from '../access/prisma-errors.js';
import { employeeBoard, AUTHENTICATED } from '../auth/policy.js';
import { notifyEntityShared } from '../notifications/triggers/entity-shared.js';

/**
 * The employee-board half of the one route family (design §5.2) — a near-copy
 * of `board-access.routes.ts` and `org-tree-access.routes.ts`, differing only in
 * the entity kind and the policy. Keeping the three symmetrical is what makes a
 * divergence visible in review.
 *
 * `my-role` is the one place this family CANNOT be a copy: see its comment.
 */
export function buildEmployeeBoardAccessRoutes(prisma: PrismaClient): FastifyPluginAsync {
  const access = new AccessService(prisma);

  return async (app) => {
    /**
     * The caller's own effective role on this board, and their local `User.id`.
     *
     * This mirrors the `employeeBoard` policy branch INCLUDING D12's implicit
     * ownership: an OWNER grant on the parent tree makes the caller an OWNER
     * here. Reading only the board's own ACL — which is what
     * `AccessService.getRole` does — would hide the Share button from an
     * org-tree owner who has every right to it. That is the same class of bug
     * design §1.3 defect 3 was on boards: the one role decision the UI reads
     * disagreeing with the five that enforce.
     */
    app.get<{ Params: { boardId: string } }>(
      '/employee-boards/:boardId/my-role',
      { config: { policy: AUTHENTICATED } },
      async (req, reply) => {
        if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });

        // D12's implicit ownership now lives in the descriptor map, so this
        // route resolves it the same way the policy does — and, unlike the
        // hand-rolled version this replaces, it reads the board THROUGH the
        // caller's organization. That version returned OWNER for another
        // organization's board whenever the caller was an org ADMIN, because a
        // null grant meets the ceiling's floor (tenancy §11 precondition 7).
        const role = await access.getEffectiveRole(
          'employeeBoard',
          req.params.boardId,
          req.user.id,
          req.membership ?? null,
        );
        return reply.send({ role, userId: req.user.id });
      },
    );

    app.get<{ Params: { boardId: string } }>(
      '/employee-boards/:boardId/access',
      { config: { policy: employeeBoard('VIEWER') } },
      async (req, reply) =>
        reply.send(
          await access.list(
            'employeeBoard',
            req.params.boardId,
            req.membership?.organizationId ?? null,
          ),
        ),
    );

    app.post<{ Params: { boardId: string } }>(
      '/employee-boards/:boardId/access',
      { config: { policy: employeeBoard('OWNER') } },
      async (req, reply) => {
        const parsed = GrantAccessSchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

        try {
          const role = await access.grant(
            'employeeBoard',
            req.params.boardId,
            parsed.data.userId,
            parsed.data.role,
            // Null only where the policy layer deliberately admits a caller with
            // no membership — the pre-bootstrap admin (design D9).
            req.membership?.organizationId ?? null,
          );

          // POST is always a NEW grant — `grant` inserts, and an existing row
          // surfaces as 409 ALREADY_HAS_ACCESS — so previousRole is null by
          // construction and no extra read is needed to tell the two kinds apart.
          await notifyEntityShared(prisma, req, {
            shareKind: 'employeeBoard',
            entityId: req.params.boardId,
            granteeId: parsed.data.userId,
            role,
            previousRole: null,
          });
          return reply.status(201).send({ userId: parsed.data.userId, role });
        } catch (err) {
          if (err instanceof TargetNotInOrganizationError) {
            return reply.status(404).send({ error: 'User not found' });
          }
          if (err instanceof RoleExceedsOrgRoleError) {
            return reply.status(409).send({ error: 'ROLE_EXCEEDS_ORG_ROLE' });
          }
          // The board id does not exist: an org ADMIN and an org-tree OWNER are
          // both implicit OWNERs, so this policy branch is reachable with no
          // real board behind it. The FK on `employee_board_access` catches it.
          if (isForeignKeyViolation(err)) {
            return reply.status(404).send({ error: 'Board not found' });
          }
          if (isUniqueViolation(err)) {
            return reply.status(409).send({ error: 'ALREADY_HAS_ACCESS' });
          }
          if (isWriteConflict(err)) {
            return reply.status(409).send({ error: 'CONCURRENT_UPDATE' });
          }
          throw err;
        }
      },
    );

    app.patch<{ Params: { boardId: string; userId: string } }>(
      '/employee-boards/:boardId/access/:userId',
      { config: { policy: employeeBoard('OWNER') } },
      async (req, reply) => {
        const parsed = UpdateAccessRoleSchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

        try {
          // Read BEFORE the update: `updateRole` returns the new role only, and
          // without the old one "your role changed" cannot say what it changed
          // from — nor tell a real change from a re-saved unchanged form.
          const previousRole = await access.getRole(
            'employeeBoard',
            req.params.boardId,
            req.params.userId,
          );
          const role = await access.updateRole(
            'employeeBoard',
            req.params.boardId,
            req.params.userId,
            parsed.data.role,
            req.membership?.organizationId ?? null,
          );
          if (role === null) return reply.status(404).send({ error: 'Access entry not found' });

          await notifyEntityShared(prisma, req, {
            shareKind: 'employeeBoard',
            entityId: req.params.boardId,
            granteeId: req.params.userId,
            role,
            previousRole: previousRole,
          });
          return reply.send({ userId: req.params.userId, role });
        } catch (err) {
          return mapWriteError(err, reply);
        }
      },
    );

    app.delete<{ Params: { boardId: string; userId: string } }>(
      '/employee-boards/:boardId/access/:userId',
      { config: { policy: employeeBoard('OWNER') } },
      async (req, reply) => {
        try {
          await access.revoke('employeeBoard', req.params.boardId, req.params.userId);
          return reply.status(204).send();
        } catch (err) {
          return mapWriteError(err, reply);
        }
      },
    );
  };
}
