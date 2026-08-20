import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@deckgauge/db';
import { RestoreBoardSyncExclusionsInputSchema } from '@deckgauge/shared';
import { BoardSyncService } from './board-sync.service.js';
import { BoardSyncExclusionService } from './board-sync-exclusion.service.js';
import {
  BoardSourceHealthService,
  isCredentialBlocked,
  type BoardSourceProbes,
} from './board-source-health.service.js';
import { board } from '../auth/policy.js';
import type { IntelligenceQueues } from '../intelligence/queues.js';
import { JiraInstanceService } from '../jira-instances/jira-instance.service.js';
import { GitHubService } from '../github/github.service.js';
import { GitLabService } from '../gitlab/gitlab.service.js';
import { AzureDevOpsService } from '../azure-devops/azure-devops.service.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

interface Deps {
  prisma: PrismaClient;
  queues: IntelligenceQueues | null;
  healthServiceFactory?: () => BoardSourceHealthService;
}

export function boardSyncRoutes(deps: Deps) {
  return async function plugin(app: FastifyInstance) {
    const ParamsSchema = z.object({ boardId: z.string().uuid() });

    // Takes the request so all four probes can be organization-scoped: every
    // provider's `testConnection` now resolves the instance through
    // (id, organizationId). `requireOrganizationId` sits AFTER the factory check
    // on purpose — an injected fake probe needs no tenant, so tests that supply
    // one are not forced to carry a membership.
    //
    // `BoardSourceProbes` still types a probe as `(instanceId) => …` and binds
    // the tenant in these closures rather than in its own signature. That is
    // deliberate: with organizationId now the FIRST required parameter of all
    // four services, an unscoped probe body no longer compiles, which is a
    // stronger guarantee than a parameter the health service would only forward.
    const buildHealthService = (req: FastifyRequest) => {
      if (deps.healthServiceFactory) return deps.healthServiceFactory();
      const organizationId = requireOrganizationId(req);
      const jira = new JiraInstanceService(deps.prisma);
      const github = new GitHubService(deps.prisma);
      const gitlab = new GitLabService(deps.prisma);
      const ado = new AzureDevOpsService(deps.prisma);
      const probes: BoardSourceProbes = {
        jira: (id) => jira.testConnection(organizationId, id),
        github: (id) => github.testConnection(organizationId, id),
        gitlab: (id) => gitlab.testConnection(organizationId, id),
        ado: (id) => ado.testConnection(organizationId, id),
      };
      return new BoardSourceHealthService(deps.prisma, probes);
    };

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/sync',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = ParamsSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });

        if (!deps.queues) {
          return reply.code(503).send({ error: 'sync queue not configured' });
        }

        const health = await buildHealthService(req).probe(params.data.boardId);
        // Named `expired` for wire compatibility, but it carries every
        // credential-blocked source — each entry keeps its own `state` so the UI
        // can say "reauthorize" where that is the real remedy.
        const expired = health.sources.filter((s) => isCredentialBlocked(s.state));
        const skip = new Set(expired.map((s) => s.instanceId));
        const service = new BoardSyncService(deps.prisma, deps.queues);
        const enqueued = await service.enqueueBoardSync(params.data.boardId, skip);
        return reply.code(202).send({
          boardId: params.data.boardId,
          enqueued,
          expired,
        });
      },
    );

    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sync/health',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = ParamsSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const health = await buildHealthService(req).probe(params.data.boardId);
        return reply.code(200).send(health);
      },
    );

    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sync/status',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = ParamsSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });

        // Queues not needed for status — pass a no-op stub when unavailable, since
        // BoardSyncService.getBoardSyncStatus only reads Prisma, not BullMQ.
        const service = new BoardSyncService(
          deps.prisma,
          (deps.queues ?? {
            jira: { add: async () => {} },
            github: { add: async () => {} },
            ado: { add: async () => {} },
            gitlab: { add: async () => {} },
          }) as never,
        );
        const status = await service.getBoardSyncStatus(params.data.boardId);
        return reply.code(200).send(status);
      },
    );

    // Deleting a synced row blacklists its key so the next sync cannot re-add
    // it. These two routes make that reversible: list what a board has
    // excluded, and drop entries so the next sync brings them back.
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/sync/exclusions',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = ParamsSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });

        const service = new BoardSyncExclusionService(deps.prisma);
        return reply.code(200).send(await service.list(params.data.boardId));
      },
    );

    app.delete<{ Params: { boardId: string } }>(
      '/boards/:boardId/sync/exclusions',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = ParamsSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });

        const body = RestoreBoardSyncExclusionsInputSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

        const service = new BoardSyncExclusionService(deps.prisma);
        const result = await service.restore(params.data.boardId, body.data.ids);
        return reply.code(200).send(result);
      },
    );
  };
}
