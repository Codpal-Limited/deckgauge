import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BoardGitLabSourceCreateSchema } from '@deckgauge/shared';
import { BoardGitLabSourceService } from './board-gitlab-source.service.js';
import { PreviewCountService, PreviewSourceNotFoundError } from './preview-count.service.js';
import { clickhouse as defaultClickhouse } from '@deckgauge/db';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { all, board, ORG_MEMBER } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';
import { CrossOrganizationSyncError } from './cross-organization-sync-error.js';

// Why this is not a bare `board('EDITOR')`, and why ORG_MEMBER rather than
// orgRole('VIEWER') — see the identical constant in board-jira-source.routes.ts.
const ATTACH_POLICY = all(board('EDITOR'), ORG_MEMBER);

export function boardGitLabSourceRoutes(deps: {
  prisma: PrismaClient;
  clickhouse?: ClickHouseClient;
}) {
  const service = new BoardGitLabSourceService(deps.prisma);
  const previewSvc = new PreviewCountService({
    prisma: deps.prisma,
    clickhouse: deps.clickhouse ?? defaultClickhouse,
  });
  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/gitlab',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        return service.list(params.data.boardId);
      },
    );

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/gitlab',
      { config: { policy: ATTACH_POLICY } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = BoardGitLabSourceCreateSchema.safeParse({
          ...(req.body as object),
          boardId: params.data.boardId,
        });
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        try {
          const row = await service.attach(requireOrganizationId(req), body.data);
          return reply.code(201).send(row);
        } catch (err) {
          if (err instanceof CrossOrganizationSyncError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );

    app.patch<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/gitlab/:id',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = z
          .object({
            targetGroupId: z.string().uuid().nullable().optional(),
            syncIssuesToBoard: z.boolean().optional(),
            syncMrsToBoard: z.boolean().optional(),
          })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        return service.update(params.data.id, body.data);
      },
    );

    app.delete<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/gitlab/:id',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        await service.detach(params.data.id);
        return reply.code(204).send();
      },
    );

    app.get<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/gitlab/:id/preview-count',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          return await previewSvc.countGitLabIssues(params.data.id);
        } catch (err) {
          if (err instanceof PreviewSourceNotFoundError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );
  };
}
