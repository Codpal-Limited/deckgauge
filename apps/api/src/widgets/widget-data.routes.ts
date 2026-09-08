import { FastifyInstance, type FastifyBaseLogger } from 'fastify';
// No `clickhouse` import: this module deliberately has no access to the ingest
// singleton any more. Reads come from request.chRead (tenancy §11 precondition 8),
// and removing the import is what stops the default quietly coming back.
import { PrismaClient, type ClickHouseClient } from '@deckgauge/db';
import {
  NEW_WIDGET_TYPES,
  COMPARISON_WIDGET_TYPES,
  WidgetDataBatchRequestSchema,
  type WidgetScopeFlags,
  type WidgetDataBatchResultEntry,
} from '@deckgauge/shared';
import { WidgetDataService } from './widget-data.service.js';
import type { ChScopedReader } from '../analytics/ch-read-scope.js';
import { WidgetCache } from './widget-cache.js';
import { board, viaBranch, type IdExtractor } from '../auth/policy.js';
import { forbiddenBoardIds } from '../auth/board-access.js';
import type { CallerMembership } from '../auth/board-access.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { WIDGET_TYPES } from './dashboard-widgets.service.js';

// Max widgets resolved simultaneously in a batch. Each widget can run several
// Prisma scope queries plus a ClickHouse query, so an unbounded fan-out over a
// ~25-widget board exhausts the Postgres connection pool ("too many clients").
// A bounded fan-out keeps most of the parallel speed-up without the flood.
const BATCH_CONCURRENCY = 6;

// Dispatch table. Entries land as their service methods do (C.2 - C.15 each add
// one). Keys are strings (not the narrow WidgetType union) because the new v1
// types live in NEW_WIDGET_TYPES rather than WIDGET_TYPES until Phase E folds
// them into the Zod schema.
const WIDGET_METHOD_MAP: Partial<Record<string, keyof WidgetDataService>> = {
  STATUS_DISTRIBUTION: 'getStatusDistribution',
  STATUS_BY_GROUP: 'getStatusByGroup',
  ITEMS_BY_OWNER: 'getItemsByOwner',
  VELOCITY_LEADERBOARD: 'getVelocityLeaderboard',
  COMPLETION_RATE: 'getCompletionRate',
  RECENTLY_COMPLETED: 'getRecentlyCompleted',
  STUCK_ISSUES: 'getStuckIssues',
  BLOCKED_ITEMS: 'getBlockedItems',
  STALE_ITEMS: 'getStaleItems',
  TOTAL_COUNT: 'getTotalCount',
  STATUS_SUMMARY: 'getStatusSummary',
  CH_COMPLETION_TREND: 'getChCompletionTrend',
  CH_VELOCITY: 'getChVelocity',
  CH_CYCLE_TIME_TREND: 'getChCycleTimeTrend',
  CH_BACKLOG_AGE: 'getChBacklogAge',
  LEAD_TIME_FOR_CHANGES: 'getLeadTimeForChanges',
  PR_CYCLE_TIME_SCATTER: 'getPrCycleTimeScatter',
  REVIEW_PICKUP_TIME: 'getReviewPickupTime',
  PR_SIZE_DISTRIBUTION: 'getPrSizeDistribution',
  MERGE_FREQUENCY_PER_DEV: 'getMergeFrequencyPerDev',
  REWORK_RATE: 'getReworkRate',
  BUG_RATE: 'getBugRate',
  ITERATION_PLANNING_ACCURACY: 'getIterationPlanningAccuracy',
  VELOCITY_WITH_CONFIDENCE: 'getVelocityWithConfidence',
  INITIATIVE_RISK_RADAR: 'getInitiativeRiskRadar',
  ISSUES_OPENED_VS_CLOSED: 'getIssuesOpenedVsClosed',
  WIP_COUNT: 'getWipCount',
  TICKET_COVERAGE_RATE: 'getTicketCoverageRate',
  AI_ASSISTED_PR_PCT: 'getAiAssistedPrPct',
  REVIEW_MIX: 'getReviewMix',
  BOT_VS_HUMAN: 'getBotVsHuman',
  COMMITS_PER_DEV: 'getCommitsPerDev',
  REVIEWER_PARTICIPATION: 'getReviewerParticipation',
  REVIEW_QUALITY_INDEX: 'getReviewQualityIndex',
  REVIEW_QUALITY_TREND: 'getReviewQualityTrend',
  FLOW_THROUGHPUT_CYCLE: 'getFlowThroughputCycle',
  DELIVERY_TREND_ANNOTATED: 'getDeliveryTrendAnnotated',
  AI_ADOPTION: 'getAiAdoption',
  INVESTMENT_ALLOCATION: 'getInvestmentAllocation',
  DORA_METRICS: 'getDoraMetrics',
  PERIOD_COMPARISON: 'getPeriodComparison',
  // P6 — multi-board comparison widgets. The `:boardId` route slot carries the
  // Comparison id; each method fans an existing single-board method out
  // over the comparison's board set (comparison_members).
  FOCUS_ROADMAP_SHARE: 'getFocusRoadmapShare',
  FOCUS_SHIPPED_RATIO: 'getFocusShippedRatio',
  FOCUS_NEVER_MOVED: 'getFocusNeverMoved',
  FOCUS_EPIC_COVERAGE: 'getFocusEpicCoverage',
  FOCUS_ATTENTION_SPLIT: 'getFocusAttentionSplit',
  FOCUS_DELIVERY_FUNNEL: 'getFocusDeliveryFunnel',
  FOCUS_MAP: 'getFocusMap',
  FOCUS_SCORECARD: 'getFocusScorecard',
  FOCUS_BOARD_COVERAGE: 'getFocusBoardCoverage',
  FOCUS_PROVENANCE: 'getFocusProvenance',
  FOCUS_LEDGER: 'getFocusLedger',
  FOCUS_CAVEATS: 'getFocusCaveats',
  COMPARE_REVIEW_QUALITY: 'getCompareReviewQuality',
  COMPARE_FLOW: 'getCompareFlow',
  COMPARE_DELIVERY: 'getCompareDelivery',
};

