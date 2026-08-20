import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { UserService } from './user.service.js';
import { orgRole } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

export async function userRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new UserService(prisma);

  /**
   * GET /users/search?q= — ACTIVE members of the caller's organization.
   *
   * `orgRole('VIEWER')` rather than `authenticated`: this endpoint's whole
   * output is other people's names and emails, so a caller with no membership
   * must get NO_ORGANIZATION rather than a directory. `requireOrganizationId`
   * is safe precisely because that policy guarantees the membership.
   *
   * An empty `q` returns the first 20 members rather than `[]`: a picker that
   * stays blank until you guess a name is worse than a list.
   */
  app.get<{ Querystring: { q?: string } }>(
    '/users/search',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      const q = (req.query.q ?? '').trim();
      const people = await service.search(q, requireOrganizationId(req));
      return reply.send(people);
    },
  );
}
