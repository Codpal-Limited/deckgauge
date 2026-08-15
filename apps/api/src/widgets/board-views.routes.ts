import { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { board } from '../auth/policy.js';
import {
  BoardViewService,
  CreateBoardViewSchema,
  UpdateBoardViewSchema,
} from './board-views.service.js';

export async function boardViewRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new BoardViewService(prisma);

  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/views',
    { config: { policy: board('VIEWER') } },
    async (req) => {
      return service.listByBoard(req.params.boardId);
    },
  );

  app.post<{ Params: { boardId: string } }>(
    '/boards/:boardId/views',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const parsed = CreateBoardViewSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const view = await service.create(req.params.boardId, parsed.data);
      return reply.status(201).send(view);
    },
  );

  app.patch<{ Params: { boardId: string; viewId: string } }>(
    '/boards/:boardId/views/:viewId',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const parsed = UpdateBoardViewSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const view = await service.update(req.params.viewId, parsed.data);
      return reply.send(view);
    },
  );

  app.delete<{ Params: { boardId: string; viewId: string } }>(
    '/boards/:boardId/views/:viewId',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      try {
        const deleted = await service.delete(req.params.viewId);
        if (!deleted) return reply.status(404).send({ error: 'View not found' });
        return reply.status(204).send();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'Cannot delete the last board view') {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
