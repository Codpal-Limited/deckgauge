import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { UserService } from './user.service.js';
import { AUTHENTICATED } from '../auth/policy.js';

export async function userRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new UserService(prisma);

  // GET /users/search?q=:query — search by name or email
  app.get<{ Querystring: { q?: string } }>(
    '/users/search',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const q = (req.query.q ?? '').trim();
      if (q.length < 1) return reply.send([]);
      const users = await service.search(q);
      // Return only non-sensitive fields
      return reply.send(
        users.map((u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl })),
      );
    },
  );
}
