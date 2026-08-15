import type { FastifyInstance } from 'fastify';
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

interface Deps {
  prisma: PrismaClient;
  queues: IntelligenceQueues | null;
  healthServiceFactory?: () => BoardSourceHealthService;
}

export function boardSyncRoutes(deps: Deps) {
  return async function plugin(app: FastifyInstance) {
    const ParamsSchema = z.object({ boardId: z.string().uuid() });

    const buildHealthService = () => {
      if (deps.healthServiceFactory) return deps.healthServiceFactory();
      const jira = new JiraInstanceService(deps.prisma);
      const github = new GitHubService(deps.prisma);
      const gitlab = new GitLabService(deps.prisma);
      const ado = new AzureDevOpsService(deps.prisma);
      const probes: BoardSourceProbes = {
        jira: (id) => jira.testConnection(id),
        github: (id) => github.testConnection(id),
        gitlab: (id) => gitlab.testConnection(id),
        ado: (id) => ado.testConnection(id),
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

        const health = await buildHealthService().probe(params.data.boardId);
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
        const health = await buildHealthService().probe(params.data.boardId);
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
