import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { Queue } from 'bullmq';
import { z } from 'zod';
import {
  CreateAzureDevOpsInstanceInputSchema,
  UpdateAzureDevOpsInstanceInputSchema,
} from '@deckgauge/shared';
import { AzureDevOpsService } from './azure-devops.service.js';
import {
  AUTHENTICATED,
  CONNECTION_OWNER,
  CONNECTION_OWNER_CLAIMED,
  connectionOwnerProtectingFields,
} from '../auth/policy.js';

export async function azureDevOpsRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new AzureDevOpsService(prisma);

  // GET /azure-devops/instances
  app.get('/azure-devops/instances', { config: { policy: AUTHENTICATED } }, async (_req, reply) => {
    const instances = await service.listInstances();
    return reply.send(instances);
  });

  // POST /azure-devops/instances
  app.post('/azure-devops/instances', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const parsed = CreateAzureDevOpsInstanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const instance = await service.createInstance(parsed.data, req.user?.id);
    return reply.status(201).send(instance);
  });

  // PATCH /azure-devops/instances/:id
  // `orgUrl` is withheld while the row is unclaimed — repointing the org while
  // keeping the stored PAT aims it at an attacker's server. Claim the row with
  // any other edit first; see UnclaimedGuard in auth/policy.ts.
  app.patch<{ Params: { id: string } }>(
    '/azure-devops/instances/:id',
    {
      config: {
        policy: connectionOwnerProtectingFields(['orgUrl']),
        connectionModel: 'azureDevOpsInstance',
      },
    },
    async (req, reply) => {
      const parsed = UpdateAzureDevOpsInstanceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const instance = await service.updateInstance(req.params.id, parsed.data, req.user?.id);
      if (!instance) return reply.status(404).send({ error: 'Instance not found' });
      return reply.send(instance);
    },
  );

  // DELETE /azure-devops/instances/:id
  // Cascades to AzureDevOpsProjectSync → BoardAdoSource, wiping the ADO source
  // configuration of every board using it — unclaimed rows must be claimed by
  // a non-destructive edit first.
  app.delete<{ Params: { id: string } }>(
    '/azure-devops/instances/:id',
    { config: { policy: CONNECTION_OWNER_CLAIMED, connectionModel: 'azureDevOpsInstance' } },
    async (req, reply) => {
      const deleted = await service.deleteInstance(req.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Instance not found' });
      return reply.status(204).send();
    },
  );

  // POST /azure-devops/instances/:id/test — verify credentials
  app.post<{ Params: { id: string } }>(
    '/azure-devops/instances/:id/test',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const instance = await service.getRawInstanceById(req.params.id);
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
    { config: { policy: CONNECTION_OWNER, connectionModel: 'azureDevOpsInstance' } },
    async (req, reply) => {
      const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
      const result = await service.refreshToken(req.params.id, body.data.token, fetch, req.user?.id);
      if (result.notFound) return reply.status(404).send({ error: 'Instance not found' });
      if (!result.ok) return reply.status(422).send({ ok: false, error: result.error });
      return reply.send({ ok: true });
    },
  );

  // GET /azure-devops/instances/:id/project-syncs/:project/production-config
  // Which release pipelines / stages count as a PRODUCTION deploy for DORA
  // deploy frequency. Both lists empty = fall back to the name heuristic.
  app.get<{ Params: { id: string; project: string } }>(
    '/azure-devops/instances/:id/project-syncs/:project/production-config',
    { config: { policy: CONNECTION_OWNER, connectionModel: 'azureDevOpsInstance' } },
    async (req, reply) => {
      const config = await service.getProductionConfig(
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
    { config: { policy: CONNECTION_OWNER, connectionModel: 'azureDevOpsInstance' } },
    async (req, reply) => {
      const body = z
        .object({
          definitions: z.array(z.string()).default([]),
          stages: z.array(z.string()).default([]),
        })
        .safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
      const config = await service.setProductionConfig(
        req.params.id,
        decodeURIComponent(req.params.project),
        body.data,
      );
      if (!config) return reply.status(404).send({ error: 'Project sync not found' });
      return reply.send(config);
    },
  );

  // GET /azure-devops/sync/status
  app.get('/azure-devops/sync/status', { config: { policy: AUTHENTICATED } }, async (_req, reply) => {
    const result = await service.getLastSyncRun();
    if (!result) {
      return reply.send({ status: 'NEVER', finishedAt: null });
    }
    return reply.send(result);
  });

  // POST /azure-devops/sync — enqueue manual sync
  app.post('/azure-devops/sync', { config: { policy: AUTHENTICATED } }, async (_req, reply) => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const queue = new Queue('azure-devops-sync', { connection: { url: redisUrl } });
    try {
      await queue.add('sync', { trigger: 'manual' });
      return reply.status(202).send({ ok: true, message: 'Azure DevOps sync job enqueued' });
    } finally {
      await queue.close();
    }
  });

  // GET /azure-devops/instances/:id/projects — list real team projects
  app.get<{ Params: { id: string } }>(
    '/azure-devops/instances/:id/projects',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const instance = await service.getRawInstanceById(req.params.id);
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
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const { project } = req.query;
      if (!project) {
        return reply.status(400).send({ error: 'project query param is required' });
      }

      const instance = await service.getRawInstanceById(req.params.id);
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
