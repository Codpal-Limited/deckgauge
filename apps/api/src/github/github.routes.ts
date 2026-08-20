import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { Queue } from 'bullmq';
import { z } from 'zod';
import {
  CreateGitHubInstanceInputSchema,
  UpdateGitHubInstanceInputSchema,
  GitHubProjectsAuthError,
} from '@deckgauge/shared';
import { GitHubService } from './github.service.js';
import { AUTHENTICATED, ORG_ADMIN, ORG_MEMBER } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

export async function githubRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new GitHubService(prisma);

  // GET /github/instances — list (tokens masked)
  // ORG_MEMBER, not AUTHENTICATED: the read below is organization-scoped, and
  // AUTHENTICATED returns ALLOW before any membership is resolved — a
  // membership-less caller would reach `requireOrganizationId` and get a 500
  // instead of a scoped result.
  app.get('/github/instances', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const instances = await service.listInstances(requireOrganizationId(req));
    return reply.send(instances);
  });

  // POST /github/instances — create.
  // ORG_ADMIN: a connection is organization property, so adding one is
  // organization administration. See connection-authz.test.ts.
  app.post('/github/instances', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
    const parsed = CreateGitHubInstanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const instance = await service.createInstance(requireOrganizationId(req), parsed.data, req.user?.id);
    return reply.status(201).send(instance);
  });

  // PATCH /github/instances/:id — replace the access token, and/or update the repos list
  //
  // ORG_ADMIN replaces the per-row `connectionOwner` check. That gives up the
  // guard which withheld `baseUrl` on an unclaimed row — repointing the host
  // while keeping the stored token aims it at a server the caller controls. The
  // boundary that also matters is reaching ANOTHER tenant's connection, and both
  // branches below carry the tenant predicate for that.
  // Repointing is recorded. The claim that used to sit here — that an
  // organization admin "can already read and replace that credential, so
  // repointing gains them nothing" — is right about replacing and wrong about
  // reading: every response masks the token (`accessToken: '***'`), so an admin
  // cannot read it. Repointing the host while keeping the stored credential makes
  // the next sync send that credential, in the clear, to whatever host was named
  // — a capability an admin does not otherwise have. It stays allowed, because
  // moving a connection to a new host is legitimate; it no longer happens
  // silently. See connections/host-repoint-audit.ts.
  app.patch<{ Params: { id: string } }>(
    '/github/instances/:id',
    { config: { policy: ORG_ADMIN } },
    async (req, reply) => {
      const parsed = UpdateGitHubInstanceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { repos, accessToken, baseUrl } = parsed.data;
      // Token replacement takes precedence — the recovery path for an expired PAT.
      if (accessToken !== undefined) {
        const instance = await service.updateInstanceToken(
          requireOrganizationId(req),
          req.params.id,
          { accessToken, baseUrl },
          req.user?.id,
          req.log,
        );
        if (!instance) return reply.status(404).send({ error: 'Instance not found' });
        return reply.send(instance);
      }
      if (repos === undefined) {
        return reply.status(400).send({ error: 'repos or accessToken field is required' });
      }
      const instance = await service.updateInstanceRepos(
        requireOrganizationId(req),
        req.params.id,
        repos,
        req.user?.id,
      );
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });
      return reply.send(instance);
    },
  );

  // DELETE /github/instances/:id
  // Cascades to GitHubRepoSync → BoardGitHubSource, wiping the GitHub source
  // configuration of every board using it — which is why it is organization
  // administration, and why the service resolves the row through the caller's
  // organization before deleting it.
  app.delete<{ Params: { id: string } }>(
    '/github/instances/:id',
    { config: { policy: ORG_ADMIN } },
    async (req, reply) => {
      const deleted = await service.deleteInstance(requireOrganizationId(req), req.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Instance not found' });
      return reply.status(204).send();
    },
  );

  // POST /github/instances/:id/test — test PAT
  app.post<{ Params: { id: string } }>(
    '/github/instances/:id/test',
    // ORG_ADMIN, with the rest of connection management: an organization MEMBER
    // no longer tests connections.
    { config: { policy: ORG_ADMIN } },
    async (req, reply) => {
      const organizationId = requireOrganizationId(req);
      const instance = await service.getRawInstanceById(organizationId, req.params.id);
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });

      const result = await service.testConnection(organizationId, req.params.id);
      if (!result.ok) {
        return reply.status(422).send(result);
      }
      return reply.send(result);
    },
  );

  // POST /github/instances/:id/refresh-token — validate a new PAT, swap on success
  app.post<{ Params: { id: string } }>(
    '/github/instances/:id/refresh-token',
    { config: { policy: ORG_ADMIN } },
    async (req, reply) => {
      const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
      const result = await service.refreshToken(
        requireOrganizationId(req),
        req.params.id,
        body.data.token,
        fetch,
        req.user?.id,
      );
      if (result.notFound) return reply.status(404).send({ error: 'Instance not found' });
      if (!result.ok) return reply.status(422).send({ ok: false, error: result.error });
      return reply.send({ ok: true });
    },
  );

  // POST /github/instances/:id/repos — discover accessible repos for the PAT
  app.post<{ Params: { id: string } }>(
    '/github/instances/:id/repos',
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const organizationId = requireOrganizationId(req);
      const instance = await service.getRawInstanceById(organizationId, req.params.id);
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });

      try {
        const repos = await service.discoverRepos(organizationId, req.params.id);
        return reply.send({ repos });
      } catch (err: unknown) {
        let message = 'Unknown error';
        if (err instanceof Error) message = err.message;
        return reply.status(422).send({ error: message });
      }
    },
  );

  // GET /github/instances/:id/projects — list accessible GitHub Projects v2
  app.get<{ Params: { id: string } }>(
    '/github/instances/:id/projects',
    { config: { policy: ORG_MEMBER } },
    async (request, reply) => {
      try {
        const projects = await service.listProjectsForInstance(
          requireOrganizationId(request),
          request.params.id,
        );
        return projects;
      } catch (err) {
        if (err instanceof GitHubProjectsAuthError) {
          reply.code(502);
          return { error: 'GitHub token lacks read:project scope. Regenerate it with that scope.' };
        }
        if (err instanceof Error && /not found/i.test(err.message)) {
          reply.code(404);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  // GET /github/sync/status
  app.get('/github/sync/status', { config: { policy: AUTHENTICATED } }, async (_req, reply) => {
    const result = await service.getLastSyncRun();
    if (!result) {
      return reply.send({ status: 'NEVER', finishedAt: null });
    }
    return reply.send(result);
  });

  // POST /github/sync — enqueue full sync, returns 202
  //
  // ORG_MEMBER, not AUTHENTICATED: enqueuing this job makes the worker call
  // GitHub with every stored credential it can reach, so `authenticated` — which
  // resolves no membership and no tenant — gated a credential-spending capability
  // on nothing beyond holding an account. MEMBER rather than ADMIN because the
  // button that calls it is on the board screen (GitHubGroupSection's "Sync"),
  // refreshing boards a member configured; that matches the rest of the
  // credential-spending family (see sync-config-authz.test.ts) and the scoped
  // per-board equivalent, POST /boards/:boardId/sync = board(EDITOR).
  app.post('/github/sync', { config: { policy: ORG_MEMBER } }, async (_req, reply) => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const queue = new Queue('github-sync', { connection: { url: redisUrl } });
    try {
      await queue.add('sync', { trigger: 'manual' });
      return reply.status(202).send({ ok: true, message: 'GitHub sync job enqueued' });
    } finally {
      await queue.close();
    }
  });

}
