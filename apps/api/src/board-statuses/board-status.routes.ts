import type { FastifyInstance } from 'fastify';
import { BoardStatusService } from './board-status.service.js';
import type { PrismaClient } from '@deckgauge/db';
import { CreateBoardStatusInputSchema, UpdateBoardStatusInputSchema } from '@deckgauge/shared';
import { board, viaEntity, fromParam } from '../auth/policy.js';

function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

export async function boardStatusRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new BoardStatusService(prisma);

  // GET /boards/:boardId/statuses
  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/statuses',
    { config: { policy: board('VIEWER') } },
    async (req, reply) => {
      const statuses = await service.listByBoard(req.params.boardId);
      return reply.send(statuses);
    },
  );

  // POST /boards/:boardId/statuses
  app.post<{ Params: { boardId: string } }>(
    '/boards/:boardId/statuses',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const parsed = CreateBoardStatusInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      try {
        const status = await service.create(req.params.boardId, parsed.data);
        if (!status) return reply.status(404).send({ error: 'Not found' });
        return reply.status(201).send(status);
      } catch (err: unknown) {
        if (isPrismaUniqueConstraintError(err)) {
          return reply.status(409).send({ error: 'Duplicate label or color for this board' });
        }
        throw err;
      }
    },
  );

  // PATCH /board-statuses/:id — :id is a board status id; the board is
  // reachable through BoardStatus.boardId (direct column).
  app.patch<{ Params: { id: string } }>(
    '/board-statuses/:id',
    { config: { policy: board('EDITOR', viaEntity('boardStatus', fromParam('id'))) } },
    async (req, reply) => {
      const parsed = UpdateBoardStatusInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      try {
        const status = await service.update(req.params.id, parsed.data);
        if (!status) return reply.status(404).send({ error: 'Not found' });
        return reply.send(status);
      } catch (err: unknown) {
        if (isPrismaUniqueConstraintError(err)) {
          return reply.status(409).send({ error: 'Duplicate label or color for this board' });
        }
        throw err;
      }
    },
  );

  // DELETE /board-statuses/:id — see PATCH /board-statuses/:id.
  app.delete<{ Params: { id: string } }>(
    '/board-statuses/:id',
    { config: { policy: board('EDITOR', viaEntity('boardStatus', fromParam('id'))) } },
    async (req, reply) => {
      const result = await service.delete(req.params.id);
      if (!result.deleted) {
        if (result.reason === 'not_found') {
          return reply.status(404).send({ error: 'Not found' });
        }
        if (result.reason === 'sole_default') {
          return reply.status(409).send({ error: 'Cannot delete the only default status' });
        }
      }
      return reply.status(204).send();
    },
  );
}
