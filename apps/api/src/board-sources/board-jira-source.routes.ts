import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BoardJiraSourceCreateSchema,
  BoardJiraSourcePatchSchema,
  JiraCloudAdapter,
  type JiraPort,
} from '@deckgauge/shared';
import { BoardJiraSourceService } from './board-jira-source.service.js';
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
import { clickhouse as defaultClickhouse } from '@deckgauge/db';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { board } from '../auth/policy.js';

// Type-cache TTL: 60s. Provider type lists change rarely (admin-edited issue
// types) so 60s is plenty fresh while still cutting the request rate ~60x for
// the "user-types-into-mapping-editor" interaction pattern.
const TYPE_CACHE_TTL_MS = 60_000;

// Shared instance so cache hits survive across requests within a single API
// process. Per-process is fine — we never need cross-replica coherency for
// "what issue types does this Jira project expose".
const defaultTypeCache: TypeCache = createTypeCache({ ttlMs: TYPE_CACHE_TTL_MS });

async function defaultJiraAdapterFor(
  prisma: PrismaClient,
  instanceId: string,
): Promise<JiraPort> {
  const instance = await prisma.jiraInstance.findUniqueOrThrow({ where: { id: instanceId } });
  return new JiraCloudAdapter({
    atlassianUrl: instance.atlassianUrl,
    email: instance.email,
    apiToken: instance.apiToken,
    projectKeys: instance.projectKeys,
  });
}

export function boardJiraSourceRoutes(deps: {
  prisma: PrismaClient;
  clickhouse?: ClickHouseClient;
  typeCache?: TypeCache;
  jiraAdapterFor?: (instanceId: string) => Promise<JiraPort>;
}) {
  const service = new BoardJiraSourceService(deps.prisma);
  const ch = deps.clickhouse ?? defaultClickhouse;
  const previewSvc = new PreviewCountService({ prisma: deps.prisma, clickhouse: ch });
  const statusesSvc = new SourceStatusesService({ prisma: deps.prisma, clickhouse: ch });
  const issueTypesSvc = new SourceIssueTypesService({
    prisma: deps.prisma,
    cache: deps.typeCache ?? defaultTypeCache,
    jiraAdapterFor:
      deps.jiraAdapterFor ?? ((instanceId) => defaultJiraAdapterFor(deps.prisma, instanceId)),
    // ADO not used by Jira routes; supply a stub that the service never calls
    // on this path so the Deps shape stays satisfied.
    adoAdapterFor: () => {
      throw new Error('adoAdapterFor not configured on Jira routes');
    },
    githubAdapterFor: () => {
      throw new Error('githubAdapterFor not configured on Jira routes');
    },
  });
  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/jira',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        return service.list(params.data.boardId);
      },
    );

    // jiraProjectKey -> atlassianUrl (+ a fallback for rows whose source was
    // detached), scoped to this board. Lets the web app build each row's Source-column
    // link from the Jira site it actually synced from, instead of one global URL.
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/jira/atlassian-urls',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        return service.atlassianUrlsByProjectKey(params.data.boardId);
      },
    );

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/jira',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = BoardJiraSourceCreateSchema.safeParse({
          ...(req.body as object),
          boardId: params.data.boardId,
        });
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        const row = await service.attach(body.data);
        return reply.code(201).send(row);
      },
    );

    app.patch<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/jira/:id',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = BoardJiraSourcePatchSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        return service.update(params.data.id, body.data);
      },
    );

    app.delete<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/jira/:id',
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
      '/boards/:boardId/sources/jira/:id/preview-count',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          return await previewSvc.countJiraIssues(params.data.id);
        } catch (err) {
          if (err instanceof PreviewSourceNotFoundError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );

    app.get<{ Params: { boardId: string; id: string } }>(
      '/boards/:boardId/sources/jira/:id/source-statuses',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          const statuses = await statusesSvc.listJira(params.data.id);
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
      '/boards/:boardId/sources/jira/:id/issue-types',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          const types = await issueTypesSvc.listJira(params.data.boardId, params.data.id);
          reply.header('Cache-Control', 'max-age=60, must-revalidate');
          return { types };
        } catch (err) {
          if (err instanceof SourceIssueTypesNotFoundError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
      },
    );
  };
}
