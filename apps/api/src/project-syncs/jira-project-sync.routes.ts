import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JiraProjectSyncCreateSchema } from '@deckgauge/shared';
import { JiraProjectSyncService } from './jira-project-sync.service.js';
import type { PrismaClient } from '@deckgauge/db';
import { AUTHENTICATED } from '../auth/policy.js';
import { denySyncDetach } from './sync-detach-guard.js';

// JiraProjectSync has no boardId of its own — it's keyed by
// (jiraInstanceId, jiraProjectKey) and attaches to boards through a separate
// many-to-many BoardJiraSource join table (packages/db/prisma/schema.prisma).
// No route here carries a resolvable board id, so every route is AUTHENTICATED.
export function jiraProjectSyncRoutes(deps: { prisma: PrismaClient; singleUser?: boolean }) {
  const service = new JiraProjectSyncService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    app.get('/project-syncs/jira', { config: { policy: AUTHENTICATED } }, async () => service.list());

    app.post('/project-syncs/jira', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const body = JiraProjectSyncCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.create(body.data);
      return reply.code(201).send(row);
    });

    app.patch<{ Params: { id: string } }>('/project-syncs/jira/:id', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = z.object({ syncChangelog: z.boolean().optional(), syncWorklogs: z.boolean().optional() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.update(params.data.id, body.data);
    });

    // Deleting a sync cascade-deletes the BoardJiraSource row of every board
    // using it — gated on EDITOR over those boards. See sync-detach-guard.ts.
    app.delete<{ Params: { id: string } }>('/project-syncs/jira/:id', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const denial = await denySyncDetach(
        deps.prisma,
        'jira',
        params.data.id,
        req.user?.id,
        deps.singleUser ?? false,
        req.log,
      );
      if (denial) return reply.code(403).send({ error: denial.message, boardIds: denial.boardIds });
      await service.delete(params.data.id);
      return reply.code(204).send();
    });

    app.post('/project-syncs/jira/ensure', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const body = z
        .object({ jiraInstanceId: z.string().uuid(), jiraProjectKey: z.string().min(1) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.ensureSync(body.data.jiraInstanceId, body.data.jiraProjectKey);
      return reply.code(200).send(row);
    });
  };
}
