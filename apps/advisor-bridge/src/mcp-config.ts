import type { McpServer } from '@zed-industries/agent-client-protocol';

export interface BuildDeckgaugeMcpConfigOptions {
  mcpUrl: string;
  token: string;
  /**
   * Whether the agent advertised `mcpCapabilities.http` on `initialize`.
   * Required — not defaulted — so every call site has to state which
   * transport the agent it just handshook with can actually take.
   */
  supportsHttp: boolean;
}

/**
 * Builds the single `deckgauge` MCP-server entry passed to `session/new`
 * (`NewSessionRequest.mcpServers`).
 *
 * Prefers the **http** transport whenever the agent advertises it (Claude
 * Code's adapter does: `mcpCapabilities: {http: true, sse: true}`). The agent
 * then holds the connection to Deckgauge's `/mcp` itself, with the operator's
 * token as a real request header. That avoids three problems the stdio path
 * has, all of them user-visible:
 *
 * 1. `mcp-remote` treats a 401 as "this server must want OAuth", abandons the
 *    `Authorization` header it was given, tries dynamic client registration
 *    against the API, and exits fatally — so an expired token, or a board the
 *    operator can't see, surfaced as *zero* `deckgauge` tools rather than as
 *    an auth error.
 * 2. `npx -y mcp-remote` downloads a package on a cold cache before the
 *    session can open, which is what forced the panel's authenticate deadline
 *    up to 30s.
 * 3. The token was passed as an argv element, readable by any other user on
 *    the host via `ps` (see docs/advisor-local-agent.md's security model).
 *
 * Falls back to the `mcp-remote` stdio proxy for agents that don't advertise
 * http, since Stdio is the only transport every ACP agent must support.
 */
export function buildDeckgaugeMcpConfig(opts: BuildDeckgaugeMcpConfigOptions): McpServer {
  const { mcpUrl, token, supportsHttp } = opts;

  if (supportsHttp) {
    return {
      name: 'deckgauge',
      type: 'http',
      url: mcpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    };
  }

  return {
    name: 'deckgauge',
    command: 'npx',
    args: ['-y', 'mcp-remote', mcpUrl, '--header', 'Authorization: Bearer ' + token],
    env: [],
  };
}
