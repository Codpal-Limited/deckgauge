import type { FastifyInstance } from 'fastify';
import {
  AutomationService,
  CreateAutomationInputSchema,
  UpdateAutomationInputSchema,
} from './automation.service.js';
import type { PrismaClient } from '@deckgauge/db';
import { board, viaEntity, fromParam } from '../auth/policy.js';

export async function automationRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new AutomationService(prisma);

  // GET /boards/:id/automations
  app.get<{ Params: { id: string } }>(
    '/boards/:id/automations',
    { config: { policy: board('VIEWER') } },
    async (req, reply) => {
      const rules = await service.listByBoard(req.params.id);
      return reply.send(rules);
    },
  );

  // POST /boards/:id/automations
  app.post<{ Params: { id: string } }>(
    '/boards/:id/automations',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const parsed = CreateAutomationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const rule = await service.create(req.params.id, parsed.data);
      if (!rule) return reply.status(404).send({ error: 'Board not found' });
      return reply.status(201).send(rule);
    },
  );

  // PATCH /automations/:id — :id is an automation rule id; the board is
  // reachable through AutomationRule.boardId (direct column).
  app.patch<{ Params: { id: string } }>(
    '/automations/:id',
    { config: { policy: board('EDITOR', viaEntity('automationRule', fromParam('id'))) } },
    async (req, reply) => {
      const parsed = UpdateAutomationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const rule = await service.update(req.params.id, parsed.data);
      if (!rule) return reply.status(404).send({ error: 'Not found' });
      return reply.send(rule);
    },
  );

  // DELETE /automations/:id — see PATCH /automations/:id.
  app.delete<{ Params: { id: string } }>(
    '/automations/:id',
    { config: { policy: board('EDITOR', viaEntity('automationRule', fromParam('id'))) } },
    async (req, reply) => {
      const deleted = await service.delete(req.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Not found' });
      return reply.status(204).send();
    },
  );
}
