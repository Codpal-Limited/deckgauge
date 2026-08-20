import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BoardGitHubSourceCreateSchema,
  BoardGitHubSourcePatchSchema,
  BulkBindRequestSchema,
  type BulkBindResponse,
  type GitHubPort,
} from '@deckgauge/shared';
import {
  BoardGitHubSourceService,
  bulkBind,
  removeRepo,
  type QueueClient,
} from './board-github-source.service.js';
import { PreviewCountService, PreviewSourceNotFoundError } from './preview-count.service.js';
import {
  SourceStatusesService,
  SourceStatusesNotFoundError,
} from './source-statuses.service.js';
import {
  SourceIssueTypesService,
  SourceIssueTypesNotFoundError,
} from './source-issue-types.service.js';
import { createTypeCache, type TypeCache } from './type-cache.js';
import { SourceConnectionNotFoundError, defaultGitHubAdapterFor } from './source-adapters.js';
import { CrossOrganizationSyncError } from './cross-organization-sync-error.js';
import { clickhouse as defaultClickhouse } from '@deckgauge/db';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { all, board, orgRole, ORG_MEMBER } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

// Why this is not a bare `board('VIEWER')` — see the identical constant in
// board-jira-source.routes.ts.
const DISCOVERY_POLICY = all(board('VIEWER'), orgRole('VIEWER'));

// Why this is not a bare `board('EDITOR')`, and why ORG_MEMBER rather than
// orgRole('VIEWER') — see the identical constant in board-jira-source.routes.ts.
// Covers the bulk route too: it is the same attach, in bulk, from the same
// request-supplied connection id.
const ATTACH_POLICY = all(board('EDITOR'), ORG_MEMBER);

// Same 60s TTL as Jira/ADO — see board-jira-source.routes.ts for rationale.
const TYPE_CACHE_TTL_MS = 60_000;

const defaultTypeCache: TypeCache = createTypeCache({ ttlMs: TYPE_CACHE_TTL_MS });

export function boardGitHubSourceRoutes(deps: {
  prisma: PrismaClient;
  clickhouse?: ClickHouseClient;
  typeCache?: TypeCache;
  githubAdapterFor?: (organizationId: string, instanceId: string) => Promise<GitHubPort>;
  queueClient?: QueueClient;
}) {
  const service = new BoardGitHubSourceService(deps.prisma);
  const queueClient: QueueClient = deps.queueClient ?? {
    enqueueInitialBackfill: async () => {
      /* no-op until Task 16 wires the real BullMQ-backed queue */
    },
    removeRepeatables: async () => {
      /* no-op until Task 16 wires the real BullMQ-backed queue */
    },
  };
  const ch = deps.clickhouse ?? defaultClickhouse;
  const previewSvc = new PreviewCountService({ prisma: deps.prisma, clickhouse: ch });
  const statusesSvc = new SourceStatusesService({ prisma: deps.prisma, clickhouse: ch });
  const issueTypesSvc = new SourceIssueTypesService({
    prisma: deps.prisma,
    cache: deps.typeCache ?? defaultTypeCache,
    // Jira/ADO not used on GitHub routes — stubs satisfy Deps shape.
    jiraAdapterFor: () => {
      throw new Error('jiraAdapterFor not configured on GitHub routes');
    },
    adoAdapterFor: () => {
      throw new Error('adoAdapterFor not configured on GitHub routes');
    },
    githubAdapterFor:
      deps.githubAdapterFor ??
      ((organizationId, instanceId) =>
        defaultGitHubAdapterFor(deps.prisma, organizationId, instanceId)),
  });
  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/github',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        return service.list(params.data.boardId);
      },
    );

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/github',
      { config: { policy: ATTACH_POLICY } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = BoardGitHubSourceCreateSchema.safeParse({
          ...(req.body as object),
          boardId: params.data.boardId,
        });
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        // Hoisted out of the try: inside it, the P2002 branch below would be
        // consulted for MissingOrganizationError too — harmlessly today, but the
        // route-table bug it reports must not be shadowed by an attach-specific
        // catch. Same reasoning as the GitHub picker's requireOrganizationId.
        const organizationId = requireOrganizationId(req);
        try {
          const row = await service.attach(organizationId, body.data);
          return reply.code(201).send(row);
        } catch (err: unknown) {
          // 404, not 403: see CrossOrganizationSyncError.
          if (err instanceof CrossOrganizationSyncError) {
            return reply.code(404).send({ error: err.message });
          }
          const code = (err as { code?: string } | null)?.code;
          if (code === 'P2002') {
            return reply.code(409).send({ error: 'This repo is already attached to this board.' });
          }
          throw err;
        }
      },
    );

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/github/bulk',
      { config: { policy: ATTACH_POLICY } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });

        const body = BulkBindRequestSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

        try {
          const result: BulkBindResponse = await bulkBind({
            prisma: deps.prisma,
            queueClient,
            organizationId: requireOrganizationId(req),
            boardId: params.data.boardId,
            instanceId: body.data.instanceId,
            repos: body.data.repos,
            backfillMonths: body.data.backfillMonths,
            targetGroupId: body.data.targetGroupId ?? null,
          });
          return reply.send(result);
        } catch (err) {
          if (err instanceof CrossOrganizationSyncError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );

    app.patch<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/github/:id',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = BoardGitHubSourcePatchSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        return service.update(params.data.id, body.data);
      },
    );

    app.delete<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/github/:id',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          await removeRepo({
            prisma: deps.prisma,
            queueClient,
            boardId: params.data.boardId,
            boardGitHubSourceId: params.data.id,
          });
          return reply.code(204).send();
        } catch (err: unknown) {
          const code = (err as { code?: string } | null)?.code;
          if (code === 'P2025') return reply.code(404).send({ error: 'not found' });
          throw err;
        }
      },
    );

    app.get<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/github/:id/preview-count',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          return await previewSvc.countGitHubIssues(params.data.id);
        } catch (err) {
          if (err instanceof PreviewSourceNotFoundError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );

    app.get<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/github/:id/source-statuses',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          const statuses = await statusesSvc.listGitHub(params.data.id);
          return { statuses };
        } catch (err) {
          if (err instanceof SourceStatusesNotFoundError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );

    app.get<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/github/:id/labels',
      { config: { policy: DISCOVERY_POLICY } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          const labels = await issueTypesSvc.listGitHubLabels(
            requireOrganizationId(req),
            params.data.boardId,
            params.data.id,
          );
          reply.header('Cache-Control', 'max-age=60, must-revalidate');
          return { labels };
        } catch (err) {
          if (
            err instanceof SourceIssueTypesNotFoundError ||
            err instanceof SourceConnectionNotFoundError
          ) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );

    app.get<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/github/:id/issue-types',
      { config: { policy: DISCOVERY_POLICY } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          const types = await issueTypesSvc.listGitHubIssueTypes(
            requireOrganizationId(req),
            params.data.boardId,
            params.data.id,
          );
          reply.header('Cache-Control', 'max-age=60, must-revalidate');
          return { types };
        } catch (err) {
          if (
            err instanceof SourceIssueTypesNotFoundError ||
            err instanceof SourceConnectionNotFoundError
          ) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );
  };
}
