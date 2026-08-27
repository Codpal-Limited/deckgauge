import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BoardAdoSourceCreateSchema,
  BoardAdoSourcePatchSchema,
  type AzureDevOpsPort,
} from '@deckgauge/shared';
import { BoardAdoSourceService } from './board-ado-source.service.js';
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
import { SourceConnectionNotFoundError, defaultAdoAdapterFor } from './source-adapters.js';
import { CrossOrganizationSyncError } from './cross-organization-sync-error.js';
import { clickhouse as defaultClickhouse } from '@deckgauge/db';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { all, board, orgRole, ORG_MEMBER } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';
import { connectionCaller } from '../connections/connection-caller.js';

// Why this is not a bare `board('VIEWER')` — see the identical constant in
// board-jira-source.routes.ts.
const DISCOVERY_POLICY = all(board('VIEWER'), orgRole('VIEWER'));

// Why this is not a bare `board('EDITOR')`, and why ORG_MEMBER rather than
// orgRole('VIEWER') — see the identical constant in board-jira-source.routes.ts.
const ATTACH_POLICY = all(board('EDITOR'), ORG_MEMBER);

// Same 60s TTL as Jira — see board-jira-source.routes.ts for rationale.
const TYPE_CACHE_TTL_MS = 60_000;

const defaultTypeCache: TypeCache = createTypeCache({ ttlMs: TYPE_CACHE_TTL_MS });

export function boardAdoSourceRoutes(deps: {
  prisma: PrismaClient;
  clickhouse?: ClickHouseClient;
  typeCache?: TypeCache;
  adoAdapterFor?: (organizationId: string, instanceId: string) => Promise<AzureDevOpsPort>;
}) {
  const service = new BoardAdoSourceService(deps.prisma);
  const ch = deps.clickhouse ?? defaultClickhouse;
  /**
   * Built per request from the scoped reader (tenancy §11 precondition 8), not
   * once at boot from the ingest singleton whose permissive policy no
   * per-organization row policy can narrow. `ch` stays the fallback only for
   * callers constructing this plugin without the chRead plugin, i.e. the tests.
   */
  const previewSvcFor = (req: FastifyRequest) =>
    new PreviewCountService({ prisma: deps.prisma, clickhouse: req.chRead ?? ch });
  const statusesSvcFor = (req: FastifyRequest) =>
    new SourceStatusesService({ prisma: deps.prisma, clickhouse: req.chRead ?? ch });
  const issueTypesSvc = new SourceIssueTypesService({
    prisma: deps.prisma,
    cache: deps.typeCache ?? defaultTypeCache,
    // Jira not used on ADO routes — see Jira routes for the symmetric comment.
    jiraAdapterFor: () => {
      throw new Error('jiraAdapterFor not configured on ADO routes');
    },
    adoAdapterFor:
      deps.adoAdapterFor ??
      ((organizationId, instanceId) =>
        defaultAdoAdapterFor(deps.prisma, organizationId, instanceId)),
    githubAdapterFor: () => {
      throw new Error('githubAdapterFor not configured on ADO routes');
    },
  });
  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/ado',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        return service.list(params.data.boardId);
      },
    );

    // adoProject -> orgUrl, scoped to this board. Consumed by the web app to
    // build each row's Source-column link against the ADO org it actually
    // synced from, instead of a single global org URL for every board.
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/ado/org-urls',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        return service.orgUrlsByProject(params.data.boardId);
      },
    );

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/ado',
      { config: { policy: ATTACH_POLICY } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = BoardAdoSourceCreateSchema.safeParse({
          ...(req.body as object),
          boardId: params.data.boardId,
        });
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        try {
          const row = await service.attach(connectionCaller(req), body.data);
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
      '/boards/:boardId/sources/ado/:id',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = BoardAdoSourcePatchSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        return service.update(params.data.id, body.data);
      },
    );

    app.delete<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/ado/:id',
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
      '/boards/:boardId/sources/ado/:id/preview-count',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          return await previewSvcFor(req).countAdoWorkItems(params.data.id);
        } catch (err) {
          if (err instanceof PreviewSourceNotFoundError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );

    app.get<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/ado/:id/source-statuses',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          const statuses = await statusesSvcFor(req).listAdo(params.data.id);
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
      '/boards/:boardId/sources/ado/:id/work-item-types',
      { config: { policy: DISCOVERY_POLICY } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          const types = await issueTypesSvc.listAdo(
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
