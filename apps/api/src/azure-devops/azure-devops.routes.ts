import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { Queue } from 'bullmq';
import { z } from 'zod';
import {
  CreateAzureDevOpsInstanceInputSchema,
  UpdateAzureDevOpsInstanceInputSchema,
  manualSyncJobPayload,
} from '@deckgauge/shared';
import { AzureDevOpsService } from './azure-devops.service.js';
import { ORG_MEMBER, ORG_VIEWER } from '../auth/policy.js';
import { connectionCaller } from '../connections/connection-caller.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

  // ORG_MEMBER, not ORG_ADMIN: any member may manage THEIR OWN connections, and
  // the row-level predicate in the service is what decides whose. Loosening this
  // policy without that predicate would be a real regression — see
  // connections/connection-visibility.ts and connection-authz.test.ts.
export async function azureDevOpsRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new AzureDevOpsService(prisma);

  // GET /azure-devops/instances
  // ORG_MEMBER, not AUTHENTICATED: the read below is organization-scoped, and
  // AUTHENTICATED returns ALLOW before any membership is resolved — a
  // membership-less caller would reach `requireOrganizationId` and get a 500
  // instead of a scoped result.
  app.get('/azure-devops/instances', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const instances = await service.listInstances(connectionCaller(req));
    return reply.send(instances);
  });

  // POST /azure-devops/instances
  // ORG_ADMIN: a connection is organization property, so adding one is
  // organization administration. See connection-authz.test.ts.
  app.post('/azure-devops/instances', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const parsed = CreateAzureDevOpsInstanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const instance = await service.createInstance(connectionCaller(req), parsed.data, req.user?.id);
    return reply.status(201).send(instance);
  });

  // PATCH /azure-devops/instances/:id
  //
  // ORG_ADMIN replaces the per-row `connectionOwner` check. That gives up the
  // guard which withheld `orgUrl` on an unclaimed row — repointing the org while
  // keeping the stored PAT aims it at a server the caller controls. The boundary
  // that also matters is reaching ANOTHER tenant's connection, and that is the
  // service's tenant predicate below.
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
    '/azure-devops/instances/:id',
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const parsed = UpdateAzureDevOpsInstanceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const instance = await service.updateInstance(
        connectionCaller(req),
        req.params.id,
        parsed.data,
        req.user?.id,
        req.log,
      );
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });
      return reply.send(instance);
    },
  );

  // DELETE /azure-devops/instances/:id
  // Cascades to AzureDevOpsProjectSync → BoardAdoSource, wiping the ADO source
  // configuration of every board using it — which is why it is organization
  // administration, and why the service resolves the row through the caller's
  // organization before deleting it.
  app.delete<{ Params: { id: string } }>(
    '/azure-devops/instances/:id',
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const deleted = await service.deleteInstance(connectionCaller(req), req.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Instance not found' });
      return reply.status(204).send();
    },
  );

  // POST /azure-devops/instances/:id/test — verify credentials
  app.post<{ Params: { id: string } }>(
    '/azure-devops/instances/:id/test',
    // ORG_ADMIN, with the rest of connection management: an organization MEMBER
    // no longer tests connections.
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const instance = await service.getRawInstanceById(connectionCaller(req), req.params.id);
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });

      try {
        const { AzureDevOpsRestAdapter } = await import('@deckgauge/shared');
        const adapter = new AzureDevOpsRestAdapter({
          orgUrl: instance.orgUrl,
          authMethod: instance.authMethod as 'PAT' | 'BASIC',
          accessToken: instance.accessToken,
          username: instance.username ?? undefined,
        });
        const project = instance.projects[0];
        if (project) {
          await adapter.fetchWorkItemTypes(project);
        } else {
          const url = `${instance.orgUrl}/_apis/projects?$top=1&api-version=7.0`;
          const authHeader =
            instance.authMethod === 'PAT'
              ? `Basic ${Buffer.from(`:${instance.accessToken}`).toString('base64')}`
              : `Basic ${Buffer.from(`${instance.username}:${instance.accessToken}`).toString('base64')}`;
          const res = await fetch(url, {
            headers: { Authorization: authHeader },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
        return reply.send({ ok: true });
      } catch (err: unknown) {
        let message = 'Connection failed';
        if (err instanceof Error) message = err.message;
        return reply.status(422).send({ ok: false, error: message });
      }
    },
  );

  // POST /azure-devops/instances/:id/refresh-token — swap stored credential
  app.post<{ Params: { id: string } }>(
    '/azure-devops/instances/:id/refresh-token',
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

  // GET /azure-devops/instances/:id/project-syncs/:project/production-config
  // Which release pipelines / stages count as a PRODUCTION deploy for DORA
  // deploy frequency. Both lists empty = fall back to the name heuristic.
  //
  // ORG_ADMIN on the GET as well as the PUT below: both were `connectionOwner`,
  // and both are consumed only by the connections panel, so leaving the read
  // member-visible would only expose it on a screen no member can reach.
  app.get<{ Params: { id: string; project: string } }>(
    '/azure-devops/instances/:id/project-syncs/:project/production-config',
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const config = await service.getProductionConfig(
        connectionCaller(req),
        req.params.id,
        decodeURIComponent(req.params.project),
      );
      if (!config) return reply.status(404).send({ error: 'Project sync not found' });
      return reply.send(config);
    },
  );

  // PUT /azure-devops/instances/:id/project-syncs/:project/production-config
  app.put<{ Params: { id: string; project: string } }>(
    '/azure-devops/instances/:id/project-syncs/:project/production-config',
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const body = z
        .object({
          definitions: z.array(z.string()).default([]),
          stages: z.array(z.string()).default([]),
        })
        .safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
      const config = await service.setProductionConfig(
        connectionCaller(req),
        req.params.id,
        decodeURIComponent(req.params.project),
        body.data,
      );
      if (!config) return reply.status(404).send({ error: 'Project sync not found' });
      return reply.send(config);
    },
  );

  // GET /azure-devops/sync/status
  //
  // ORG_VIEWER, and the tenant boundary is the `where` in the service. See the
  // note on GET /github/sync/status for why both halves are needed and why the
  // no-membership arm below is unreachable through the policy plugin yet kept.
  //
  // ADO is the most revealing of the three sources: `errorMessage` carries the
  // team project name verbatim (`TF200016: The following project does not exist:
  // <name>`).
  app.get('/azure-devops/sync/status', { config: { policy: ORG_VIEWER } }, async (req, reply) => {
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

  // POST /azure-devops/sync — enqueue manual sync
  //
  // ORG_MEMBER, for the same reason as POST /github/sync: the job spends the
  // stored Azure DevOps credentials, and `authenticated` checked neither
  // membership nor tenancy. See sync-config-authz.test.ts.
  //
  // The payload carries the caller's organization, and that is the whole tenant
  // boundary of this route. Before 2026-08-27 it enqueued `{ trigger: 'manual' }`
  // with no scope, and the worker's handler loaded its connections with a bare
  // `findMany()` — so a MEMBER of one organization triggered a sync of EVERY
  // tenant's connections, spending their stored credentials and burning their
  // provider rate limit. `requireOrganizationId` is safe here precisely because
  // `ORG_MEMBER` guarantees the membership it reads.
  app.post('/azure-devops/sync', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const queue = new Queue('azure-devops-sync', { connection: { url: redisUrl } });
    try {
      // Built by the shared helper so every manual enqueue site emits one shape;
      // see `manualSyncJobPayload`'s note on why that is in @deckgauge/shared.
      await queue.add('sync', manualSyncJobPayload(requireOrganizationId(req)));
      return reply.status(202).send({ ok: true, message: 'Azure DevOps sync job enqueued' });
    } finally {
      await queue.close();
    }
  });

  // GET /azure-devops/instances/:id/projects — list real team projects
  app.get<{ Params: { id: string } }>(
    '/azure-devops/instances/:id/projects',
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const instance = await service.getRawInstanceById(connectionCaller(req), req.params.id);
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });

      try {
        const { AzureDevOpsRestAdapter } = await import('@deckgauge/shared');
        const adapter = new AzureDevOpsRestAdapter({
          orgUrl: instance.orgUrl,
          authMethod: instance.authMethod as 'PAT' | 'BASIC',
          accessToken: instance.accessToken,
          username: instance.username ?? undefined,
        });
        const projects = await adapter.listProjects();
        return reply.send({ projects });
      } catch (err: unknown) {
        let message = 'Unknown error';
        if (err instanceof Error) message = err.message;
        return reply.status(422).send({ error: message });
      }
    },
  );

  // GET /azure-devops/instances/:id/work-item-types?project=X
  app.get<{ Params: { id: string }; Querystring: { project?: string } }>(
    '/azure-devops/instances/:id/work-item-types',
    { config: { policy: ORG_MEMBER } },
    async (req, reply) => {
      const { project } = req.query;
      if (!project) {
        return reply.status(400).send({ error: 'project query param is required' });
      }

      const instance = await service.getRawInstanceById(connectionCaller(req), req.params.id);
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });

      try {
        const { AzureDevOpsRestAdapter } = await import('@deckgauge/shared');
        const adapter = new AzureDevOpsRestAdapter({
          orgUrl: instance.orgUrl,
          authMethod: instance.authMethod as 'PAT' | 'BASIC',
          accessToken: instance.accessToken,
          username: instance.username ?? undefined,
        });
        const types = await adapter.fetchWorkItemTypes(project);
        return reply.send({ types });
      } catch (err: unknown) {
        let message = 'Unknown error';
        if (err instanceof Error) message = err.message;
        return reply.status(422).send({ error: message });
      }
    },
  );
}
