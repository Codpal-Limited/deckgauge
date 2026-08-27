import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { z } from 'zod';
import { PutOrgTreeTimesheetConfigSchema } from '@deckgauge/shared';
import { OrgTreeTimesheetConfigService } from './org-tree-timesheet-config.service.js';
import { OrgTreeStatusPoolService } from './org-tree-status-pool.service.js';
import { orgTree } from '../auth/policy.js';

export interface OrgTreeTimesheetRoutesDeps {
  prisma: PrismaClient;
  clickhouse: ClickHouseClient;
}

const uuid = z.string().uuid();

export function orgTreeTimesheetRoutes(deps: OrgTreeTimesheetRoutesDeps): FastifyPluginAsync {
  const config = new OrgTreeTimesheetConfigService(deps.prisma);
  /**
   * Built per request from the scoped reader (tenancy §11 precondition 8). This
   * service has no cache of its own, so unlike TimesheetService it can simply be
   * constructed per request rather than needing a reader factory.
   * `deps.clickhouse` remains the fallback for callers that construct this plugin
   * without the chRead plugin registered, i.e. the unit tests.
   */
  const poolFor = (req: FastifyRequest) =>
    new OrgTreeStatusPoolService({
      prisma: deps.prisma,
      clickhouse: req.chRead ?? deps.clickhouse,
    });

  async function treeExists(id: string): Promise<boolean> {
    return (await deps.prisma.orgTree.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/org-trees/:id/timesheet-config', { config: { policy: orgTree('VIEWER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      if (!(await treeExists(req.params.id))) return reply.code(404).send({ error: 'not found' });
      return reply.send(await config.get(req.params.id));
    });

    app.put<{ Params: { id: string } }>('/org-trees/:id/timesheet-config', { config: { policy: orgTree('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const parsed = PutOrgTreeTimesheetConfigSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      if (!(await treeExists(req.params.id))) return reply.code(404).send({ error: 'not found' });
      return reply.send(
        await config.put(req.params.id, {
          activeStatuses: parsed.data.activeStatuses,
          dailyCapHours: parsed.data.dailyCapHours ?? null,
        }),
      );
    });

    app.get<{ Params: { id: string } }>('/org-trees/:id/timesheet-status-pool', { config: { policy: orgTree('VIEWER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      if (!(await treeExists(req.params.id))) return reply.code(404).send({ error: 'not found' });
      return reply.send(await poolFor(req).listForTree(req.params.id));
    });
  };
}
