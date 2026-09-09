import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FOCUS_MODEL_BUDGET, FOCUS_PROMPT_VERSION } from '@deckgauge/shared';
import { clickhouse as defaultClickhouse } from '@deckgauge/db';
import type { PrismaClient, ClickHouseClient } from '@deckgauge/db';
import { board } from '../auth/policy.js';
import { WidgetCache } from '../widgets/widget-cache.js';
import { resolveProvider } from '../advisor/llm-provider.js';
import { AdvisorConfigService } from '../advisor/advisor-config.service.js';
import { runFocusClassification } from './focus-data.service.js';
import { createFocusModelClassifier } from './model-classifier.adapter.js';

const BoardParams = z.object({ boardId: z.string().uuid() });
const RunBody = z.object({ config: z.record(z.string(), z.unknown()).optional() });

/**
 * Run the advisor over the tasks nothing cheaper could classify.
 *
 * An explicit POST, never a page load. `getFocusSnapshot` keeps
 * `classifyWithModel: null` so opening a board stays free and reads only what a
 * run has already paid for — and so the LLM stays off the render path and out
 * from behind the lock it shares with the conversational advisor.
 *
 * **The organization guard is an explicit 403, not `requireOrganizationId`** —
 * the same reasoning as `focus-verdict.routes.ts`. That helper's
 * `MissingOrganizationError` is a deliberate 500 meaning "this route forgot its
 * orgRole policy", while `board('EDITOR')` admits a membership-less
 * `BoardAccess` holder by design. Verdicts are org-scoped, so such a caller has
 * nowhere to write; that is a refusal to state, not a misconfiguration.
 */
export function focusClassifyRoutes(deps: {
  prisma: PrismaClient;
  clickhouse?: ClickHouseClient;
  /**
   * Injectable for tests; constructed here otherwise, matching
   * `advisor-config.routes.ts`. The route needs it to answer "is an advisor even
   * configured for this organization" before spending anything.
   */
  advisorConfig?: AdvisorConfigService;
  /** The same instance `widgetDataRoutes` gets, or a run evicts nothing. */
  cache?: WidgetCache;
}) {
  const ch = deps.clickhouse ?? defaultClickhouse;
  const cache = deps.cache ?? new WidgetCache(60_000);
  const advisorConfig = deps.advisorConfig ?? new AdvisorConfigService(deps.prisma);

  return async function plugin(app: FastifyInstance) {
    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/focus/classify',
      { config: { policy: board('EDITOR') } },
      async (req: FastifyRequest<{ Params: { boardId: string } }>, reply) => {
        const params = BoardParams.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: params.error.flatten() });

        const body = RunBody.safeParse(req.body ?? {});
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

        const organizationId = req.membership?.organizationId;
        if (!organizationId) {
          return reply.code(403).send({
            error:
              'A classification is stored per organization, and this account has board access without an organization membership.',
          });
        }

        const config = await advisorConfig.getConfig(organizationId);
        // 409 rather than 500: nothing is broken, the feature is not set up.
        // `getConfig` already falls back to the deployment environment, so null
        // means the saved row AND the env are both absent.
        if (!config) {
          return reply.code(409).send({
            error: 'No advisor model is configured for this organization, so there is nothing to run.',
          });
        }

        const provider = resolveProvider(config);

        const result = await runFocusClassification(
          {
            prisma: deps.prisma,
            clickhouse: req.chRead ?? ch,
            organizationId,
          },
          params.data.boardId,
          body.data.config ?? {},
          {
            // A factory, not a finished classifier: the route knows the
            // provider and only the run knows the board's roadmap epics, and
            // the prompt needs both. See `classifierFor`.
            classifierFor: (epics, onProviderError) =>
              createFocusModelClassifier({ model: provider.model, epics, onProviderError }),
            // Shared with the UI, which states the cap before the press.
            modelBudget: FOCUS_MODEL_BUDGET,
            run: { model: config.model, promptVersion: FOCUS_PROMPT_VERSION },
          },
        );

        // Null means no issue source, exactly as the snapshot reports it.
        // Answering "classified 0" would say the run succeeded and found
        // nothing, which is a different and false statement.
        if (!result) return reply.code(404).send({ error: 'This board has no issue source.' });

        cache.invalidateBoard(params.data.boardId);
        // 200 even when `result.providerError` is set: the run completed and
        // persisted whatever the earlier batches earned. A 5xx would discard
        // `classified` and `remaining` on the way out — the web action collapses
        // every non-ok status to an error string — which is exactly the partial
        // progress this reports in order to preserve.
        return { ...result, model: config.model, promptVersion: FOCUS_PROMPT_VERSION };
      },
    );
  };
}
