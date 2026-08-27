# Deckgauge Advisor MCP server

Deckgauge exposes its read-only "Ask the Advisor" tools as a standard
[Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP-capable
client (Claude Desktop, Claude Code, etc.) can query a board's engineering-intelligence
data directly — no chat UI required.

This doc covers the server-side MCP endpoint itself. If what you want is the
in-app Advisor panel driving your own local Claude Code or Codex against these
same tools, that's the host-side bridge — see
[`advisor-local-agent.md`](./advisor-local-agent.md).

## Endpoint

The MCP server is mounted at `/mcp` on the Deckgauge API, using the
[Streamable HTTP](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http)
transport (`POST`/`GET /mcp`). Running the stack from this repo's
`docker-compose.yml`, the API listens on port `3001`, so the endpoint is:

```
http://localhost:3001/mcp
```

If you've mapped the API to a different port, substitute it.

## Authentication

**A request to `/mcp` without an authenticated user gets `401 Unauthorized`.**
The route is registered inside the API's authenticated route group and enforces
the check on every call — there is no anonymous mode and no way to opt out.

To call `/mcp`, send a valid Keycloak-issued JWT as a bearer token:

```
Authorization: Bearer <token>
```

This is the same JWT the web app obtains via its NextAuth ↔ Keycloak OIDC login
flow (see `keycloak/realm-export.json` for the realm and client). Minting a token
for a non-browser MCP client without going through the web login flow (e.g. a
scripted token exchange) isn't wired up — external clients need a token obtained
from an authenticated browser session against your Keycloak.

That ergonomics gap is exactly what the
[local-agent bridge](./advisor-local-agent.md) removes for the in-app Advisor:
the panel hands the bridge your existing session token automatically, so you
never mint one by hand.

## Board scoping and access control

Every tool call is scoped to exactly one board and takes a required `boardId`
argument. On each call the server:

1. Confirms the authenticated user meets the tool's minimum board role via
   `AccessService.getEffectiveRole('board', boardId, userId, membership)` and
   `meetsBoardRole` — resolved fresh per call from the database, never cached and
   never assumed from a prior call in the same session. Each tool declares its own
   minimum role on its spec; all seven tools available today sit at `VIEWER`.
   `getEffectiveRole` honours the same implicit-ownership rule every other board
   route does — an organization ADMIN is an implicit OWNER of every board in
   their organization and holds no grant row for it — but resolves the board
   through the caller's own organization, so a board belonging to another
   tenant answers "no role" rather than inheriting that implicit-owner rule. A
   user who doesn't meet the minimum gets a tool error (`forbidden: no access
   to board`), not board data.
2. Builds the board's data scope itself server-side (`getBoardScope`) from the
   board's connected Jira/GitHub/ADO/GitLab sources. The scope is never a tool
   input — a client cannot ask the tool to look outside the board it was granted
   access to.
3. Calls the read-only tool handler with that scope. Nothing behind `/mcp` writes
   to the database, Jira, GitHub, ADO, or GitLab.

## Available tools

All seven tools come from the same provider-neutral catalog (`ADVISOR_TOOL_SPECS`)
used by the in-app Advisor chat loop, so behavior is identical between the two
surfaces. Every tool takes `boardId` plus the arguments below.

| Tool | Arguments | Returns |
|---|---|---|
| `get_team_overview` | `boardId` (string), `fromDays` (int, 1-365, default 90) | Team KPIs (PRs merged, median cycle time, active devs, AI-assisted %) over the last N days |
| `find_slowdowns` | `boardId` (string), `thresholdPct` (number ≤ 0, default -0.4) | Developers whose merge throughput dropped sharply vs. their own baseline |
| `get_ai_breakdown` | `boardId` (string), `fromDays` (int, 1-365, default 90) | AI-assisted PR share per developer over the last N days |
| `get_ticket_timeline` | `boardId` (string), `ticketKey` (string) | Unified activity timeline (Jira/GitHub/GitLab/ADO) for one ticket key |
| `list_board_rows` | `boardId` (string), `groupId` (string, optional), `statusId` (string, optional), `hasDescription` (boolean, optional), `search` (string, optional), `limit` (int, 1-200, default 50), `cursor` (string, optional) | A page of board rows — name, group, status, owner, assignee, description, Jira key, custom column values — plus `nextCursor` and `totalMatching` |
| `get_board_structure` | `boardId` (string) | The board's groups, statuses and custom columns (with their ids), plus `syncOwnedFields` per connected source |
| `list_excluded_rows` | `boardId` (string) | The board's sync blacklist — rows excluded from re-sync, with source, external id, and who excluded them |

Each tool returns a single text content block containing a JSON payload (or a JSON
error payload with `isError: true` on unauthorized/forbidden access).

## Example: Claude Desktop config

Claude Desktop's `claude_desktop_config.json` (or Claude Code's
`.mcp.json`) can point at the endpoint like this. `mcp-remote` bridges Claude
Desktop's stdio-based MCP client to Deckgauge's HTTP transport and lets you attach
the bearer token as a header:

```json
{
  "mcpServers": {
    "deckgauge": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:3001/mcp",
        "--header",
        "Authorization: Bearer ${DECKGAUGE_TOKEN}"
      ],
      "env": {
        "DECKGAUGE_TOKEN": "<paste a Keycloak JWT here>"
      }
    }
  }
}
```

Once connected, ask the assistant something like "Using the deckgauge tools, give
me the team overview for board `<your board id>` over the last 30 days" — the
client will call `get_team_overview` with `boardId` and `fromDays` set accordingly.
