import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdoProjectSyncService } from './ado-project-sync.service.js';
import type { PrismaClient } from '@deckgauge/db';
/**
 * Sync-config WRITES require an organization member, not merely a signed-in
 * caller. `AUTHENTICATED` is not an authorization decision: it let an
 * organization VIEWER — or any account at all — create, repoint or delete
 * another person's sync configuration.
 *
 * The GET read is `ORG_VIEWER` — any active membership, VIEWER included. It is
 * scoped to the caller's organization, and the organization comes from the
 * membership, so the membership has to be guaranteed; but a VIEWER must still
 * read, so the floor is VIEWER and not MEMBER. It was `AUTHENTICATED` on the argument that
 * knowing which syncs exist is not credential-spending — true, but it enumerated
 * EVERY organization's rows, handing out another tenant's instance ids, project
 * names and cadence. Scoping it is what forced the policy: `requireOrganizationId`
 * throws a 500 rather than inventing a tenant, so it may only be called behind an
 * `orgRole` policy. Ordinary members are unaffected; a membership-less break-glass
 * admin now recovers through POST /organizations/bootstrap, as on the other
 * connection routes. See project-sync-tenancy.test.ts.
 */
import { ORG_MEMBER, ORG_VIEWER } from '../auth/policy.js';
import { denySyncDetach } from './sync-detach-guard.js';
import { connectionCaller } from '../connections/connection-caller.js';

const AdoProjectSyncCreateSchema = z.object({
  azureDevOpsInstanceId: z.string().uuid(),
  adoProject: z.string().min(1),
  syncPrs: z.boolean().default(false),
  syncCommits: z.boolean().default(false),
  syncRepos: z.array(z.string()).default([]),
  syncAllRepos: z.boolean().default(false),
});

// AzureDevOpsProjectSync (routes as "ado") has no boardId of its own — it's
// keyed by (azureDevOpsInstanceId, adoProject) and attaches to boards through
// a separate many-to-many join (packages/db/prisma/schema.prisma). No route
// here carries a resolvable board id, so no route can be board-scoped; they
// are organization-scoped instead.
export function adoProjectSyncRoutes(deps: { prisma: PrismaClient; singleUser?: boolean }) {
  const service = new AdoProjectSyncService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    app.get('/project-syncs/ado', { config: { policy: ORG_VIEWER } }, async (req) =>
      service.list(connectionCaller(req)),
    );

    app.post('/project-syncs/ado', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = AdoProjectSyncCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.create(body.data);
      return reply.code(201).send(row);
    });

    app.patch<{ Params: { id: string } }>('/project-syncs/ado/:id', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = z
        .object({
          syncPrs: z.boolean().optional(),
          syncCommits: z.boolean().optional(),
          syncRepos: z.array(z.string()).optional(),
          syncAllRepos: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.update(params.data.id, body.data);
    });

    // Deleting a sync cascade-deletes the BoardAdoSource row of every board
    // using it — gated on EDITOR over those boards. See sync-detach-guard.ts.
    app.delete<{ Params: { id: string } }>('/project-syncs/ado/:id', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const denial = await denySyncDetach(
        deps.prisma,
        'ado',
        params.data.id,
        req.user?.id,
        deps.singleUser ?? false,
        req.log,
        req.membership ?? null,
      );
      if (denial) return reply.code(403).send({ error: denial.message, boardIds: denial.boardIds });
      await service.delete(params.data.id);
      return reply.code(204).send();
    });

    app.post('/project-syncs/ado/ensure', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = z
        .object({ azureDevOpsInstanceId: z.string().uuid(), adoProject: z.string().min(1) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.ensureSync(body.data.azureDevOpsInstanceId, body.data.adoProject);
      return reply.code(200).send(row);
    });
  };
}
