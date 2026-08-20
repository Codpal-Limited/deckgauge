import type { FastifyInstance } from 'fastify';
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
import { effectiveBoardRole } from '../authz/policy.js';
import { board, AUTHENTICATED } from '../auth/policy.js';

export async function boardAccessRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const access = new AccessService(prisma);

  /**
   * The caller's own effective role, and their local User.id.
   *
   * Both branches mirror what `board(...)` enforcement does for the same caller
   * (auth/policy.ts:737-742). Any disagreement shows up as a control the client
   * renders that then 403s, or a capability the caller holds but cannot see —
   * and there is no compiler signal if the two drift.
   */
  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/my-role',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
      const grant = await access.getRole('board', req.params.boardId, req.user.id);
      const role = req.membership
        ? effectiveBoardRole(req.membership.role, grant)
        : (grant ?? null);
      return reply.send({ role, userId: req.user.id });
    },
  );

  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/access',
    { config: { policy: board('VIEWER') } },
    async (req, reply) =>
      reply.send(
        await access.list('board', req.params.boardId, req.membership?.organizationId ?? null),
      ),
  );

  app.post<{ Params: { boardId: string } }>(
    '/boards/:boardId/access',
    { config: { policy: board('OWNER') } },
    async (req, reply) => {
      const parsed = GrantAccessSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      try {
        const role = await access.grant(
          'board',
          req.params.boardId,
          parsed.data.userId,
          parsed.data.role,
          // Null only where the policy layer admits a caller with no membership
          // — the pre-bootstrap admin (design D9).
          req.membership?.organizationId ?? null,
        );
        return reply.status(201).send({ userId: parsed.data.userId, role });
      } catch (err) {
        if (err instanceof TargetNotInOrganizationError) {
          return reply.status(404).send({ error: 'User not found' });
        }
        if (err instanceof RoleExceedsOrgRoleError) {
          return reply.status(409).send({ error: 'ROLE_EXCEEDS_ORG_ROLE' });
        }
        // The board id itself does not exist: an org ADMIN is an implicit
        // OWNER of any board id (`effectiveBoardRole`), so this policy
        // branch is reachable with no real board behind it. The FK on
        // `board_access.board_id` is what actually catches that here.
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
    '/boards/:boardId/access/:userId',
    { config: { policy: board('OWNER') } },
    async (req, reply) => {
      const parsed = UpdateAccessRoleSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      try {
        const role = await access.updateRole(
          'board',
          req.params.boardId,
          req.params.userId,
          parsed.data.role,
          // Same "null only for the pre-bootstrap/break-glass caller" contract
          // as POST above.
          req.membership?.organizationId ?? null,
        );
        if (role === null) return reply.status(404).send({ error: 'Access entry not found' });
        return reply.send({ userId: req.params.userId, role });
      } catch (err) {
        return mapWriteError(err, reply);
      }
    },
  );

  app.delete<{ Params: { boardId: string; userId: string } }>(
    '/boards/:boardId/access/:userId',
    { config: { policy: board('OWNER') } },
    async (req, reply) => {
      try {
        await access.revoke('board', req.params.boardId, req.params.userId);
        return reply.status(204).send();
      } catch (err) {
        return mapWriteError(err, reply);
      }
    },
  );
}
