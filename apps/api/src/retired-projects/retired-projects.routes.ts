import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import {
  CreateRetiredJiraProjectInputSchema,
  UpdateRetiredJiraProjectInputSchema,
} from '@deckgauge/shared';
import { RetiredProjectsService, RetiredProjectExistsError } from './retired-projects.service.js';
import { ORG_MEMBER, orgRole } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

/**
 * The registry is organization property, so every route needs a membership to
 * scope to — `AUTHENTICATED` cannot supply one.
 *
 * Reads take the VIEWER floor and writes take MEMBER. That mapping is the
 * closest honest equivalent of the previous `AUTHENTICATED`: before tenancy any
 * authenticated user could retire a project, and now any org member can. It does
 * narrow one case deliberately — an org VIEWER loses write — which is the
 * organization-role ceiling doing exactly what it is for.
 */
const READ = orgRole('VIEWER');
const WRITE = ORG_MEMBER;

export async function retiredProjectsRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new RetiredProjectsService(prisma);

  // GET /retired-projects — list this organization's registry
  app.get('/retired-projects', { config: { policy: READ } }, async (req, reply) => {
    return reply.send(await service.list(requireOrganizationId(req)));
  });

  // POST /retired-projects — retire a Jira project as of a cutoff date
  app.post('/retired-projects', { config: { policy: WRITE } }, async (req, reply) => {
    const parsed = CreateRetiredJiraProjectInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const created = await service.create(requireOrganizationId(req), parsed.data);
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
    { config: { policy: WRITE } },
    async (req, reply) => {
      const parsed = UpdateRetiredJiraProjectInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const updated = await service.update(
        requireOrganizationId(req),
        req.params.projectKey.toUpperCase(),
        parsed.data,
      );
      if (!updated) return reply.status(404).send({ error: 'Retired project not found' });
      return reply.send(updated);
    },
  );

  // DELETE /retired-projects/:projectKey — un-retire (hours return on next run)
  app.delete<{ Params: { projectKey: string } }>(
    '/retired-projects/:projectKey',
    { config: { policy: WRITE } },
    async (req, reply) => {
      const deleted = await service.delete(
        requireOrganizationId(req),
        req.params.projectKey.toUpperCase(),
      );
      if (!deleted) return reply.status(404).send({ error: 'Retired project not found' });
      return reply.status(204).send();
    },
  );
}
