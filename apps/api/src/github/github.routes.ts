import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { Queue } from 'bullmq';
import { z } from 'zod';
import {
  CreateGitHubInstanceInputSchema,
  UpdateGitHubInstanceInputSchema,
  GitHubProjectsAuthError,
  manualSyncJobPayload,
} from '@deckgauge/shared';
import { GitHubService } from './github.service.js';
import { ORG_MEMBER, ORG_VIEWER } from '../auth/policy.js';
import { connectionCaller } from '../connections/connection-caller.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

  // ORG_MEMBER, not ORG_ADMIN: any member may manage THEIR OWN connections, and
  // the row-level predicate in the service is what decides whose. Loosening this
  // policy without that predicate would be a real regression — see
  // connections/connection-visibility.ts and connection-authz.test.ts.
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
    const instances = await service.listInstances(connectionCaller(req));
    return reply.send(instances);
  });

  // POST /github/instances — create.
  // ORG_ADMIN: a connection is organization property, so adding one is
  // organization administration. See connection-authz.test.ts.
  app.post('/github/instances', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const parsed = CreateGitHubInstanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const instance = await service.createInstance(connectionCaller(req), parsed.data, req.user?.id);
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
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const parsed = UpdateGitHubInstanceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { repos, accessToken, baseUrl } = parsed.data;
      // Token replacement takes precedence — the recovery path for an expired PAT.
      if (accessToken !== undefined) {
        const instance = await service.updateInstanceToken(
          connectionCaller(req),
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
      // No acting user: this path no longer records one. `createdById` is stamped
      // at creation and never touched by an edit, since claim-on-first-edit went.
      const instance = await service.updateInstanceRepos(
        connectionCaller(req),
        req.params.id,
        repos,
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
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const deleted = await service.deleteInstance(connectionCaller(req), req.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Instance not found' });
      return reply.status(204).send();
    },
  );

  // POST /github/instances/:id/test — test PAT
  app.post<{ Params: { id: string } }>(
    '/github/instances/:id/test',
    // ORG_ADMIN, with the rest of connection management: an organization MEMBER
    // no longer tests connections.
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const caller = connectionCaller(req);
      const instance = await service.getRawInstanceById(caller, req.params.id);
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });

      const result = await service.testConnection(caller, req.params.id);
      if (!result.ok) {
        return reply.status(422).send(result);
      }
      return reply.send(result);
    },
  );

  // POST /github/instances/:id/refresh-token — validate a new PAT, swap on success
  app.post<{ Params: { id: string } }>(
    '/github/instances/:id/refresh-token',
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
      const result = await service.refreshToken(
        connectionCaller(req),
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
      const caller = connectionCaller(req);
      const instance = await service.getRawInstanceById(caller, req.params.id);
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });

      try {
        const repos = await service.discoverRepos(caller, req.params.id);
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
          connectionCaller(request),
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
  //
  // ORG_VIEWER, and the tenant boundary is the `where` in the service. Both
  // halves are load-bearing and neither replaces the other.
  //
  // The `where` is what stops the leak. This route returns a whole `SyncRun`
  // row, `errorMessage` included, which is written verbatim from the provider
  // failure and routinely names a repository, a host or a connection. Until
  // `SyncRun` gained `organizationId` the read was `findFirst({ where: { source } })`
  // — the DEPLOYMENT's newest run — and no policy floor could have narrowed it,
  // because a floor narrows WHO may call, not WHAT they see.
  //
  // The floor is the invariant this route is held to: a tenant-scoped read takes
  // ORG_VIEWER. That is `policy.ts`'s stated rule for the shape, and it is what
  // removes the caller this route was actually open to — a token holder with no
  // membership at all, which `authenticated` admits by definition.
  //
  // VIEWER, not MEMBER, deliberately, and it is the ONLY route in either file that
  // is not ORG_MEMBER — the other twenty either write, or read connection
  // configuration (hosts, PATs' metadata, project and repo inventories). This one
  // only reads, and what it reads is now confined to the caller's own tenant. VIEWER
  // exists to be read-only, and the response is rendered on the board itself, by
  // GitHubGroupSection via BoardView.tsx, which a VIEWER can see — gating it on
  // MEMBER would blank that panel for the role whose whole purpose is reading.
  //
  // The no-membership arm below is therefore unreachable through the policy
  // plugin and kept as belt-and-braces. It is not dead: the route-level tests
  // register this plugin on a bare Fastify with no policy plugin, so they reach
  // it, and it is what keeps `getLastSyncRun`'s tenant argument a required
  // non-null string — a future caller cannot reach the query without a tenant.
  app.get('/github/sync/status', { config: { policy: ORG_VIEWER } }, async (req, reply) => {
    const organizationId = req.membership?.organizationId ?? null;
    if (!organizationId) {
      return reply.send({ status: 'NEVER', finishedAt: null });
    }
    const result = await service.getLastSyncRun(organizationId);
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
  //
  // The payload carries the caller's organization, and that is the whole tenant
  // boundary of this route. Before 2026-08-27 it enqueued `{ trigger: 'manual' }`
  // with no scope, and the worker's handler loaded its connections with a bare
  // `findMany()` — so a MEMBER of one organization triggered a sync of EVERY
  // tenant's connections, spending their stored credentials and burning their
  // provider rate limit. `requireOrganizationId` is safe here precisely because
  // `ORG_MEMBER` guarantees the membership it reads.
  app.post('/github/sync', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const queue = new Queue('github-sync', { connection: { url: redisUrl } });
    try {
      // Built by the shared helper so every manual enqueue site emits one shape;
      // see `manualSyncJobPayload`'s note on why that is in @deckgauge/shared.
      await queue.add('sync', manualSyncJobPayload(requireOrganizationId(req)));
      return reply.status(202).send({ ok: true, message: 'GitHub sync job enqueued' });
    } finally {
      await queue.close();
    }
  });

}
