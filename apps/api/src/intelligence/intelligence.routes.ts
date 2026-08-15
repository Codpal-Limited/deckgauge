// EI-019 — Intelligence Fastify routes plugin (per ENGINEERING-INTELLIGENCE.md §8).
// P1 — Every GET accepts an optional `?boardId=<uuid>` query param. When present,
// the route looks up the board, resolves its BoardScope, and forwards the scope
// to the service. When the board doesn't exist we return 404. When omitted, the
// route behaves exactly as before (global all-boards aggregate).
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { ClickhouseIntelligenceService } from './clickhouse-intelligence.service.js';
import { getBoardScope, type BoardScope } from './board-scope.js';
import { ANALYTICS, ADMIN } from '../auth/policy.js';

const DateRangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  boardId: z.string().uuid().optional(),
});

const BoardIdQuery = z.object({ boardId: z.string().uuid().optional() });

function defaultFrom(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

export interface IntelligenceRoutesDeps {
  service: ClickhouseIntelligenceService;
  /**
   * Prisma client used to resolve `?boardId=` query params to a BoardScope.
   * Optional so existing tests that construct the plugin with just `service`
   * keep working; when omitted, boardId is silently ignored.
   */
  prisma?: PrismaClient;
  // EI-022 — optional callback the API can use to enqueue a manual sync.
  // Wired in server.ts when the API process has access to the BullMQ queues.
  enqueueSync?: (source: 'jira' | 'github' | 'ado' | 'gitlab' | 'all') => Promise<void>;
}

export function intelligenceRoutes(deps: IntelligenceRoutesDeps) {
  return async function plugin(app: FastifyInstance) {
    const { service, prisma } = deps;

    /**
     * Resolves an optional `?boardId=` query param to a BoardScope.
     * Returns:
     *   - `null` when boardId was omitted → caller should run unscoped query
     *   - `{ notFound: true }` when boardId was given but no board exists
     *   - `{ scope }` on success
     */
    async function resolveScope(
      boardId: string | undefined,
    ): Promise<{ scope: BoardScope } | { notFound: true } | null> {
      if (!boardId) return null;
      if (!prisma) return null;
      const board = await prisma.board.findUnique({ where: { id: boardId } });
      if (!board) return { notFound: true };
      const scope = await getBoardScope(prisma, boardId);
      return { scope };
    }

    app.get('/intelligence/overview', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const parsed = DateRangeQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom();
      const to = parsed.data.to ? new Date(parsed.data.to) : new Date();

      const resolved = await resolveScope(parsed.data.boardId);
      if (resolved && 'notFound' in resolved) {
        return reply.code(404).send({ error: 'board not found' });
      }
      const scope = resolved && 'scope' in resolved ? resolved.scope : undefined;
      const data = await service.getTeamOverview(from, to, scope);
      return reply.send(data);
    });

    app.get('/intelligence/developers/:login/weekly', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const params = z.object({ login: z.string().min(1) }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const parsed = DateRangeQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom();
      const to = parsed.data.to ? new Date(parsed.data.to) : new Date();

      const resolved = await resolveScope(parsed.data.boardId);
      if (resolved && 'notFound' in resolved) {
        return reply.code(404).send({ error: 'board not found' });
      }
      const scope = resolved && 'scope' in resolved ? resolved.scope : undefined;
      const data = await service.getDeveloperWeeklyTimeSeries(
        params.data.login,
        from,
        to,
        scope,
      );
      return reply.send(data);
    });

    app.get('/intelligence/anomalies', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const parsed = z
        .object({
          threshold: z.coerce.number().lt(0).gt(-1).optional(),
          boardId: z.string().uuid().optional(),
        })
        .safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const resolved = await resolveScope(parsed.data.boardId);
      if (resolved && 'notFound' in resolved) {
        return reply.code(404).send({ error: 'board not found' });
      }
      const scope = resolved && 'scope' in resolved ? resolved.scope : undefined;
      const data = await service.detectSlowdownAnomalies(parsed.data.threshold ?? -0.4, scope);
      return reply.send(data);
    });

    app.get('/intelligence/ai-breakdown', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const parsed = DateRangeQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom();

      const resolved = await resolveScope(parsed.data.boardId);
      if (resolved && 'notFound' in resolved) {
        return reply.code(404).send({ error: 'board not found' });
      }
      const scope = resolved && 'scope' in resolved ? resolved.scope : undefined;
      const data = await service.getAiBreakdownByDeveloper(from, scope);
      return reply.send(data);
    });

    app.get('/intelligence/coverage', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const parsed = DateRangeQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom();

      const resolved = await resolveScope(parsed.data.boardId);
      if (resolved && 'notFound' in resolved) {
        return reply.code(404).send({ error: 'board not found' });
      }
      const scope = resolved && 'scope' in resolved ? resolved.scope : undefined;
      const data = await service.getTicketCoverage(from, scope);
      return reply.send(data);
    });

    // EI-021 — unified ticket timeline.
    app.get('/intelligence/tickets/:key', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const params = z.object({ key: z.string().min(1) }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const parsed = BoardIdQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const resolved = await resolveScope(parsed.data.boardId);
      if (resolved && 'notFound' in resolved) {
        return reply.code(404).send({ error: 'board not found' });
      }
      const scope = resolved && 'scope' in resolved ? resolved.scope : undefined;
      const data = await service.getTicketTimeline(params.data.key, scope);
      return reply.send(data);
    });

    // P2 — developer table (one row per dev, last 12 weeks default).
    app.get('/intelligence/developer-table', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const parsed = DateRangeQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
      const from = parsed.data.from
        ? new Date(parsed.data.from)
        : new Date(to.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);
      const data = await service.getDeveloperTable(from, to);
      return reply.send(data);
    });

    // P2 — developer detail (heatmap, recent PRs, AI trend) over N days.
    app.get('/intelligence/developers/:login/detail', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const params = z.object({ login: z.string().min(1) }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const q = z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).safeParse(
        req.query,
      );
      if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
      const data = await service.getDeveloperDetail(params.data.login, q.data.days ?? 90);
      return reply.send(data);
    });

    // P2 — paginated pull-request list.
    app.get('/intelligence/pull-requests', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const parsed = DateRangeQuery.extend({
        page: z.coerce.number().int().min(1).optional(),
        perPage: z.coerce.number().int().min(1).max(200).optional(),
      }).safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
      const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom();
      const data = await service.getPullRequestList({
        from,
        to,
        page: parsed.data.page ?? 1,
        perPage: parsed.data.perPage ?? 50,
      });
      return reply.send(data);
    });

    // P2 — weekly AI% trend.
    app.get('/intelligence/ai-trend', { config: { policy: ANALYTICS } }, async (req, reply) => {
      const parsed = DateRangeQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
      const from = parsed.data.from
        ? new Date(parsed.data.from)
        : new Date(to.getTime() - 12 * 7 * 24 * 60 * 60 * 1000);
      const data = await service.getAiWeeklyTrend(from, to);
      return reply.send(data);
    });

    // EI-022 — manual sync trigger. Accepts source: 'jira' | 'github' | 'ado' | 'gitlab' | 'all'.
    // The route enqueues a job onto the corresponding BullMQ queue via a dependency-injected
    // enqueue callback. If no enqueue function was provided to intelligenceRoutes, returns 503
    // so the caller knows the worker bus isn't reachable from this API process.
    app.post('/intelligence/sync', { config: { policy: ADMIN } }, async (req, reply) => {
      const body = z
        .object({ source: z.enum(['jira', 'github', 'ado', 'gitlab', 'all']) })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      if (!deps.enqueueSync) {
        return reply
          .code(503)
          .send({ error: 'manual sync enqueue not configured on this server' });
      }
      await deps.enqueueSync(body.data.source);
      return reply.code(202).send({ accepted: body.data.source });
    });
  };
}
