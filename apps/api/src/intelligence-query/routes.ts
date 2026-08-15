import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import type { ClickHouseClient } from '@clickhouse/client';
import { z } from 'zod';
import { requireBoardAccess } from '../board-access/board-access.middleware.js';
import { buildSchemaPayload } from './schema.service.js';
import { intelligenceQueryBuilders } from './builders/index.js';
import { getWidgetBoardScope } from '../widgets/widget-board-scope.js';
import { applyDrillFilter, drillDimensionsFor } from './drill.js';
import { interpolateChParams } from './sql-params.js';
import { executeUserSql, ConsoleError } from './scope/execute.js';
import { resolveScope } from './scope/resolve-scope.js';
import { getConsoleClickhouse } from './scope/console-clickhouse.js';
import { board } from '../auth/policy.js';

export async function intelligenceQueryRoutes(
  app: FastifyInstance,
  { prisma, getCh }: { prisma: PrismaClient; getCh?: () => ClickHouseClient }
) {
  const resolveCh = getCh ?? getConsoleClickhouse;
  // GET /boards/:boardId/intelligence/schema — column catalog + source-id
  // allowlists for the tables this board can query. Source-types missing from
  // the board map to zero tables, so an unconfigured board returns
  // { tables: [], scope: { repos: [], ... } }.
  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/intelligence/schema',
    { config: { policy: board('VIEWER') }, preHandler: [requireBoardAccess(prisma, 'VIEWER')] },
    async (req, reply) => {
      const payload = await buildSchemaPayload(prisma, req.params.boardId);
      return reply.code(200).send(payload);
    }
  );

  // GET /boards/:boardId/intelligence/sql — renders the SQL a widget's builder
  // would execute, with ClickHouse parameter markers (`{name:Type}`) replaced
  // by safe interpolated literals so the editor can show ready-to-run SQL and
  // `/execute` (which doesn't forward params) can submit it as-is.
  //
  // With ?filter=<dimension>:<value>, an `<column> = '<value>'` predicate is
  // injected into the outermost SELECT's WHERE clause. The earlier
  // `SELECT * FROM (<sql>) WHERE col = 'val'` wrap produced
  // `SELECT * FROM (WITH cte AS (...) SELECT ...)`, which the postgres-dialect
  // parser used by scope/validate.ts split into multiple ASTs and rejected as
  // MULTI_STATEMENT before the query reached ClickHouse.
  app.get<{
    Params: { boardId: string };
    Querystring: { widget?: string; config?: string; filter?: string };
  }>(
    '/boards/:boardId/intelligence/sql',
    { config: { policy: board('VIEWER') }, preHandler: [requireBoardAccess(prisma, 'VIEWER')] },
    async (req, reply) => {
      const { widget, config: cfgB64, filter } = req.query;

      if (!widget) {
        return reply.code(400).send({ error: 'widget query param required' });
      }
      const builder = intelligenceQueryBuilders[widget];
      if (!builder) {
        return reply.code(404).send({ error: 'unknown widget type' });
      }

      // base64url-decoded JSON config; default to {} when omitted. We do NOT
      // validate the inner shape here — each builder owns its own config schema
      // and produces null when inputs are insufficient.
      let config: Record<string, unknown> = {};
      if (cfgB64) {
        try {
          config = JSON.parse(Buffer.from(cfgB64, 'base64url').toString('utf8'));
        } catch {
          return reply.code(400).send({ error: 'config must be base64url-encoded JSON' });
        }
      }

      const scope = await getWidgetBoardScope(prisma, req.params.boardId);
      const built = builder({ config, scope });

      // null = builder cannot produce SQL (e.g. no PR source on this board).
      // Return a clear no-op SQL with empty params; the editor will display it.
      if (built === null) {
        return reply.code(200).send({
          sql: '-- this widget has no data for the current board scope',
          params: {},
        });
      }

      let finalSql = built.sql;
      if (filter) {
        const sep = filter.indexOf(':');
        if (sep === -1) {
          return reply.code(400).send({ error: "filter must be '<dimension>:<value>'" });
        }
        const dimension = filter.slice(0, sep);
        const value = filter.slice(sep + 1);
        const dims = drillDimensionsFor(widget);
        const column = dims[dimension];
        if (!column) {
          return reply.code(400).send({ error: `Unknown dimension: ${dimension}` });
        }
        finalSql = applyDrillFilter(built.sql, column, value);
      }

      try {
        finalSql = interpolateChParams(finalSql, built.params);
      } catch (e) {
        // Misconfigured builder params — surface as 500 rather than emit
        // SQL the user could not execute.
        req.log.error({ evt: 'intelligence_sql_interpolation_failed', widget, err: e });
        return reply.code(500).send({
          error: 'Failed to render widget SQL — please file a bug report',
        });
      }

      // `params` returned for backward compatibility with web clients that
      // still expect the field. Always `{}` now — values are baked into `sql`.
      return reply.code(200).send({ sql: finalSql, params: {} });
    }
  );

  // POST /boards/:boardId/intelligence/execute — runs user-supplied SELECT
  // through the scoped console executor. Pipeline: parse → validate → rewrite
  // → assert → execute. ConsoleError instances surface as 400/500 with a
  // structured error code; raw ClickHouse-driver failures are mapped to 504
  // (timeout) or 502 (other) without leaking driver internals.
  const executeBodySchema = z.object({
    sql: z.string().min(1).max(50_000),
  });

  app.post<{ Params: { boardId: string } }>(
    '/boards/:boardId/intelligence/execute',
    { config: { policy: board('VIEWER') }, preHandler: [requireBoardAccess(prisma, 'VIEWER')] },
    async (req, reply) => {
      const { boardId } = req.params;

      const parsed = executeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message, code: 'BAD_BODY' });
      }
      const { sql } = parsed.data;

      const scope = await resolveScope(prisma, boardId);

      try {
        const result = await executeUserSql(sql, scope, resolveCh());
        req.log.info({
          evt: 'intelligence_query',
          boardId,
          decision: 'allowed',
          ms: result.ms,
          rows: result.rows.length,
          truncated: result.truncated,
        });
        return reply.code(200).send(result);
      } catch (e) {
        if (e instanceof ConsoleError) {
          req.log.info({
            evt: 'intelligence_query',
            boardId,
            decision: 'rejected',
            code: e.code,
            status: e.status,
          });
          return reply.code(e.status).send({ error: e.message, code: e.code });
        }
        // ClickHouse-side failure (timeout, connection refused, etc.).
        // Don't leak driver internals to the client.
        const msg = e instanceof Error ? e.message : String(e);
        const isTimeout = /timeout|TIMEOUT_EXCEEDED|max_execution_time/i.test(msg);
        const status = isTimeout ? 504 : 502;
        req.log.warn({
          evt: 'intelligence_query',
          boardId,
          decision: 'error',
          status,
          message: msg,
        });
        return reply.code(status).send({
          error: isTimeout ? 'Query timed out' : 'Query execution failed',
          code: isTimeout ? 'TIMEOUT' : 'CH_ERROR',
        });
      }
    }
  );
}
