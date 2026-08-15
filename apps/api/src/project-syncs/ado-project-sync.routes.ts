import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdoProjectSyncService } from './ado-project-sync.service.js';
import type { PrismaClient } from '@deckgauge/db';
import { AUTHENTICATED } from '../auth/policy.js';
import { denySyncDetach } from './sync-detach-guard.js';

const AdoProjectSyncCreateSchema = z.object({
  azureDevOpsInstanceId: z.string().uuid(),
  adoProject: z.string().min(1),
  syncPrs: z.boolean().default(false),
  syncCommits: z.boolean().default(false),
  syncRepos: z.array(z.string()).default([]),
  syncAllRepos: z.boolean().default(false),
});

// AzureDevOpsProjectSync (routes as "ado") has no boardId of its own — it's
// keyed by (azureDevOpsInstanceId, adoProject) and attaches to boards through
// a separate many-to-many join (packages/db/prisma/schema.prisma). No route
// here carries a resolvable board id, so every route is AUTHENTICATED.
export function adoProjectSyncRoutes(deps: { prisma: PrismaClient; singleUser?: boolean }) {
  const service = new AdoProjectSyncService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    app.get('/project-syncs/ado', { config: { policy: AUTHENTICATED } }, async () => service.list());

    app.post('/project-syncs/ado', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const body = AdoProjectSyncCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.create(body.data);
      return reply.code(201).send(row);
    });

    app.patch<{ Params: { id: string } }>('/project-syncs/ado/:id', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = z
        .object({
          syncPrs: z.boolean().optional(),
          syncCommits: z.boolean().optional(),
          syncRepos: z.array(z.string()).optional(),
          syncAllRepos: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.update(params.data.id, body.data);
    });

    // Deleting a sync cascade-deletes the BoardAdoSource row of every board
    // using it — gated on EDITOR over those boards. See sync-detach-guard.ts.
    app.delete<{ Params: { id: string } }>('/project-syncs/ado/:id', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const denial = await denySyncDetach(
        deps.prisma,
        'ado',
        params.data.id,
        req.user?.id,
        deps.singleUser ?? false,
        req.log,
      );
      if (denial) return reply.code(403).send({ error: denial.message, boardIds: denial.boardIds });
      await service.delete(params.data.id);
      return reply.code(204).send();
    });

    app.post('/project-syncs/ado/ensure', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const body = z
        .object({ azureDevOpsInstanceId: z.string().uuid(), adoProject: z.string().min(1) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.ensureSync(body.data.azureDevOpsInstanceId, body.data.adoProject);
      return reply.code(200).send(row);
    });
  };
}
