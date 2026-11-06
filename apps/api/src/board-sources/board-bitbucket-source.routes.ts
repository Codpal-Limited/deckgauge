// /boards/:boardId/sources/bitbucket — mirrors board-gitlab-source.routes.ts,
// plus GitHub's `/bulk` ("select all in project").
//
// Policies, unchanged from GitLab:
//   - reads (list, preview-count) are board(VIEWER);
//   - attach and bulk are all(board('EDITOR'), ORG_MEMBER) — they take a
//     caller-supplied connection/sync id, so the board gate alone is not
//     enough (see board-jira-source.routes.ts);
//   - patch and detach are board('EDITOR'), and the service resolves the source
//     WITHIN that board, so another board's source id is a 404.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BoardBitbucketSourceCreateSchema,
  BoardBitbucketSourcePatchSchema,
  BoardBitbucketSourceBulkCreateSchema,
} from '@deckgauge/shared';
import { clickhouse as defaultClickhouse } from '@deckgauge/db';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import {
  BoardBitbucketSourceService,
  BitbucketTargetGroupError,
  bulkBindBitbucket,
} from './board-bitbucket-source.service.js';
import { PreviewCountService, PreviewSourceNotFoundError } from './preview-count.service.js';
import { CrossOrganizationSyncError } from './cross-organization-sync-error.js';
import { BitbucketRepoWorkspaceMismatchError } from '../project-syncs/bitbucket-repo-sync.service.js';
import { all, board, ORG_MEMBER } from '../auth/policy.js';
import { connectionCaller } from '../connections/connection-caller.js';

const ATTACH_POLICY = all(board('EDITOR'), ORG_MEMBER);

const BoardParams = z.object({ boardId: z.string().uuid() });
const SourceParams = z.object({ boardId: z.string().uuid(), id: z.string().uuid() });

/** 404 for a foreign sync/instance (never 403 — no enumeration oracle), 400 for bad input. */
function refusal(err: unknown): { status: number; error: string } | null {
  if (err instanceof CrossOrganizationSyncError) return { status: 404, error: err.message };
  if (err instanceof BitbucketRepoWorkspaceMismatchError) return { status: 400, error: err.message };
  if (err instanceof BitbucketTargetGroupError) return { status: 400, error: err.message };
  return null;
}

export function boardBitbucketSourceRoutes(deps: { prisma: PrismaClient; clickhouse?: ClickHouseClient }) {
  const service = new BoardBitbucketSourceService(deps.prisma);
  /** Per request from the scoped reader (tenancy §11 precondition 8) — see the GitLab routes. */
  const previewSvcFor = (req: FastifyRequest) =>
    new PreviewCountService({ prisma: deps.prisma, clickhouse: req.chRead ?? deps.clickhouse ?? defaultClickhouse });

  return async function plugin(app: FastifyInstance) {
    app.get('/boards/:boardId/sources/bitbucket', { config: { policy: board('VIEWER') } }, async (req, reply) => {
      const params = BoardParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      return service.list(params.data.boardId);
    });

    app.post('/boards/:boardId/sources/bitbucket', { config: { policy: ATTACH_POLICY } }, async (req, reply) => {
      const params = BoardParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = BoardBitbucketSourceCreateSchema.safeParse({ ...(req.body as object), boardId: params.data.boardId });
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        return reply.code(201).send(await service.attach(connectionCaller(req), body.data));
      } catch (err) {
        const r = refusal(err);
        if (r) return reply.code(r.status).send({ error: r.error });
        throw err;
      }
    });

    app.post('/boards/:boardId/sources/bitbucket/bulk', { config: { policy: ATTACH_POLICY } }, async (req, reply) => {
      const params = BoardParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = BoardBitbucketSourceBulkCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        const result = await bulkBindBitbucket({
          prisma: deps.prisma,
          caller: connectionCaller(req),
          boardId: params.data.boardId,
          instanceId: body.data.instanceId,
          repos: body.data.repos,
          targetGroupId: body.data.targetGroupId ?? null,
        });
        return reply.code(201).send(result);
      } catch (err) {
        const r = refusal(err);
        if (r) return reply.code(r.status).send({ error: r.error });
        throw err;
      }
    });

    app.patch('/boards/:boardId/sources/bitbucket/:id', { config: { policy: board('EDITOR') } }, async (req, reply) => {
      const params = SourceParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = BoardBitbucketSourcePatchSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        const row = await service.update(params.data.boardId, params.data.id, body.data);
        if (!row) return reply.code(404).send({ error: 'Source not found' });
        return reply.send(row);
      } catch (err) {
        const r = refusal(err);
        if (r) return reply.code(r.status).send({ error: r.error });
        throw err;
      }
    });

    app.delete('/boards/:boardId/sources/bitbucket/:id', { config: { policy: board('EDITOR') } }, async (req, reply) => {
      const params = SourceParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const removed = await service.detach(params.data.boardId, params.data.id);
      if (!removed) return reply.code(404).send({ error: 'Source not found' });
      return reply.code(204).send();
    });

    app.get(
      '/boards/:boardId/sources/bitbucket/:id/preview-count',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = SourceParams.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          return await previewSvcFor(req).countBitbucketPullRequests(params.data.boardId, params.data.id);
        } catch (err) {
          if (err instanceof PreviewSourceNotFoundError) return reply.code(404).send({ error: err.message });
          throw err;
        }
      },
    );
  };
}
