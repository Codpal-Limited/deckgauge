// EI Advisor — board-scoped SSE ask route. Streams the LLM's answer as
// `text/event-stream` frames so the chat panel can render tokens as they
// arrive. No existing route in this repo streams manually via `reply.raw`,
// so this hijacks the Fastify reply lifecycle explicitly — see the inline
// comment at the hijack call for why that's required.
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { advisorAskRequestSchema } from '@deckgauge/shared';
import { board } from '../auth/policy.js';
import { ClickhouseIntelligenceService, type ChQueryClient } from '../intelligence/clickhouse-intelligence.service.js';
import { getBoardScope } from '../intelligence/board-scope.js';
import { AdvisorService } from './advisor.service.js';
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
    // Advisor tools don't need the DeveloperProfile join `prisma` enables on
    // this service, so it's intentionally omitted here.
    const intel = new ClickhouseIntelligenceService({ client: clickhouse });
    const advisor = new AdvisorService({ intel });
    const configService = new AdvisorConfigService(prisma);

    app.post<{ Params: { boardId: string } }>(
      '/boards/:boardId/advisor/ask',
      { config: { policy: board('VIEWER') } },
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

        const config = await configService.getConfig();
        if (!config) {
          return reply.code(409).send({ error: 'advisor_not_configured' });
        }

        const { boardId } = req.params;
        const scope = await getBoardScope(prisma, boardId);
        const provider = resolveProvider(config);

        const run = advisor.ask({
          provider,
          scope,
          question: parsed.data.question,
          widgetType: parsed.data.widgetType,
          history: parsed.data.history,
        });

        // Take over the raw response from here on — Fastify must not try to
        // send its own reply once we start writing SSE frames by hand, or
        // the stream hangs/breaks.
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        try {
          for await (const chunk of run.textStream) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
          }
          const toolCalls = await run.toolCalls;
          reply.raw.write(`data: ${JSON.stringify({ type: 'done', toolCalls })}\n\n`);
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
