import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import {
  CreateBoardFolderInputSchema,
  UpdateBoardFolderInputSchema,
  UpdateBoardPrefInputSchema,
  UpdateRoadmapPrefInputSchema,
} from '@deckgauge/shared';
import { RoadmapPrefsService } from '../roadmaps/roadmap-prefs.service.js';
import { BoardTreeService } from './board-tree.service.js';
import { AUTHENTICATED, ORG_MEMBER } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

export async function boardTreeRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new BoardTreeService(prisma);

  app.get('/me/board-tree', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: 'Authentication required' });
    return reply.send(await service.getTree(userId));
  });

  app.post('/me/board-folders', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: 'Authentication required' });
    const parsed = CreateBoardFolderInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const folder = await service.createFolder(requireOrganizationId(req), userId, parsed.data);
      return reply.status(201).send(folder);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.patch<{ Params: { id: string } }>('/me/board-folders/:id', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: 'Authentication required' });
    const parsed = UpdateBoardFolderInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const folder = await service.updateFolder(userId, req.params.id, parsed.data);
      if (!folder) return reply.status(404).send({ error: 'Not found' });
      return reply.send(folder);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/me/board-folders/:id', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: 'Authentication required' });
    const deleted = await service.deleteFolder(userId, req.params.id);
    if (!deleted) return reply.status(404).send({ error: 'Not found' });
    return reply.status(204).send();
  });

  app.patch<{ Params: { boardId: string } }>('/me/board-prefs/:boardId', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: 'Authentication required' });
    const parsed = UpdateBoardPrefInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const pref = await service.upsertPref(userId, req.params.boardId, parsed.data);
      return reply.send(pref);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.patch<{ Params: { roadmapId: string } }>('/me/roadmap-prefs/:roadmapId', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: 'Authentication required' });
    const parsed = UpdateRoadmapPrefInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const roadmapPrefs = new RoadmapPrefsService(prisma);
    try {
      const pref = await roadmapPrefs.upsertPref(userId, req.params.roadmapId, parsed.data);
      return reply.send(pref);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}
