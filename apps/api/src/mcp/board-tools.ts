import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { meetsBoardRole, type OrgRoleValue } from '@deckgauge/shared';
import { ADVISOR_TOOL_SPECS } from '../advisor/tools.js';
import { BoardReadsService } from '../advisor/board-reads.service.js';
import { AccessService } from '../access/access.service.js';
import { getBoardScope } from '../intelligence/board-scope.js';
import type { ClickhouseIntelligenceService } from '../intelligence/clickhouse-intelligence.service.js';

export interface BoardToolDeps {
  prisma: PrismaClient;
  intel: ClickhouseIntelligenceService;
  getUserId: () => string | null;
  /**
   * The caller's organization standing, or `null` for the membership-less
   * break-glass identity (`AccessService.getEffectiveRole` keeps that path:
   * with no organization to scope to, the raw grant decides alone).
   *
   * A plain value rather than a thunk like `getUserId`, because
   * `createMcpConnection` is built fresh per Fastify request — see the comment
   * on it in `mcp.server.ts` — so there is no shared instance for this to leak
   * across.
   */
  membership: { organizationId: string; role: OrgRoleValue } | null;
}

// Minimal shape we rely on from McpServer — adapted from the installed SDK's
// registerTool signature (name, config with description + raw Zod shape, handler).
export interface ToolRegistrar {
  registerTool: (
    name: string,
    config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>,
  ) => void;
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError };
}

export function registerBoardTools(server: ToolRegistrar, deps: BoardToolDeps): void {
  /**
   * Both stateless, so constructing them here rather than threading them
   * through `BoardToolDeps` keeps the dependency surface at what callers
   * actually have to supply. Same reason the four access route families each
   * do `new AccessService(prisma)` locally.
   */
  const access = new AccessService(deps.prisma);
  const boardReads = new BoardReadsService(deps.prisma);

  for (const spec of ADVISOR_TOOL_SPECS) {
    // MCP input schema = the spec's fields PLUS a required boardId.
    const shape = {
      boardId: z.string().min(1),
      ...(spec.inputSchema as z.ZodObject<z.ZodRawShape>).shape,
    };
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: shape },
      async (args) => {
        const userId = deps.getUserId();
        if (!userId) return textResult({ error: 'unauthorized' }, true);

        const boardId = String(args.boardId);
        /**
         * `AccessService.getEffectiveRole`, not `hasBoardAccess`.
         *
         * `hasBoardAccess` decided on a `BoardAccess` grant row alone, which made
         * this a SECOND authorization axis that could disagree with
         * `evaluatePolicy` — and did: an organization ADMIN is an implicit OWNER
         * of every board in their organization, holds no grant row, and was
         * refused here while being admitted by every other board route. Two axes
         * that can disagree is the `connectionOwner` mistake Phase C deleted.
         *
         * It failed CLOSED, so it was never a leak. The resolver is not merely
         * more permissive, though: it reads the board THROUGH the caller's
         * organization, so a board in another tenant answers "no role" rather
         * than inheriting the implicit-owner rule (tenancy §11 precondition 7).
         */
        const role = await access.getEffectiveRole('board', boardId, userId, deps.membership);
        if (!meetsBoardRole(role, spec.minRole)) {
          return textResult({ error: 'forbidden: no access to board' }, true);
        }

        const scope = await getBoardScope(
          deps.prisma,
          boardId,
          deps.membership?.organizationId ?? null,
        );
        const { boardId: _omit, ...toolInput } = args;
        const result = await spec.handler(toolInput, { boardId, scope }, { intel: deps.intel, boardReads });
        return textResult(result);
      },
    );
  }
}
