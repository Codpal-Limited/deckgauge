import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import {
  CreateRoadmapInputSchema,
  UpdateRoadmapInputSchema,
  AddGroupsInputSchema,
  AddSubscriptionInputSchema,
  ReorderRoadmapGroupsInputSchema,
  SetRoadmapAccessInputSchema,
  UpdateRoadmapConfigInputSchema,
} from '@deckgauge/shared';
import { RoadmapService } from './roadmap.service.js';
import { RoadmapMembershipService } from './roadmap-membership.service.js';
import { RoadmapPickerService } from './roadmap-picker.service.js';
import { RoadmapGanttConfigService } from './roadmap-gantt-config.service.js';
import { requireRoadmapAccess } from './roadmap-access.middleware.js';
import { RoadmapItemService } from './roadmap-item.service.js';
import { AUTHENTICATED, roadmap } from '../auth/policy.js';
import { BoardAccessDeniedError } from '../auth/board-access.js';

// Body schemas for item-write endpoints
const SchedulePatchSchema = z.object({
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  durationCode: z.string().nullable().optional(),
});

const FieldPatchSchema = z.object({
  field: z.string().min(1),
  value: z.string(),
});

const MovePatchSchema = z.object({
  groupId: z.string().optional(),
  order: z.number().int().optional(),
}).refine((d) => d.groupId !== undefined || d.order !== undefined, {
  message: 'At least one of groupId or order must be provided',
});

export async function roadmapsRoutes(app: FastifyInstance, { prisma }: { prisma: PrismaClient }) {
  const svc = new RoadmapService(prisma);
  const members = new RoadmapMembershipService(prisma);
  const picker = new RoadmapPickerService(prisma);
  const ganttCfg = new RoadmapGanttConfigService(prisma);
  const items = new RoadmapItemService(prisma);
  const uid = (req: FastifyRequest): string | undefined => req.user?.id;

  app.get('/roadmaps', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = uid(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.send(await svc.listForUser(userId));
  });

  app.post('/roadmaps', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = uid(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = CreateRoadmapInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return reply.code(201).send(await svc.create(userId, parsed.data));
  });

  app.get('/roadmaps/picker/boards', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = uid(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.send(await picker.listPickerBoards(userId));
  });

  app.get<{ Params: { id: string } }>(
    '/roadmaps/:id',
    { preHandler: requireRoadmapAccess(prisma, 'VIEWER'), config: { policy: roadmap('VIEWER') } },
    async (req, reply) => {
      const userId = uid(req)!;
      const role = (await svc.getRole(req.params.id, userId))!;
      try {
        return reply.send(await svc.getDetail(req.params.id, role, userId, req.log));
      } catch {
        return reply.code(404).send({ error: 'Not found' });
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/roadmaps/:id',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = UpdateRoadmapInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      await svc.update(req.params.id, parsed.data);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/roadmaps/:id',
    { preHandler: requireRoadmapAccess(prisma, 'OWNER'), config: { policy: roadmap('OWNER') } },
    async (req, reply) => {
      await svc.remove(req.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/roadmaps/:id/groups',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = AddGroupsInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        await members.addGroups(req.params.id, parsed.data.groupIds, uid(req)!, req.log);
      } catch (err) {
        if (err instanceof BoardAccessDeniedError) {
          return reply.code(403).send({ error: err.message, boardIds: err.boardIds });
        }
        throw err;
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; groupId: string } }>(
    '/roadmaps/:id/groups/:groupId',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      await members.removeGroup(req.params.id, req.params.groupId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/roadmaps/:id/subscriptions',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = AddSubscriptionInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        await members.addSubscription(req.params.id, parsed.data.boardId, uid(req)!, req.log);
      } catch (err) {
        if (err instanceof BoardAccessDeniedError) {
          return reply.code(403).send({ error: err.message, boardIds: err.boardIds });
        }
        throw err;
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; boardId: string } }>(
    '/roadmaps/:id/subscriptions/:boardId',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      await members.removeSubscription(req.params.id, req.params.boardId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/roadmaps/:id/reorder',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = ReorderRoadmapGroupsInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      await members.reorder(req.params.id, parsed.data.orderedGroupIds);
      return reply.code(204).send();
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/roadmaps/:id/gantt-config',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = UpdateRoadmapConfigInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      return reply.send(await ganttCfg.update(req.params.id, parsed.data));
    },
  );

  // -------------------------------------------------------------------------
  // Item-write endpoints — gated by ROADMAP EDITOR role + membership guard
  // -------------------------------------------------------------------------

  app.patch<{ Params: { id: string; projectId: string } }>(
    '/roadmaps/:id/items/:projectId/schedule',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = SchedulePatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        return reply.send(
          await items.setSchedule(req.params.id, req.params.projectId, parsed.data, uid(req)!, req.log),
        );
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'ROADMAP_ITEM_FORBIDDEN' || msg === 'ROADMAP_ITEM_NOT_FOUND') {
          return reply.code(403).send({ error: msg });
        }
        throw e;
      }
    },
  );

  app.patch<{ Params: { id: string; projectId: string } }>(
    '/roadmaps/:id/items/:projectId/field',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = FieldPatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        await items.updateField(
          req.params.id, req.params.projectId, parsed.data.field, parsed.data.value, uid(req)!, req.log,
        );
        return reply.code(204).send();
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'ROADMAP_ITEM_FORBIDDEN' || msg === 'ROADMAP_ITEM_NOT_FOUND') {
          return reply.code(403).send({ error: msg });
        }
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string; projectId: string } }>(
    '/roadmaps/:id/items/:projectId/move',
    { preHandler: requireRoadmapAccess(prisma, 'EDITOR'), config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = MovePatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        await items.move(req.params.id, req.params.projectId, parsed.data, uid(req)!, req.log);
        return reply.code(204).send();
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'ROADMAP_ITEM_FORBIDDEN' || msg === 'ROADMAP_ITEM_NOT_FOUND') {
          return reply.code(403).send({ error: msg });
        }
        throw e;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/roadmaps/:id/access',
    { preHandler: requireRoadmapAccess(prisma, 'OWNER'), config: { policy: roadmap('OWNER') } },
    async (req, reply) => reply.send(await svc.listAccess(req.params.id)),
  );

  app.put<{ Params: { id: string } }>(
    '/roadmaps/:id/access',
    { preHandler: requireRoadmapAccess(prisma, 'OWNER'), config: { policy: roadmap('OWNER') } },
    async (req, reply) => {
      const parsed = SetRoadmapAccessInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      await svc.setAccess(req.params.id, parsed.data.userId, parsed.data.role);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/roadmaps/:id/access/:userId',
    { preHandler: requireRoadmapAccess(prisma, 'OWNER'), config: { policy: roadmap('OWNER') } },
    async (req, reply) => {
      try {
        await svc.revokeAccess(req.params.id, req.params.userId);
        return reply.code(204).send();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );
}
