// Builds a real @modelcontextprotocol/sdk McpServer, registers the
// board-scoped tools (Task 3) on it, and wires it to the Streamable HTTP
// transport. Verified against the installed SDK (1.30.0):
//   - McpServer.registerTool(name, config, cb) — config.inputSchema takes a
//     raw Zod shape (Record<string, ZodTypeAny>), matching board-tools.ts's
//     ToolRegistrar exactly; the SDK just wraps it into an object schema
//     internally (server/zod-compat.js#normalizeObjectSchema).
//   - cb receives (args, extra) — two args — while board-tools.ts's handler
//     only declares one. That's a strict subset, so no adapter is needed for
//     the call itself; see `toToolRegistrar` below for the one real gap
//     (registerTool's return value + generic signature vs. the plain `void`
//     interface board-tools.ts assumes).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerBoardTools, type BoardToolDeps, type ToolRegistrar } from './board-tools.js';

const MCP_SERVER_INFO = { name: 'deckgauge-advisor', version: '0.1.0' };

// Thin structural adapter: McpServer.registerTool is generic and returns a
// RegisteredTool handle, board-tools.ts's ToolRegistrar declares a simpler
// `(name, config, handler) => void`. Wrapping (rather than passing the real
// McpServer straight through as a ToolRegistrar) keeps board-tools.ts's
// interface exact and avoids relying on TS's generic-method assignability.
function toToolRegistrar(server: McpServer): ToolRegistrar {
  return {
    registerTool(name, config, handler) {
      server.registerTool(name, config, async (args) => handler(args as Record<string, unknown>));
    },
  };
}

export interface McpConnection {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

// Builds a fresh McpServer + stateless Streamable HTTP transport pair.
// Stateless (no sessionIdGenerator) and built fresh per Fastify request:
// `deps.getUserId` closes over one specific authenticated request, so a
// shared long-lived McpServer instance would risk leaking board/user scope
// across concurrent requests from different users.
export async function createMcpConnection(deps: BoardToolDeps): Promise<McpConnection> {
  const server = new McpServer(MCP_SERVER_INFO);
  registerBoardTools(toToolRegistrar(server), deps);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  return { server, transport };
}
