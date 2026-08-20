import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GitHubRepoSyncService } from './github-repo-sync.service.js';
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
import { requireOrganizationId } from '../organizations/request-organization.js';
import { denySyncDetach } from './sync-detach-guard.js';

// Per Task 16: syncPrs/syncCommits flags were removed. The new bulk-repo
// ingestion always syncs PRs, reviews, commits, workflow runs, deployments,
// and issues per repo; cadence is governed by tier.
const GitHubRepoSyncCreateSchema = z.object({
  githubInstanceId: z.string().uuid(),
  repoFullName: z.string().regex(/^[^/]+\/[^/]+$/),
});

// GitHubRepoSync has no boardId of its own — it's keyed by
// (githubInstanceId, repoFullName) and attaches to boards through a separate
// many-to-many join (packages/db/prisma/schema.prisma). No route here carries
// a resolvable board id, so no route can be board-scoped; they are
// organization-scoped instead.
export function githubRepoSyncRoutes(deps: { prisma: PrismaClient; singleUser?: boolean }) {
  const service = new GitHubRepoSyncService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    app.get('/project-syncs/github', { config: { policy: ORG_VIEWER } }, async (req) =>
      service.list(requireOrganizationId(req)),
    );

    app.post('/project-syncs/github', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = GitHubRepoSyncCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.create(body.data);
      return reply.code(201).send(row);
    });

    app.delete<{ Params: { id: string } }>('/project-syncs/github/:id', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      // GitHubRepoSync.id is a cuid (Prisma default), not a uuid — never
      // validate it with z.string().uuid() or every delete 400s.
      const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      // Cascade-deletes the BoardGitHubSource row of every board using this
      // repo sync — gated on EDITOR over those boards. See sync-detach-guard.ts.
      const denial = await denySyncDetach(
        deps.prisma,
        'github',
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

    app.post('/project-syncs/github/ensure', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = z
        .object({ githubInstanceId: z.string().uuid(), repoFullName: z.string().min(1) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.ensureSync(body.data.githubInstanceId, body.data.repoFullName);
      return reply.code(200).send(row);
    });
  };
}
