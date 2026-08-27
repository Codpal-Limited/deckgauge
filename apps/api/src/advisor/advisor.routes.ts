// EI Advisor — board-scoped SSE ask route. Streams the LLM's answer as
// `text/event-stream` frames so the chat panel can render tokens as they
// arrive. No existing route in this repo streams manually via `reply.raw`,
// so this hijacks the Fastify reply lifecycle explicitly — see the inline
// comment at the hijack call for why that's required.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { advisorAskRequestSchema } from '@deckgauge/shared';
import { all, board, orgRole } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';
import { ClickhouseIntelligenceService, type ChQueryClient } from '../intelligence/clickhouse-intelligence.service.js';
import { getBoardScope } from '../intelligence/board-scope.js';
import { BoardReadsService } from './board-reads.service.js';
import { AdvisorService } from './advisor.service.js';
import { inferenceLock } from './inference-lock.js';
import { AdvisorConfigService } from './advisor-config.service.js';
import { resolveProvider } from './llm-provider.js';

export function advisorRoutes({
  prisma,
  clickhouse,
}: {
  prisma: PrismaClient;
  clickhouse: ChQueryClient;
}) {
  return async function (app: FastifyInstance) {
    /**
     * Built PER REQUEST from the scoped reader (tenancy §11 precondition 8),
     * not once at boot from the ingest singleton — whose permissive
     * `ingest_all … USING 1` policy OR's with, and therefore defeats, every
     * per-organization row policy. Advisor answers are board-scoped by a set of
     * raw Jira project keys and `owner/repo` strings, none of which is unique
     * per deployment, so an unnarrowed read returns another tenant's rows for
     * every colliding identifier.
     *
     * `clickhouse` stays the fallback only for callers registering this plugin
     * without the chRead decorator, i.e. the unit tests; the route's
     * `orgRole('VIEWER')` floor guarantees a membership — and therefore a
     * non-null `chRead` — on every real request.
     *
     * Safe to build per request: AdvisorService holds no state across calls
     * (`ask()` returns a fresh AdvisorRun) and `inferenceLock` is a module
     * singleton, so serialisation is unaffected by where this is constructed.
     *
     * `ClickhouseIntelligenceService` doesn't need the DeveloperProfile join
     * `prisma` enables, so it's intentionally omitted there. `BoardReadsService`
     * reads board content straight from Postgres, so it does need `prisma` —
     * built per request below, same as `intel`; it is stateless, so there is
     * no state to leak across requests either way.
     */
    const advisorFor = (req: FastifyRequest) =>
      new AdvisorService({
        intel: new ClickhouseIntelligenceService({ client: req.chRead ?? clickhouse }),
        boardReads: new BoardReadsService(prisma),
      });
    const configService = new AdvisorConfigService(prisma);

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/advisor/ask',
      // Board VIEWER decides *which board* may be asked about; the organization
      // floor is what supplies the tenant whose advisor config answers. Board
      // access alone cannot: a break-glass admin holds board access with no
      // membership, and there would be no organization to read a config from.
      { config: { policy: all(board('VIEWER'), orgRole('VIEWER')) } },
      async (req, reply) => {
        const parsed = advisorAskRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid request' });
        }

        // Defense-in-depth: the body carries its own `boardId` (validated
        // above) but scope is ALWAYS derived from the authorized path param
        // below. If the two ever disagree, reject rather than silently
        // trusting the path param — this closes off a latent scope-widening
        // trap where a future edit could accidentally wire `body.boardId`
        // into scope resolution.
        if (parsed.data.boardId !== (req.params as { boardId: string }).boardId) {
          return reply.code(400).send({ error: 'board_id_mismatch' });
        }

        const config = await configService.getConfig(requireOrganizationId(req));
        if (!config) {
          return reply.code(409).send({ error: 'advisor_not_configured' });
        }

        const { boardId } = req.params;
        // `orgRole('VIEWER')` is part of this route's policy, so a membership is
        // guaranteed — hence `requireOrganizationId` rather than a `?? null`.
        const scope = await getBoardScope(prisma, boardId, requireOrganizationId(req));
        const provider = resolveProvider(config);

        // Take over the raw response from here on — Fastify must not try to
        // send its own reply once we start writing SSE frames by hand, or
        // the stream hangs/breaks.
        //
        // Headers go out BEFORE the lock is acquired, deliberately: a queued
        // caller then holds an open SSE stream that is simply quiet, rather than
        // a request that looks hung.
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        try {
          // The lock spans ask() AND the stream consumption, not just ask():
          // ask() returns immediately with an AsyncIterable, so inference happens
          // as the stream is drained. Wrapping only the call would serialise
          // nothing (spec §5.1, LIMIT 1). Scope/provider resolution stays outside,
          // so the lock is not held during database work.
          await inferenceLock.run(async () => {
            const run = advisorFor(req).ask({
              boardId,
              provider,
              scope,
              question: parsed.data.question,
              widgetType: parsed.data.widgetType,
              history: parsed.data.history,
            });
            for await (const chunk of run.textStream) {
              reply.raw.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
            }
            const toolCalls = await run.toolCalls;
            reply.raw.write(`data: ${JSON.stringify({ type: 'done', toolCalls })}\n\n`);
          });
        } catch (err) {
          reply.raw.write(
            `data: ${JSON.stringify({
              type: 'error',
              message: err instanceof Error ? err.message : 'advisor failed',
            })}\n\n`,
          );
        } finally {
          reply.raw.end();
        }
      },
    );
  };
}
