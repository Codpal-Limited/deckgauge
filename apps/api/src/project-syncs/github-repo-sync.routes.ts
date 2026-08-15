import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GitHubRepoSyncService } from './github-repo-sync.service.js';
import type { PrismaClient } from '@deckgauge/db';
import { AUTHENTICATED } from '../auth/policy.js';
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
// a resolvable board id, so every route is AUTHENTICATED.
export function githubRepoSyncRoutes(deps: { prisma: PrismaClient; singleUser?: boolean }) {
  const service = new GitHubRepoSyncService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    app.get('/project-syncs/github', { config: { policy: AUTHENTICATED } }, async () => service.list());

    app.post('/project-syncs/github', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const body = GitHubRepoSyncCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.create(body.data);
      return reply.code(201).send(row);
    });

    app.delete<{ Params: { id: string } }>('/project-syncs/github/:id', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
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
      );
      if (denial) return reply.code(403).send({ error: denial.message, boardIds: denial.boardIds });
      await service.delete(params.data.id);
      return reply.code(204).send();
    });

    app.post('/project-syncs/github/ensure', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
      const body = z
        .object({ githubInstanceId: z.string().uuid(), repoFullName: z.string().min(1) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.ensureSync(body.data.githubInstanceId, body.data.repoFullName);
      return reply.code(200).send(row);
    });
  };
}
