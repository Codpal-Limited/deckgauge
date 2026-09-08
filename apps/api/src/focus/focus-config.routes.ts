import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StageMapOverridesSchema } from '@deckgauge/shared';
import { clickhouse as defaultClickhouse } from '@deckgauge/db';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { board } from '../auth/policy.js';
import { WidgetCache } from '../widgets/widget-cache.js';
import {
  UnobservedStateError,
  getFocusStageMapSettings,
  saveFocusStageMapOverrides,
  type FocusConfigDeps,
} from './focus-config.service.js';

const BoardParams = z.object({ boardId: z.string().uuid() });

/**
 * The Focus stage map, read and written.
 *
 * `board('VIEWER')` on the read and `board('EDITOR')` on the write. The map
 * decides which bar a task lands in, so a caller who can only read this board
 * must not be able to move its numbers; and the read returns the board's
 * workflow vocabulary, which a caller who cannot see the board has no business
 * enumerating.
 *
 * Neither handler calls `requireOrganizationId`: `board(...)` deliberately
 * admits a membership-less caller holding a bare BoardAccess grant, so reaching
 * for an organization here would 500 exactly that caller. The tenant boundary is
 * enforced where it belongs — `getWidgetBoardScope` takes `req.membership`'s
 * organization (null included) and scopes the board resolve with it, which is
 * the same path `getFocusSnapshot` uses.
 */
export function focusConfigRoutes(deps: {
  prisma: PrismaClient;
  clickhouse?: ClickHouseClient;
  /**
   * The widget-data plugin's cache instance. Pass the SAME one `widgetDataRoutes`
   * got, or a save will not evict the payload it invalidates and the bars keep
   * their old numbers for the rest of the TTL. Defaults to a private instance so
   * a test can register this plugin alone.
   */
  cache?: WidgetCache;
}) {
  const ch = deps.clickhouse ?? defaultClickhouse;
  const cache = deps.cache ?? new WidgetCache(60_000);

  // Built per request from the scoped reader, not once at boot from the ingest
  // singleton whose permissive policy no per-organization row policy narrows.
  // `ch` is the fallback for callers constructing this plugin without the
  // chRead plugin, i.e. the tests.
  const depsFor = (req: FastifyRequest): FocusConfigDeps => ({
    prisma: deps.prisma,
    clickhouse: req.chRead ?? ch,
    organizationId: req.membership?.organizationId ?? null,
  });

  return async function plugin(app: FastifyInstance) {
    app.get<{ Params: { boardId: string } }>(
      '/boards/:boardId/focus/stage-map',
      { config: { policy: board('VIEWER') } },
      async (req, reply) => {
        const params = BoardParams.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        return getFocusStageMapSettings(depsFor(req), params.data.boardId);
      },
    );

    app.put<{ Params: { boardId: string } }>(
      '/boards/:boardId/focus/stage-map',
      { config: { policy: board('EDITOR') } },
      async (req, reply) => {
        const params = BoardParams.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
        const body = StageMapOverridesSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

        try {
          const settings = await saveFocusStageMapOverrides(
            depsFor(req),
            params.data.boardId,
            body.data,
          );
          // Widget payloads are cached for 60s. Without this the save changes
          // nothing visible until the entry expires, which reads as the setting
          // not working. After the write, so a refused payload evicts nothing.
          cache.invalidateBoard(params.data.boardId);
          return settings;
        } catch (err) {
          // 400, not 404: the board exists and the caller may edit it — the
          // payload named a state the board's sources do not report, which is a
          // problem with the request. The message names the offending states.
          if (err instanceof UnobservedStateError) {
            return reply.code(400).send({ error: err.message });
          }
          throw err;
        }
      },
    );
  };
}
