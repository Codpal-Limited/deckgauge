import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { z } from 'zod';
import { PutOrgTreeStatusBucketsSchema, PutOrgTreeTimesheetConfigSchema } from '@deckgauge/shared';
import { OrgTreeTimesheetConfigService } from './org-tree-timesheet-config.service.js';
import { OrgTreeStatusPoolService } from './org-tree-status-pool.service.js';
import { OrgTreeStatusBucketService } from './org-tree-status-bucket.service.js';
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

  /**
   * The write side, built on the SAME per-request reader as `poolFor` and given
   * that pool as its read half.
   *
   * Sharing the pool instance is the point rather than an economy: `save`
   * derives `activeStatuses` by asking the pool what the statuses mean after
   * writing, so handing it this request's scoped pool is what guarantees the
   * list it caches was computed under the same row policies the GET will use.
   */
  const bucketsFor = (req: FastifyRequest) => {
    const clickhouse = req.chRead ?? deps.clickhouse;
    return new OrgTreeStatusBucketService({
      prisma: deps.prisma,
      clickhouse,
      pool: new OrgTreeStatusPoolService({ prisma: deps.prisma, clickhouse }),
    });
  };

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
      // Passed through as a PARTIAL. An earlier version named both fields
      // unconditionally and coerced an absent cap to `null`, which reset a
      // configured cap to the 8h engine default on every status save.
      const saved = await config.put(req.params.id, parsed.data);
      // `null` means a cap-only save found no row to update, and creating one
      // would silently switch the tree to "count nothing" — see `put`. 409
      // rather than 404: the TREE exists, its time rules do not.
      if (saved === null) {
        return reply
          .code(409)
          .send({ error: 'set Time rules for this team before setting a daily cap' });
      }
      return reply.send(saved);
    });

    app.get<{ Params: { id: string } }>('/org-trees/:id/timesheet-status-pool', { config: { policy: orgTree('VIEWER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      if (!(await treeExists(req.params.id))) return reply.code(404).send({ error: 'not found' });
      return reply.send(await poolFor(req).listForTree(req.params.id));
    });

    /**
     * Save what each status MEANS, and answer with the statuses that now count.
     *
     * EDITOR, like the config PUT it supersedes: this decides which hours land
     * on which engineer's timesheet, so it is not a viewer's call.
     *
     * The response is the DERIVED `activeStatuses`, not an echo of the request.
     * The client renders the same list the timesheet will read on its next
     * request instead of recomputing it from the decisions a second way — one
     * definition of "in progress", which is the constraint the whole slice is
     * built around.
     */
    app.put<{ Params: { id: string } }>('/org-trees/:id/timesheet-status-buckets', { config: { policy: orgTree('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: 'bad id' });
      const parsed = PutOrgTreeStatusBucketsSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      // Checked here as well as in the service, and the two are not redundant:
      // this one turns a missing tree into a 404 for the operator, while the
      // service THROWS so that no other caller can write unattributed rows.
      if (!(await treeExists(req.params.id))) return reply.code(404).send({ error: 'not found' });
      return reply.send({
        activeStatuses: await bucketsFor(req).save(req.params.id, parsed.data.decisions),
      });
    });
  };
}