// Single source of truth: every widget name the API recognises. The 14 NEW_WIDGET_TYPES
// are registered here at C.1 even though their service methods land later (C.2–C.15),
// so the picker / registry can reference them without unknown-type rejections.
const KNOWN_WIDGET_TYPES: ReadonlySet<string> = new Set<string>([
  ...WIDGET_TYPES,
  ...NEW_WIDGET_TYPES,
  ...COMPARISON_WIDGET_TYPES,
]);

export function throwIfUnknownWidgetType(t: string): void {
  if (!KNOWN_WIDGET_TYPES.has(t)) {
    throw new Error(`unknown widget type: ${t}`);
  }
}

const isComparisonWidgetType = (t: string): boolean =>
  (COMPARISON_WIDGET_TYPES as readonly string[]).includes(t);

// A type this API doesn't recognise at all (typo, retired type, garbage) is
// neither a comparison type nor a board type — it matches no arm below and
// denies. Authz doesn't try to guess what an unknown type means; it keys off
// exactly the set `resolveWidgetData` itself validates against.
const isBoardWidgetType = (t: string): boolean => KNOWN_WIDGET_TYPES.has(t) && !isComparisonWidgetType(t);

/**
 * `:boardId` doubles as a Comparison id for comparison widget types (see the
 * `COMPARISON_WIDGET_TYPES` comment in `resolveWidgetData` below) — the same
 * signal the handler itself keys off. Discriminates on the single-widget
 * GET's `:widgetType` route param. `matchComparison` selects which of the
 * two mutually-exclusive branch arms this extractor backs; returns
 * `undefined` (no match) for an absent, unrecognised, or (for
 * `matchComparison`) non-comparison type, so the two arms below are never
 * both satisfied and an unrecognised type falls into neither.
 */
const widgetTypeFromParam = (matchComparison: boolean): IdExtractor => (ctx) => {
  const widgetType = ctx.params.widgetType;
  const boardId = ctx.params.boardId;
  if (!widgetType || !boardId) return undefined;
  const isMatch = matchComparison ? isComparisonWidgetType(widgetType) : isBoardWidgetType(widgetType);
  return isMatch ? [boardId] : undefined;
};

/**
 * Same split as `widgetTypeFromParam`, but for the batch POST, whose request
 * carries a `widgets: [{ widgetType, config }, ...]` body instead of a single
 * `:widgetType` param — mirrors exactly what `resolveWidgetData` reads per
 * item. A batch mixing comparison, board, and/or unrecognised widget types is
 * ambiguous for a single request-level check (there's one `:boardId`, one of
 * two meanings) — that's deliberate: it matches neither arm, so the branch
 * denies rather than guessing.
 */
const widgetTypesFromBatchBody = (matchComparison: boolean): IdExtractor => (ctx) => {
  const boardId = ctx.params.boardId;
  const body = ctx.body as { widgets?: unknown } | undefined;
  if (!boardId || !body || !Array.isArray(body.widgets) || body.widgets.length === 0) return undefined;
  const types = body.widgets.map((w) => (w as { widgetType?: unknown } | null)?.widgetType);
  const allStrings = types.every((t): t is string => typeof t === 'string' && t.length > 0);
  if (!allStrings) return undefined;
  const matcher = matchComparison ? isComparisonWidgetType : isBoardWidgetType;
  const allMatch = types.every((t) => matcher(t));
  return allMatch ? [boardId] : undefined;
};

