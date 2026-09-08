import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import type { ClickHouseClient } from '@clickhouse/client';
import { z } from 'zod';
import { buildSchemaPayload } from './schema.service.js';
import { intelligenceQueryBuilders } from './builders/index.js';
import { getWidgetBoardScope } from '../widgets/widget-board-scope.js';
import { applyDrillFilter, drillDimensionsFor } from './drill.js';
import { interpolateChParams } from './sql-params.js';
import { executeUserSql, ConsoleError } from './scope/execute.js';
import { resolveScope } from './scope/resolve-scope.js';
import { getConsoleClickhouse } from './scope/console-clickhouse.js';
import { ADMIN } from '../auth/policy.js';

/**
 * Task 13 — every route below is gated on `ADMIN`, not a board role, and this
 * is a MITIGATION, not a fix.
 *
 * The console enforces board scope by rewriting user SQL and asserting over
 * an AST, and that approach has produced THREE distinct privilege-escalation
 * bypasses in one review session:
 *
 *   1. a value-blind disjunction recogniser plus an unparenthesised user
 *      `WHERE` (introduced and fixed within this branch);
 *   2. non-`FROM` subqueries invisible to `collectTableRefs` (pre-existing,
 *      fixed in this branch);
 *   3. `ARRAY JOIN` clause text excised before parsing and re-spliced
 *      verbatim afterwards — pre-existing and OPEN. Verified on a board with
 *      ZERO Jira scope: `SELECT * FROM github_pull_requests ARRAY JOIN
 *      (SELECT groupArray(key) FROM jira_issues) AS leaked_keys` returns
 *      every Jira key in the cluster, because `collectTableRefs` never sees
 *      the `ARRAY JOIN` clause at all.
 *
 * Each fix revealed a new place for a table reference to hide — the
 * `systematic-debugging` pattern for "this is an architecture problem, not
 * three bugs." The real fix already exists in this repo and is not wired up
 * here: `packages/db/src/ch-row-policies.ts` (+ `ch-read-scope.ts`) implement
 * per-organization ClickHouse row policies. The console runs as the
 * `deckgauge_console` ClickHouse user with no policy attached; once that
 * identity carries per-board row policies, the DATABASE enforces scope and no
 * SQL a user writes can exceed what the identity may read — the whole bypass
 * class stops mattering. That is its own slice, with its own spec and staging
 * verification.
 *
 * Until it lands, these routes require `ADMIN` — `ctx.isAdmin`, the
 * instance-wide admin flag — rather than any board role. Do NOT lower this
 * back to `board('VIEWER')` (or any board role, including OWNER) as a
 * usability fix: see the "Task 13" describe block in routes.test.ts, which
 * asserts a board VIEWER and a board OWNER who is not an instance admin both
 * get 403, and exists specifically to fail if this is reverted before the
 * row-policy work lands.
 */
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
    { config: { policy: ADMIN } },
    async (req, reply) => {
      const payload = await buildSchemaPayload(
        prisma,
        req.params.boardId,
        req.membership?.organizationId ?? null,
        // The getter, not a client: this route never reads the narrowing maps,
        // so on a board with no ADO area paths no ClickHouse client is built.
        resolveCh,
      );
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
    { config: { policy: ADMIN } },
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

      const scope = await getWidgetBoardScope(
        prisma,
        req.params.boardId,
        req.membership?.organizationId ?? null,
      );
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
    { config: { policy: ADMIN } },
    async (req, reply) => {
      const { boardId } = req.params;

      const parsed = executeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message, code: 'BAD_BODY' });
      }
      const { sql } = parsed.data;

      const scope = await resolveScope(
        prisma,
        boardId,
        req.membership?.organizationId ?? null,
        resolveCh,
      );

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
