import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BoardJiraSourceCreateSchema,
  BoardJiraSourcePatchSchema,
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
import {
  SourceConnectionNotFoundError,
  defaultJiraAdapterFor,
} from './source-adapters.js';
import { CrossOrganizationSyncError } from './cross-organization-sync-error.js';
import { clickhouse as defaultClickhouse } from '@deckgauge/db';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { all, board, orgRole, ORG_MEMBER } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

/**
 * Type discovery spends the connection's stored credential, so its handler needs
 * the caller's organization to scope the connection resolve with. `board(VIEWER)`
 * cannot supply one: it allows a membership-less caller through on a bare board
 * grant (see its "no membership … the grant decides alone" branch), which would
 * reach `requireOrganizationId` and 500. `orgRole('VIEWER')` is the floor that
 * guarantees a membership — VIEWER rather than MEMBER because this is a read and
 * an org VIEWER may legitimately perform it.
 */
const DISCOVERY_POLICY = all(board('VIEWER'), orgRole('VIEWER'));

/**
 * Attaching a source takes a caller-supplied sync id and writes a row keyed to
 * it, so its handler needs the caller's organization to scope the sync resolve
 * with. `board('EDITOR')` cannot supply one: it deliberately admits a
 * membership-less caller on a bare BoardAccess grant (see its "the grant decides
 * alone" branch), which would reach `requireOrganizationId` and 500.
 *
 * `ORG_MEMBER` rather than `orgRole('VIEWER')` — the opposite choice from
 * DISCOVERY_POLICY, and for a reason that only holds here. `effectiveBoardRole`
 * caps an organization VIEWER at board VIEWER whatever their board grant says, so
 * no VIEWER can pass `board('EDITOR')` in the first place: MEMBER removes no
 * reachable capability, while it IS the documented floor for creating something a
 * tenant owns. On the VIEWER-level discovery reads MEMBER would have been a
 * regression, which is why they use `orgRole('VIEWER')` instead.
 */
const ATTACH_POLICY = all(board('EDITOR'), ORG_MEMBER);

// Type-cache TTL: 60s. Provider type lists change rarely (admin-edited issue
// types) so 60s is plenty fresh while still cutting the request rate ~60x for
// the "user-types-into-mapping-editor" interaction pattern.
const TYPE_CACHE_TTL_MS = 60_000;

// Shared instance so cache hits survive across requests within a single API
// process. Per-process is fine — we never need cross-replica coherency for
// "what issue types does this Jira project expose".
const defaultTypeCache: TypeCache = createTypeCache({ ttlMs: TYPE_CACHE_TTL_MS });

export function boardJiraSourceRoutes(deps: {
  prisma: PrismaClient;
  clickhouse?: ClickHouseClient;
  typeCache?: TypeCache;
  jiraAdapterFor?: (organizationId: string, instanceId: string) => Promise<JiraPort>;
}) {
  const service = new BoardJiraSourceService(deps.prisma);
  const ch = deps.clickhouse ?? defaultClickhouse;
  const previewSvc = new PreviewCountService({ prisma: deps.prisma, clickhouse: ch });
  const statusesSvc = new SourceStatusesService({ prisma: deps.prisma, clickhouse: ch });
  const issueTypesSvc = new SourceIssueTypesService({
    prisma: deps.prisma,
    cache: deps.typeCache ?? defaultTypeCache,
    jiraAdapterFor:
      deps.jiraAdapterFor ??
      ((organizationId, instanceId) =>
        defaultJiraAdapterFor(deps.prisma, organizationId, instanceId)),
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
      // Reads every JiraInstance in the organization to compute `fallback`, so it
      // needs a tenant to scope that read to — see DISCOVERY_POLICY for why
      // `board('VIEWER')` alone cannot supply one, and R4 in the service for what
      // the unscoped read leaked.
      { config: { policy: DISCOVERY_POLICY } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        return service.atlassianUrlsByProjectKey(
          requireOrganizationId(req),
          params.data.boardId,
        );
      },
    );

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/sources/jira',
      { config: { policy: ATTACH_POLICY } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = BoardJiraSourceCreateSchema.safeParse({
          ...(req.body as object),
          boardId: params.data.boardId,
        });
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        try {
          const row = await service.attach(requireOrganizationId(req), body.data);
          return reply.code(201).send(row);
        } catch (err) {
          // 404, not 403: see CrossOrganizationSyncError. The same answer an
          // unknown id gets, so the response cannot be used to enumerate.
          if (err instanceof CrossOrganizationSyncError) {
            return reply.code(404).send({ error: err.message });
          }
          throw err;
        }
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
      { config: { policy: DISCOVERY_POLICY } },
      async (req, reply) => {
        const params = z
          .object({ boardId: z.string().uuid(), id: z.string().uuid() })
          .safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        try {
          const types = await issueTypesSvc.listJira(
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
