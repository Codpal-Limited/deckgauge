import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { OrgBoardsService } from './org-boards.service.js';
import { ORG_ADMIN } from '../auth/policy.js';
import { requireOrganizationId } from './request-organization.js';

export async function orgBoardsRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new OrgBoardsService(prisma);

  /**
   * Every board this organization owns — the discovery half of spec §5.4.
   *
   * `ORG_ADMIN` rather than `orgRole('MEMBER')`: the response is the tenant's
   * whole board inventory including boards the caller has no grant on, which is
   * precisely the thing a member is not entitled to enumerate.
   *
   * There are no sibling write routes. An org ADMIN is already an implicit OWNER
   * of every board in their organization (`effectiveBoardRole`), so `PATCH
   * /boards/:id`, `DELETE /boards/:id` and `/boards/:boardId/access` admit them
   * as-is; adding org-scoped duplicates would mean two write paths for every
   * board invariant.
   */
  app.get('/organization/boards', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
    return reply.send(await service.list(requireOrganizationId(req)));
  });
}
