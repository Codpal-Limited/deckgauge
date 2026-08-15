import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { BoardAccessService } from './board-access.service.js';
import { board, AUTHENTICATED } from '../auth/policy.js';

const GrantBodySchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['OWNER', 'EDITOR', 'VIEWER']),
});

const UpdateRoleBodySchema = z.object({
  role: z.enum(['OWNER', 'EDITOR', 'VIEWER']),
});

export async function boardAccessRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new BoardAccessService(prisma);

  // GET /boards/:boardId/my-role — get current user's role
  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/my-role',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
      const access = await prisma.boardAccess.findUnique({
        where: { boardId_userId: { boardId: req.params.boardId, userId: req.user.id } },
      });
      return reply.send({ role: access?.role ?? null });
    },
  );

  // GET /boards/:boardId/access — list all users + roles
  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/access',
    { config: { policy: board('VIEWER') } },
    async (req, reply) => {
      const entries = await service.listAccess(req.params.boardId);
      return reply.send(entries);
    },
  );

  // POST /boards/:boardId/access — grant access
  app.post<{ Params: { boardId: string } }>(
    '/boards/:boardId/access',
    { config: { policy: board('OWNER') } },
    async (req, reply) => {
      const parsed = GrantBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      // Verify target user exists
      const targetUser = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
      if (!targetUser) return reply.status(404).send({ error: 'User not found' });

      try {
        const access = await service.grantAccess(
          req.params.boardId,
          parsed.data.userId,
          parsed.data.role,
        );
        return reply.status(201).send(access);
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
          return reply.status(409).send({ error: 'User already has access to this board' });
        }
        throw err;
      }
    },
  );

  // PATCH /boards/:boardId/access/:userId — update role
  app.patch<{ Params: { boardId: string; userId: string } }>(
    '/boards/:boardId/access/:userId',
    { config: { policy: board('OWNER') } },
    async (req, reply) => {
      const parsed = UpdateRoleBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const updated = await service.updateRole(
        req.params.boardId,
        req.params.userId,
        parsed.data.role,
      );
      if (!updated) return reply.status(404).send({ error: 'Access entry not found' });
      return reply.send(updated);
    },
  );

  // DELETE /boards/:boardId/access/:userId — revoke access
  app.delete<{ Params: { boardId: string; userId: string } }>(
    '/boards/:boardId/access/:userId',
    { config: { policy: board('OWNER') } },
    async (req, reply) => {
      try {
        await service.revokeAccess(req.params.boardId, req.params.userId);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof Error && err.message === 'Cannot remove the last board owner') {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
