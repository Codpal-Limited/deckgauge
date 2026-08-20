import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import {
  CreateRoadmapInputSchema,
  UpdateRoadmapInputSchema,
  AddGroupsInputSchema,
  AddSubscriptionInputSchema,
  ReorderRoadmapGroupsInputSchema,
  UpdateRoadmapConfigInputSchema,
} from '@deckgauge/shared';
import { RoadmapService } from './roadmap.service.js';
import { RoadmapMembershipService } from './roadmap-membership.service.js';
import { RoadmapPickerService } from './roadmap-picker.service.js';
import { RoadmapGanttConfigService } from './roadmap-gantt-config.service.js';
import { RoadmapItemService } from './roadmap-item.service.js';
import { AUTHENTICATED, ORG_MEMBER, roadmap } from '../auth/policy.js';
import { effectiveBoardRole } from '../authz/policy.js';
import { BoardAccessDeniedError } from '../auth/board-access.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

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

  app.post('/roadmaps', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const userId = uid(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = CreateRoadmapInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return reply.code(201).send(await svc.create(requireOrganizationId(req), userId, parsed.data));
  });

  app.get('/roadmaps/picker/boards', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = uid(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.send(await picker.listPickerBoards(userId));
  });

  app.get<{ Params: { id: string } }>(
    '/roadmaps/:id',
    { config: { policy: roadmap('VIEWER') } },
    async (req, reply) => {
      const userId = uid(req)!;
      // `getRole` can now return null for an org ADMIN with no RoadmapAccess row
      // — who is nonetheless an OWNER. The `!` this replaces was only sound
      // while roadmap-access.middleware.ts guaranteed a grant row existed; that
      // middleware is gone, so the role is derived the way the policy derives
      // it, and a genuinely role-less caller is refused rather than asserted
      // away.
      const grant = await svc.getRole(req.params.id, userId);
      const role = req.membership
        ? effectiveBoardRole(req.membership.role, grant)
        : (grant ?? null);
      if (!role) return reply.code(403).send({ error: 'Forbidden' });
      try {
        return reply.send(
          await svc.getDetail(req.params.id, role, userId, req.log, req.membership ?? null),
        );
      } catch {
        return reply.code(404).send({ error: 'Not found' });
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/roadmaps/:id',
    { config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = UpdateRoadmapInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      await svc.update(req.params.id, parsed.data);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/roadmaps/:id',
    { config: { policy: roadmap('OWNER') } },
    async (req, reply) => {
      await svc.remove(req.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/roadmaps/:id/groups',
    { config: { policy: roadmap('EDITOR') } },
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
    { config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      await members.removeGroup(req.params.id, req.params.groupId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/roadmaps/:id/subscriptions',
    { config: { policy: roadmap('EDITOR') } },
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
    { config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      await members.removeSubscription(req.params.id, req.params.boardId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/roadmaps/:id/reorder',
    { config: { policy: roadmap('EDITOR') } },
    async (req, reply) => {
      const parsed = ReorderRoadmapGroupsInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      await members.reorder(req.params.id, parsed.data.orderedGroupIds);
      return reply.code(204).send();
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/roadmaps/:id/gantt-config',
    { config: { policy: roadmap('EDITOR') } },
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
    { config: { policy: roadmap('EDITOR') } },
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
    { config: { policy: roadmap('EDITOR') } },
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
    { config: { policy: roadmap('EDITOR') } },
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

}
