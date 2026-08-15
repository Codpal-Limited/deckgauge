/**
 * A one-request health check against Deckgauge's `/mcp` before the bridge
 * opens an ACP session with the operator's token.
 *
 * Why this exists: nothing downstream reports an unusable token. The agent is
 * handed an MCP server entry and told to connect; if that connection 401s, the
 * agent simply ends up with no `deckgauge` tools and answers the operator's
 * board question from whatever else it can reach. Meanwhile the bridge had
 * already replied `authenticated` and the panel was showing "Connected to your
 * local Claude Code — ready". Connected-looking and board-blind is the worst
 * of both: no error to act on, and answers that aren't grounded in board data.
 *
 * So the bridge asks `/mcp` itself, first, with the same token, and refuses to
 * report success unless real tools come back.
 */

export interface PreflightDeckgaugeMcpOptions {
  /** Deckgauge's MCP endpoint, e.g. `http://localhost:3001/mcp`. */
  mcpUrl: string;
  /** The operator token the ACP session would carry. */
  token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests; defaults to `PREFLIGHT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * How long to wait for `/mcp` before giving up.
 *
 * This check gates every `authenticate()`, and an API that accepts the socket
 * but never answers (this stack has done exactly that under a Node heap OOM)
 * would otherwise leave the call pending forever: the panel's initial
 * handshake is bounded only by its own 30s deadline, and a re-authentication
 * on token rotation has no deadline at all, so each rotation would stack
 * another permanently-pending call.
 */
const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * `/mcp` is stateless (`sessionIdGenerator: undefined`, a fresh server per
 * request — see `apps/api/src/mcp/mcp.server.ts`), so a bare `tools/list` is a
 * complete, valid request on its own: no `initialize` round-trip, no session
 * id to carry.
 */
const TOOLS_LIST_REQUEST = { jsonrpc: '2.0', id: 1, method: 'tools/list' } as const;

const UNAUTHORIZED_MESSAGE =
  "Deckgauge rejected the bridge's token. Make sure you're signed in to Deckgauge in the " +
  'browser tab with the Advisor panel open, and that your user has at least VIEWER board access.';

interface JsonRpcToolsListReply {
  result?: { tools?: { name?: unknown }[] };
  error?: { message?: unknown };
}

/**
 * Pulls the JSON-RPC payload out of a `/mcp` reply. Streamable HTTP answers
 * either as `text/event-stream` (`event: message` + `data: {...}` lines) or as
 * plain JSON, depending on the client's `Accept`, so handle both rather than
 * betting on one.
 */
function parseReplyBody(body: string): JsonRpcToolsListReply | null {
  const trimmed = body.trim();
  if (trimmed === '') {
    return null;
  }

  const payloads = trimmed.startsWith('{')
    ? [trimmed]
    : trimmed
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim());

  for (const payload of payloads) {
    try {
      return JSON.parse(payload) as JsonRpcToolsListReply;
    } catch {
      continue;
    }
  }
  return null;
}

function extractToolNames(reply: JsonRpcToolsListReply): string[] {
  const tools = reply.result?.tools ?? [];
  return tools
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/**
 * Resolves with the tool names `/mcp` published for this token. Rejects with a
 * message written for the operator — it reaches them verbatim, as the bridge's
 * `error` frame — whenever the endpoint is unreachable, the token is refused,
 * or the connection succeeds but exposes no tools.
 */
export async function preflightDeckgaugeMcp(
  opts: PreflightDeckgaugeMcpOptions
): Promise<string[]> {
  const { mcpUrl, token, fetchImpl = fetch, timeoutMs = PREFLIGHT_TIMEOUT_MS } = opts;

  let response: Response;
  try {
    response = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both types are required: the MCP SDK's streamable-HTTP transport
        // answers 406 unless the client accepts `application/json` AND
        // `text/event-stream`. Don't "tidy" this down to one — every preflight
        // would start failing, disabling working bridges.
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TOOLS_LIST_REQUEST),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `Deckgauge's MCP endpoint at ${mcpUrl} did not answer within ${timeoutMs}ms. ` +
          'Is the API healthy?'
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach Deckgauge's MCP endpoint at ${mcpUrl} (${detail}). ` +
        'Is the API running?'
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(UNAUTHORIZED_MESSAGE);
  }
  if (!response.ok) {
    throw new Error(`Deckgauge's MCP endpoint at ${mcpUrl} answered ${response.status}.`);
  }

  const reply = parseReplyBody(await response.text());
  if (!reply) {
    throw new Error(`Unexpected reply from Deckgauge's MCP endpoint at ${mcpUrl}.`);
  }
  if (reply.error) {
    const detail =
      typeof reply.error.message === 'string' ? reply.error.message : 'unknown MCP error';
    throw new Error(`Deckgauge's MCP endpoint returned an error: ${detail}`);
  }

  const toolNames = extractToolNames(reply);
  if (toolNames.length === 0) {
    throw new Error(
      `Connected to Deckgauge's MCP endpoint at ${mcpUrl}, but it published no tools — ` +
        'the local agent would have no way to read board data.'
    );
  }
  return toolNames;
}
