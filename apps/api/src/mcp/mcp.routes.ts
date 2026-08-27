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
import { ORG_VIEWER } from '../auth/policy.js';

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
    async function handleMcpRequest(req: FastifyRequest, reply: FastifyReply, body?: unknown) {
      /**
       * Built PER REQUEST from the scoped reader (tenancy §11 precondition 8),
       * not once at boot from the ingest singleton — whose permissive
       * `ingest_all … USING 1` policy OR's with, and therefore defeats, every
       * per-organization row policy. MCP tools filter on raw Jira project keys
       * and `owner/repo` strings, none of which is unique per deployment, so an
       * unnarrowed read answers with another tenant's rows for every colliding
       * identifier.
       *
       * This is also why the policy below is `ORG_VIEWER` and no longer
       * `AUTHENTICATED`: `chRead` is resolved from `request.membership`, so a
       * route that resolves no membership has no organization to scope to and
       * would fall straight back to the cross-tenant ingest identity.
       * `clickhouse` therefore remains the fallback only for callers registering
       * this plugin without the chRead decorator, i.e. the unit tests.
       *
       * MCP tools don't need the DeveloperProfile join `prisma` enables on this
       * service, same reasoning as advisor.routes.ts.
       */
      const intel = new ClickhouseIntelligenceService({ client: req.chRead ?? clickhouse });
      const { transport } = await createMcpConnection({
        prisma,
        intel,
        getUserId: () => req.user?.id ?? null,
        // The tools resolve board access through `AccessService`, which needs the
        // caller's organization standing to apply the org-role ceiling and to
        // read the board through the right tenant. `null` is the membership-less
        // break-glass identity, which that resolver already handles.
        membership: req.membership ?? null,
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
      { config: { policy: ORG_VIEWER }, preHandler: [requireUser] },
      async (req, reply) => {
        await handleMcpRequest(req, reply, req.body);
      },
    );

    // Streamable HTTP clients may open a standalone GET for server-initiated
    // notifications; the transport itself rejects it (405) when unsupported
    // in stateless mode, so we just forward it through.
    app.get(
      '/mcp',
      { config: { policy: ORG_VIEWER }, preHandler: [requireUser] },
      async (req, reply) => {
        await handleMcpRequest(req, reply);
      },
    );
  };
}
