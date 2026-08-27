import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { UserService } from './user.service.js';
import { orgRole } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';
import { z } from 'zod/v4';

const UuidSchema = z.string().uuid();

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
  app.get<{ Querystring: { q?: string; boardId?: string } }>(
    '/users/search',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      const q = (req.query.q ?? '').trim();
      // Optional: the mention picker passes it so the list honours R5.8 ("users
      // WITH BOARD ACCESS can be @mentioned"); the employee-comment editor has
      // no board to pass. Validated rather than forwarded raw — a malformed id
      // would otherwise reach Prisma.
      const boardId = req.query.boardId?.trim();
      if (boardId !== undefined && !UuidSchema.safeParse(boardId).success) {
        return reply.code(400).send({ error: 'Invalid board ID' });
      }
      const people = await service.search(q, requireOrganizationId(req), boardId);
      return reply.send(people);
    },
  );
}
