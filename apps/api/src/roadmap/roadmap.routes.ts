import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { UpdateRoadmapConfigInputSchema, SetScheduleInputSchema } from '@deckgauge/shared';
import { RoadmapService } from './roadmap.service.js';
import { RoadmapConfigService } from './roadmap-config.service.js';
import { board } from '../auth/policy.js';

/**
 * `viewId` absent is the deep-link case; a repeated key must be a 400, not a 500.
 *
 * Bare `z.string()`, with NO `.min(1)` and no `.uuid()`, and each omission is
 * load-bearing:
 *
 * - `.uuid()` would work — board view ids are uuids today (`@default(uuid())`,
 *   and `demoId` generates v5 for exactly this reason) — but it rejects id
 *   shapes the route accepts today, which is wider than the defect. A non-uuid
 *   id under a plain string check is parameterised by Prisma, matches nothing,
 *   and yields a clean 404.
 * - `.min(1)` is WORSE THAN NOTHING here. `?viewId=` — a bookmark or
 *   hand-edited URL that lost its value — is precisely the deep-link case this
 *   route is being fixed for, and `.min(1)` turns it into a 400 that
 *   `apps/web/app/actions/roadmap.ts` rethrows as a broken page. Bare
 *   `z.string()` lets `''` through to the falsy check in `loadView`, which
 *   routes it to the default view, one line away.
 *
 * What actually broke was an ARRAY reaching Prisma from a repeated key, and
 * `z.string()` alone rejects that.
 */
const RoadmapViewQuery = z.object({ viewId: z.string().optional() });

export async function roadmapRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
): Promise<void> {
  const roadmap = new RoadmapService(prisma);
  const configService = new RoadmapConfigService(prisma);

  // GET /boards/:boardId/roadmap?viewId=...
  // `viewId` is optional: a deep link to the roadmap has none, and the service
  // resolves the board's default roadmap view in that case. Typing it as
  // required did not make it present — it only hid that `undefined` was
  // reaching Prisma.
  //
  // PARSED, not merely typed, because a TypeScript annotation asserting
  // something the runtime does not enforce is the exact defect this route is
  // being fixed for. Fastify's default parser yields an ARRAY for a repeated
  // key, so `?viewId=a&viewId=b` reached Prisma as `where: { id: ['a','b'] }`
  // and 500'd — the same shape as the `undefined` bug, one URL further out.
  // Brings the querystring in line with `intelligence.routes.ts` and the
  // `packages/shared` Zod convention this file already follows for its bodies.
  app.get<{ Params: { boardId: string }; Querystring: { viewId?: string } }>(
    '/boards/:boardId/roadmap',
    { config: { policy: board('VIEWER') } },
    async (req, reply) => {
      const query = RoadmapViewQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      try {
        const payload = await roadmap.loadView(req.params.boardId, query.data.viewId);
        return reply.send(payload);
      } catch (e: unknown) {
        if (e instanceof Error && e.message === 'VIEW_NOT_FOUND') {
          return reply.status(404).send({ error: 'View not found' });
        }
        throw e;
      }
    },
  );

  // PATCH /api/boards/:boardId/projects/:projectId/roadmap-schedule
  app.patch<{ Params: { boardId: string; projectId: string } }>(
    '/boards/:boardId/projects/:projectId/roadmap-schedule',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const parsed = SetScheduleInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      try {
        const project = await roadmap.setSchedule(
          req.params.boardId,
          req.params.projectId,
          parsed.data,
        );
        return reply.send({ project });
      } catch (e: unknown) {
        if (e instanceof Error && e.message === 'PROJECT_NOT_FOUND') {
          return reply.status(404).send({ error: 'Project not found' });
        }
        throw e;
      }
    },
  );

  // GET /api/boards/:boardId/views/:viewId/roadmap-config
  app.get<{ Params: { boardId: string; viewId: string } }>(
    '/boards/:boardId/views/:viewId/roadmap-config',
    { config: { policy: board('VIEWER') } },
    async (req, reply) => {
      try {
        const config = await configService.getOrCreate(req.params.viewId);
        return reply.send({ config });
      } catch (e: unknown) {
        if (e instanceof Error && e.message === 'VIEW_NOT_FOUND') {
          return reply.status(404).send({ error: 'View not found' });
        }
        throw e;
      }
    },
  );

  // PATCH /api/boards/:boardId/views/:viewId/roadmap-config
  app.patch<{ Params: { boardId: string; viewId: string } }>(
    '/boards/:boardId/views/:viewId/roadmap-config',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const parsed = UpdateRoadmapConfigInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      try {
        const config = await configService.update(req.params.viewId, parsed.data);
        return reply.send({ config });
      } catch (e: unknown) {
        if (e instanceof Error && e.message === 'VIEW_NOT_FOUND') {
          return reply.status(404).send({ error: 'View not found' });
        }
        throw e;
      }
    },
  );
}