export async function widgetDataRoutes(
  app: FastifyInstance,
  {
    prisma,
    clickhouse: ch,
    singleUser = false,
    // Injectable so `server.ts` can hand the SAME instance to the focus
    // stage-map route, which evicts a board's entries after a save. Defaults to
    // a fresh cache per registration — a module-level singleton would make this
    // plugin stateful across registrations, and did: a cached entry from one
    // test case served the next one in the same file.
    cache = new WidgetCache(60_000),
  }: {
    prisma: PrismaClient;
    clickhouse?: ClickHouseClient;
    singleUser?: boolean;
    cache?: WidgetCache;
  }
) {

  // Fail fast: surface any persisted widgetType the API no longer knows about
  // (e.g. orphaned by a rename). Throws during plugin init, aborting server startup.
  const persisted = await prisma.dashboardWidget.findMany({
    select: { widgetType: true },
    distinct: ['widgetType'],
  });
  for (const row of persisted) {
    throwIfUnknownWidgetType(row.widgetType);
  }

  // Resolve a single widget's data (type check → cache-key incl. comparison
  // member fold-in → cache get/set → execute). Shared by the single-widget GET
  // and the batch POST so both behave identically; the batch just runs many of
  // these in parallel behind one request. Returns a discriminated result rather
  // than touching `reply`, so callers own the HTTP shape.
  type WidgetResolution =
    | { ok: true; data: unknown }
    | { ok: false; status: number; error: string };

  async function resolveWidgetData(
    boardId: string,
    widgetType: string,
    config: Record<string, unknown>,
    ctx: {
      userId: string | undefined;
      singleUser: boolean;
      log: FastifyBaseLogger;
      // Spec §13: the per-board re-check below must apply the same org-role
      // ceiling the policy layer does, or an org ADMIN sees an empty widget.
      membership?: CallerMembership;
      /**
       * The per-request scoped reader. `null` means the caller has no
       * organization, and a widget read is refused rather than served from the
       * ingest identity — see the guard below.
       */
      chRead?: ChScopedReader | null;
    }
  ): Promise<WidgetResolution> {
    if (!KNOWN_WIDGET_TYPES.has(widgetType)) {
      return { ok: false, status: 400, error: `Unknown widget type: ${widgetType}` };
    }

    const method = WIDGET_METHOD_MAP[widgetType];
    if (!method) {
      return { ok: false, status: 501, error: `Widget type not yet implemented: ${widgetType}` };
    }

    let cacheKey = WidgetCache.makeKey(boardId, widgetType, config);

    // Comparison widgets fan out over a Comparison's persisted member board
    // set, which is NOT part of (boardId, widgetType, config) — boardId here
    // is the fixed comparison id. Without folding that set into the cache key,
    // adding or removing a board serves the previous payload for the whole
    // 60s TTL (the board never appears / lingers until the entry expires).
    if ((COMPARISON_WIDGET_TYPES as readonly string[]).includes(widgetType)) {
      const members = await prisma.comparisonMember.findMany({
        where: { comparisonId: boardId },
        orderBy: { position: 'asc' },
        select: { boardId: true },
      });

      // Read-time board check. The route policy only proved the caller created
      // this comparison; the member boards are stored data, so a board added
      // when the caller could see it — or, before the write-side check existed,
      // a board they never could — must be re-authorized on every read or
      // revocation never takes effect. Refuse the whole payload rather than
      // fanning out over the accessible subset: a comparison silently missing a
      // board reads as a real, and wrong, comparison. Checked before the cache
      // lookup so a cached entry can never serve as a bypass.
      //
      // `singleUser` mirrors the flag threaded into `buildPolicyPlugin` (see
      // server.ts) — one source of truth for "is auth off", passed down
      // explicitly rather than read from `process.env` here. In that mode
      // `evaluatePolicy` already allows outright and `request.user` is
      // unset, so this check must be skipped entirely rather than calling
      // `forbiddenBoardIds` with an undefined user id.
      const memberBoardIds = members.map((m) => m.boardId);
      if (!ctx.singleUser) {
        if (!ctx.userId) return { ok: false, status: 403, error: 'Forbidden' };
        const forbidden = await forbiddenBoardIds(prisma, ctx.userId, memberBoardIds, 'VIEWER', ctx.log, ctx.membership ?? null);
        if (forbidden.length > 0) {
          return {
            ok: false,
            status: 403,
            error:
              'Forbidden: this comparison includes board(s) you no longer have access to — ' +
              'remove them from the comparison to view it.',
          };
        }
      }
      cacheKey += `:${memberBoardIds.join(',')}`;
    }

    const cached = cache.get(cacheKey);
    if (cached !== undefined) return { ok: true, data: cached };

    // Built per request from the scoped reader, not once at boot from the ingest
    // singleton (tenancy §11 precondition 8). `ch` stays supported for the
    // plugin's own tests, which construct it without the chRead plugin.
    const readClient = ctx.chRead ?? ch;
    if (!readClient) {
      return { ok: false, status: 403, error: 'NO_ORGANIZATION' };
    }
    // Same source as the read client's tenant: the membership the policy layer
    // resolved. `null` is the break-glass caller, which board-scope leaves
    // unscoped for the reason recorded on `ResolveBoardScopeOptions`.
    const service = new WidgetDataService(prisma, readClient, ctx.membership?.organizationId ?? null);

    const fn = service[method] as (
      boardId: string,
      config: Record<string, unknown>
    ) => Promise<unknown>;
    const data = await fn.call(service, boardId, config);

    cache.set(cacheKey, data);
    return { ok: true, data };
  }

  // For COMPARISON_WIDGET_TYPES the `:boardId` slot actually carries a
  // Comparison id (see resolveWidgetData's comment above); for every other
  // widget type it's a real board id. `viaBranch` picks the one arm whose
  // discriminator (the same `widgetType` signal the handler reads) matches —
  // a comparison request never falls through to a board-access check, and
  // vice versa; an absent or split-decision widget type matches neither arm
  // and denies. See policy.ts's `comparisonAccess`/`boardId` branch arms.
  app.get<{ Params: { boardId: string; widgetType: string }; Querystring: { config?: string } }>(
    '/boards/:boardId/widgets/:widgetType/data',
    {
      config: {
        policy: board('VIEWER', viaBranch([
          { when: widgetTypeFromParam(true), then: 'comparisonAccess' },
          { when: widgetTypeFromParam(false), then: 'boardId' },
        ])),
      },
    },
    async (req, reply) => {
      const { boardId, widgetType } = req.params;
      const config = req.query.config ? JSON.parse(req.query.config) : {};

      const resolved = await resolveWidgetData(boardId, widgetType, config, {
        userId: req.user?.id,
        singleUser,
        log: req.log,
        membership: req.membership ?? null,
        chRead: req.chRead,
      });
      if (!resolved.ok) return reply.status(resolved.status).send({ error: resolved.error });
      return resolved.data;
    }
  );

  // POST /boards/:boardId/widgets/data — resolve many widgets in one request.
  // The dashboard sends its whole widget list; we run them through the same
  // resolver concurrently (Promise.all) so N per-widget round-trips (which
  // Next.js serializes as separate server actions) collapse into one, sharing
  // one board-scope lookup and the widget cache. Per-widget failures are
  // captured into the result entry so one bad widget never fails the batch.
  // Same comparison-id-in-boardId-slot split as the single-widget GET above,
  // discriminated on every item's `widgetType` in the batch body instead of a
  // route param — see `widgetTypesFromBatchBody`. A batch mixing comparison
  // and non-comparison types matches neither arm and denies.
  app.post<{ Params: { boardId: string } }>(
    '/boards/:boardId/widgets/data',
    {
      config: {
        policy: board('VIEWER', viaBranch([
          { when: widgetTypesFromBatchBody(true), then: 'comparisonAccess' },
          { when: widgetTypesFromBatchBody(false), then: 'boardId' },
        ])),
      },
    },
    async (req, reply) => {
      const { boardId } = req.params;

      const parsed = WidgetDataBatchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const results: WidgetDataBatchResultEntry[] = await mapWithConcurrency(
        parsed.data.widgets,
        BATCH_CONCURRENCY,
        async ({ widgetType, config }) => {
          try {
            const resolved = await resolveWidgetData(boardId, widgetType, config, {
              userId: req.user?.id,
              singleUser,
              log: req.log,
              membership: req.membership ?? null,
              chRead: req.chRead,
            });
            return resolved.ok
              ? { widgetType, config, data: resolved.data }
              : { widgetType, config, data: null, error: resolved.error };
          } catch (e) {
            req.log.error({ evt: 'widget_batch_item_failed', widgetType, err: e });
            return {
              widgetType,
              config,
              data: null,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }
      );

      return reply.status(200).send({ results });
    }
  );

  // Source-kind presence flags for the current board. Used by the widget
  // picker (to disable widgets the board cannot run) and by future preset
  // banners (to flag widgets that became available after a source was added).
  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/widget-scope',
    { config: { policy: board('VIEWER') } },
    async (req): Promise<WidgetScopeFlags> => {
      const { boardId } = req.params;
      const [jira, github, gitlab, ado] = await Promise.all([
        prisma.boardJiraSource.count({ where: { boardId } }),
        prisma.boardGitHubSource.count({ where: { boardId } }),
        prisma.boardGitLabSource.count({ where: { boardId } }),
        prisma.boardAdoSource.count({ where: { boardId } }),
      ]);
      return {
        hasJira: jira > 0,
        hasGitHub: github > 0,
        hasGitLab: gitlab > 0,
        hasAdo: ado > 0,
      };
    }
  );
}
