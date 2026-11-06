import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@deckgauge/db';
import { ImportSourceLinkInputSchema } from '@deckgauge/shared';
import { all, board, ORG_MEMBER } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';
import {
  defaultAdoAdapterFor,
  defaultGitHubAdapterFor,
  defaultJiraAdapterFor,
  SourceConnectionNotFoundError,
} from '../board-sources/source-adapters.js';
import { AutomationService } from '../automations/automation.service.js';
import type { IntelligenceQueues } from '../intelligence/queues.js';
import {
  SourceLinkError,
  SourceLinkImportService,
  type EnqueueSourceSync,
  type SourceLinkAdapters,
} from './source-link-import.service.js';

// Adds a row, so EDITOR on the board; spends a stored connection credential, so
// an organization MEMBER — the same pairing as attaching a source.
const IMPORT_POLICY = all(board('EDITOR'), ORG_MEMBER);

interface Deps {
  prisma: PrismaClient;
  queues: IntelligenceQueues | null;
  adapters?: SourceLinkAdapters;
}

export function sourceLinkRoutes(deps: Deps) {
  const adapters: SourceLinkAdapters = deps.adapters ?? {
    jira: (org, id) => defaultJiraAdapterFor(deps.prisma, org, id),
    github: (org, id) => defaultGitHubAdapterFor(deps.prisma, org, id),
    ado: (org, id) => defaultAdoAdapterFor(deps.prisma, org, id),
  };
  // The board's PROMOTE queues only: the row needs reconciling, not analytics.
  const enqueue: EnqueueSourceSync = async ({ provider, instanceId, key }) => {
    const q = deps.queues;
    if (!q) return;
    if (provider === 'jira') await q.jiraSync.add('manual', { trigger: 'manual', instanceId, projectKeys: [key] });
    else if (provider === 'github') await q.githubSync.add('manual', { trigger: 'manual', instanceId, repos: [key] });
    else await q.adoSync.add('manual', { trigger: 'manual', instanceId, projects: [key] });
  };
  const service = new SourceLinkImportService(deps.prisma, adapters, enqueue);
  const automations = new AutomationService(deps.prisma);

  return async function plugin(app: FastifyInstance) {
    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/items/from-source-link',
      { config: { policy: IMPORT_POLICY } },
      async (req, reply) => {
        const params = z.object({ boardId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = ImportSourceLinkInputSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        const organizationId = requireOrganizationId(req);

        try {
          const result = await service.importFromLink({
            organizationId,
            boardId: params.data.boardId,
            groupId: body.data.groupId,
            url: body.data.url,
          });

          // `item_created`, as for a row added by name — see project.routes.ts.
          try {
            const row = await deps.prisma.project.findUnique({
              where: { id: result.projectId },
              select: { status: true, statusId: true },
            });
            await automations.evaluateTriggers(
              params.data.boardId,
              result.projectId,
              { status: row?.status, statusId: row?.statusId ?? null },
              { actorId: req.user?.id ?? null, organizationId },
            );
          } catch (err) {
            app.log.error(err, 'Automation trigger evaluation failed');
          }

          return reply.code(201).send(result);
        } catch (err) {
          if (err instanceof SourceLinkError) {
            return reply.code(err.status).send({ error: err.message, code: err.code });
          }
          // A board source pointing at a connection outside the caller's
          // organization: indistinguishable from "no such source", by design.
          if (err instanceof SourceConnectionNotFoundError) {
            return reply
              .code(422)
              .send({ error: 'This board has no usable connection for that link.', code: 'not_a_board_source' });
          }
          throw err;
        }
      },
    );
  };
}
