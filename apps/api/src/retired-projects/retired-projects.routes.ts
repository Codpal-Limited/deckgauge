import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import {
  CreateRetiredJiraProjectInputSchema,
  UpdateRetiredJiraProjectInputSchema,
} from '@deckgauge/shared';
import { RetiredProjectsService, RetiredProjectExistsError } from './retired-projects.service.js';
import { AUTHENTICATED } from '../auth/policy.js';

export async function retiredProjectsRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new RetiredProjectsService(prisma);

  // GET /retired-projects — list the global registry
  app.get('/retired-projects', { config: { policy: AUTHENTICATED } }, async (_req, reply) => {
    return reply.send(await service.list());
  });

  // POST /retired-projects — retire a Jira project as of a cutoff date
  app.post('/retired-projects', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const parsed = CreateRetiredJiraProjectInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const created = await service.create(parsed.data);
      return reply.status(201).send(created);
    } catch (err: unknown) {
      if (err instanceof RetiredProjectExistsError) {
        return reply.status(409).send({ error: err.message });
      }
      throw err;
    }
  });

  // PATCH /retired-projects/:projectKey — change cutoff/note
  app.patch<{ Params: { projectKey: string } }>(
    '/retired-projects/:projectKey',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const parsed = UpdateRetiredJiraProjectInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const updated = await service.update(req.params.projectKey.toUpperCase(), parsed.data);
      if (!updated) return reply.status(404).send({ error: 'Retired project not found' });
      return reply.send(updated);
    },
  );

  // DELETE /retired-projects/:projectKey — un-retire (hours return on next run)
  app.delete<{ Params: { projectKey: string } }>(
    '/retired-projects/:projectKey',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const deleted = await service.delete(req.params.projectKey.toUpperCase());
      if (!deleted) return reply.status(404).send({ error: 'Retired project not found' });
      return reply.status(204).send();
    },
  );
}
