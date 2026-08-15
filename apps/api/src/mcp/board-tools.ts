import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { ADVISOR_TOOL_SPECS } from '../advisor/tools.js';
import { hasBoardAccess } from '../board-access/board-access.middleware.js';
import { getBoardScope } from '../intelligence/board-scope.js';
import type { ClickhouseIntelligenceService } from '../intelligence/clickhouse-intelligence.service.js';

export interface BoardToolDeps {
  prisma: PrismaClient;
  intel: ClickhouseIntelligenceService;
  getUserId: () => string | null;
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
        if (!(await hasBoardAccess(deps.prisma, userId, boardId, 'VIEWER'))) {
          return textResult({ error: 'forbidden: no access to board' }, true);
        }

        const scope = await getBoardScope(deps.prisma, boardId);
        const { boardId: _omit, ...toolInput } = args;
        const result = await spec.handler(toolInput, scope, { intel: deps.intel });
        return textResult(result);
      },
    );
  }
}
