import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DeveloperProfileLinkSchema } from '@deckgauge/shared';
import { DeveloperProfileService } from './developer-profile.service.js';
import type { PrismaClient } from '@deckgauge/db';
import { AUTHENTICATED } from '../auth/policy.js';

export function developerProfileRoutes(deps: { prisma: PrismaClient }) {
  const service = new DeveloperProfileService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    app.get('/developer-profiles', { config: { policy: AUTHENTICATED } }, async (req) => {
      const q = z.object({ q: z.string().optional() }).safeParse(req.query);
      if (q.success && q.data.q) return service.searchByLoginOrName(q.data.q);
      return service.list();
    });

    app.patch<{ Params: { id: string } }>('/developer-profiles/:id', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = DeveloperProfileLinkSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      await service.linkToUser(params.data.id, body.data.userId);
      return reply.code(204).send();
    });
  };
}
