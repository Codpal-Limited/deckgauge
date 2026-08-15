// Mounts the board-scoped MCP server (Task 3 tools + Task 4 transport) at
// `/mcp` behind auth. Mirrors the advisor SSE route's `reply.hijack()`
// pattern (apps/api/src/advisor/advisor.routes.ts) since the Streamable HTTP
// transport also writes directly to the raw Node response.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import {
  ClickhouseIntelligenceService,
  type ChQueryClient,
} from '../intelligence/clickhouse-intelligence.service.js';
import { createMcpConnection } from './mcp.server.js';
import { AUTHENTICATED } from '../auth/policy.js';

async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
}

export function mcpRoutes({
  prisma,
  clickhouse,
}: {
  prisma: PrismaClient;
  clickhouse: ChQueryClient;
}) {
  return async function (app: FastifyInstance) {
    // MCP tools don't need the DeveloperProfile join `prisma` enables on this
    // service, same reasoning as advisor.routes.ts.
    const intel = new ClickhouseIntelligenceService({ client: clickhouse });

    async function handleMcpRequest(req: FastifyRequest, reply: FastifyReply, body?: unknown) {
      const { transport } = await createMcpConnection({
        prisma,
        intel,
        getUserId: () => req.user?.id ?? null,
      });

      // Hand the raw response off to the transport — Fastify must not send
      // its own reply once the transport starts writing (SSE or plain JSON).
      reply.hijack();
      try {
        await transport.handleRequest(req.raw, reply.raw, body);
      } finally {
        await transport.close();
      }
    }

    app.post(
      '/mcp',
      { config: { policy: AUTHENTICATED }, preHandler: [requireUser] },
      async (req, reply) => {
        await handleMcpRequest(req, reply, req.body);
      },
    );

    // Streamable HTTP clients may open a standalone GET for server-initiated
    // notifications; the transport itself rejects it (405) when unsupported
    // in stateless mode, so we just forward it through.
    app.get(
      '/mcp',
      { config: { policy: AUTHENTICATED }, preHandler: [requireUser] },
      async (req, reply) => {
        await handleMcpRequest(req, reply);
      },
    );
  };
}
