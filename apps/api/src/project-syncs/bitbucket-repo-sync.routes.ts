// /project-syncs/bitbucket — sync configuration for Bitbucket repositories.
// Policies mirror gitlab-project-sync.routes.ts (read that header): the GET is
// ORG_VIEWER (open to a viewer, tenant from the membership), every write is
// ORG_MEMBER. Unlike GitLab, every write also resolves the instance / sync
// through the caller, so a foreign id is a 404 rather than a write.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@deckgauge/db';
import { BitbucketRepoSyncCreateSchema } from '@deckgauge/shared';
import {
  BitbucketRepoSyncService,
  BitbucketRepoSyncNotFoundError,
  BitbucketRepoWorkspaceMismatchError,
} from './bitbucket-repo-sync.service.js';
import { ORG_MEMBER, ORG_VIEWER } from '../auth/policy.js';
import { denySyncDetach } from './sync-detach-guard.js';
import { connectionCaller } from '../connections/connection-caller.js';

const IdParams = z.object({ id: z.string().uuid() });

const EnsureSchema = z.object({
  bitbucketInstanceId: z.string().uuid(),
  repoFullName: BitbucketRepoSyncCreateSchema.shape.repoFullName,
  projectKey: z.string().min(1).nullable().optional(),
});

const PatchSchema = z.object({
  syncPrs: z.boolean().optional(),
  syncCommits: z.boolean().optional(),
  syncDeployments: z.boolean().optional(),
});

/** Maps the service's refusals; rethrows anything else. */
function mapError(err: unknown): { status: number; error: string } {
  if (err instanceof BitbucketRepoSyncNotFoundError) return { status: 404, error: err.message };
  if (err instanceof BitbucketRepoWorkspaceMismatchError) return { status: 400, error: err.message };
  throw err;
}

export function bitbucketRepoSyncRoutes(deps: { prisma: PrismaClient; singleUser?: boolean }) {
  const service = new BitbucketRepoSyncService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    app.get('/project-syncs/bitbucket', { config: { policy: ORG_VIEWER } }, async (req) =>
      service.list(connectionCaller(req)),
    );

    app.post('/project-syncs/bitbucket', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = BitbucketRepoSyncCreateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        return reply.code(201).send(await service.create(connectionCaller(req), body.data));
      } catch (err) {
        const { status, error } = mapError(err);
        return reply.code(status).send({ error });
      }
    });

    app.patch('/project-syncs/bitbucket/:id', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = PatchSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      const row = await service.update(connectionCaller(req), params.data.id, body.data);
      if (!row) return reply.code(404).send({ error: 'Sync not found' });
      return reply.send(row);
    });

    // Deleting a sync cascade-deletes the BoardBitbucketSource row of every
    // board using it — gated on EDITOR over those boards. See sync-detach-guard.ts.
    app.delete('/project-syncs/bitbucket/:id', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      // Scope first: the detach guard below answers 403 WITH the attached board
      // ids, so running it on a sync the caller cannot see would confirm a
      // foreign sync exists and leak its boards. A foreign id is a 404.
      if (!(await service.isVisible(connectionCaller(req), params.data.id))) {
        return reply.code(404).send({ error: 'Sync not found' });
      }
      const denial = await denySyncDetach(
        deps.prisma,
        'bitbucket',
        params.data.id,
        req.user?.id,
        deps.singleUser ?? false,
        req.log,
        req.membership ?? null,
      );
      if (denial) return reply.code(403).send({ error: denial.message, boardIds: denial.boardIds });
      const deleted = await service.delete(connectionCaller(req), params.data.id);
      if (!deleted) return reply.code(404).send({ error: 'Sync not found' });
      return reply.code(204).send();
    });

    app.post('/project-syncs/bitbucket/ensure', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
      const body = EnsureSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        const row = await service.ensure(
          connectionCaller(req),
          body.data.bitbucketInstanceId,
          body.data.repoFullName,
          body.data.projectKey,
        );
        return reply.code(200).send(row);
      } catch (err) {
        const { status, error } = mapError(err);
        return reply.code(status).send({ error });
      }
    });
  };
}
