import type { FastifyInstance } from 'fastify';
import {
  BoardService,
  CreateBoardInputSchema,
  UpdateBoardInputSchema,
} from './board.service.js';
import type { PrismaClient } from '@deckgauge/db';
import { HiddenSystemFieldsSchema, ColumnLayoutSchema } from '@deckgauge/shared';
import { AUTHENTICATED, ORG_MEMBER, board } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

export async function boardRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new BoardService(prisma);

  // GET /boards — returns only boards the user has access to (empty if unauthenticated)
  app.get('/boards', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.send([]);
    const boards = await service.list(userId);
    return reply.send(boards);
  });

  // GET /boards/:id — returns 404 if board doesn't exist or user has no access
  app.get<{ Params: { id: string } }>(
    '/boards/:id',
    { config: { policy: board('VIEWER') } },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(404).send({ error: 'Not found' });
      const board = await service.getById(req.params.id, userId);
      if (!board) return reply.status(404).send({ error: 'Not found' });
      return reply.send(board);
    },
  );

  // POST /boards — must be authenticated; otherwise the board would be created
  // without an OWNER access entry and become orphaned (invisible to everyone).
  app.post('/boards', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }
    const parsed = CreateBoardInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const board = await service.create(requireOrganizationId(req), parsed.data, userId);
    return reply.status(201).send(board);
  });

  // PATCH /boards/:id
  app.patch<{ Params: { id: string } }>(
    '/boards/:id',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const parsed = UpdateBoardInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const board = await service.update(req.params.id, parsed.data);
      if (!board) return reply.status(404).send({ error: 'Not found' });
      return reply.send(board);
    },
  );

  // DELETE /boards/:id
  app.delete<{ Params: { id: string } }>(
    '/boards/:id',
    { config: { policy: board('OWNER') } },
    async (req, reply) => {
      try {
        const deleted = await service.delete(req.params.id);
        if (!deleted) return reply.status(404).send({ error: 'Not found' });
        return reply.status(204).send();
      } catch (err) {
        req.log.error(err, 'Failed to delete board');
        return reply.status(500).send({ error: 'Failed to delete board' });
      }
    },
  );

  // PATCH /boards/:boardId/hidden-system-fields — EDITOR role required
  app.patch<{ Params: { boardId: string }; Body: { hiddenSystemFields: string[] } }>(
    '/boards/:boardId/hidden-system-fields',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const existing = await prisma.board.findUnique({ where: { id: req.params.boardId } });
      if (!existing) return reply.status(404).send({ error: 'Not found' });
      const parsed = HiddenSystemFieldsSchema.safeParse(req.body?.hiddenSystemFields);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const board = await service.setHiddenSystemFields(req.params.boardId, parsed.data);
      return reply.send({ board });
    },
  );

  // PATCH /boards/:boardId/column-layout — EDITOR role required
  app.patch<{ Params: { boardId: string }; Body: unknown }>(
    '/boards/:boardId/column-layout',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const existing = await prisma.board.findUnique({ where: { id: req.params.boardId } });
      if (!existing) return reply.status(404).send({ error: 'Not found' });
      const parsed = ColumnLayoutSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const board = await service.setColumnLayout(req.params.boardId, parsed.data);
      return reply.send({ board });
    },
  );
}
