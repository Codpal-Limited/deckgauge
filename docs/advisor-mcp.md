# Deckgauge Advisor MCP server

Deckgauge exposes its "Ask the Advisor" tools as a standard
[Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP-capable
client (Claude Desktop, Claude Code, etc.) can query a board's engineering-intelligence
data directly — no chat UI required. Seven of the eight tools are reads; the eighth,
`propose_board_changes`, can persist a proposal for a human to act on. Nothing behind
`/mcp` can change a board directly — see [Board scoping and access control](#board-scoping-and-access-control)
below for exactly what that one write tool does and does not do.

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
   minimum role on its spec: seven read tools sit at `VIEWER`, and
   `propose_board_changes` sits at `EDITOR`, one floor higher, because it persists
   a row rather than only reading one.
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
3. Calls the tool handler with that scope. Seven of the eight tools only read.
   The eighth, `propose_board_changes`, writes exactly one row — a new
   `advisor_change_sets` proposal, owned by the calling user — and changes no
   board content: no row, group, status, or column is touched by anything
   reachable from `/mcp`. A proposal only becomes a board change when that same
   user later calls `POST /boards/:boardId/advisor/change-sets/:id/apply`, an
   authenticated REST endpoint (not an MCP tool) that re-checks `EDITOR` on the
   board at apply time and refuses anyone but the change-set's creator. There is
   no apply tool on `/mcp` or on any other model-reachable surface — applying is
   a human action, not something the model can trigger for itself. **The tracker
   half of this guarantee is unconditional and unchanged: nothing behind `/mcp`
   writes to Jira, GitHub, ADO, or GitLab, in any tool, at any role. That is an
   invariant of this feature, not a phase of it.**

## Available tools

All eight tools come from the same provider-neutral catalog (`ADVISOR_TOOL_SPECS`)
used by the in-app Advisor chat loop. Every tool takes `boardId` plus the
arguments below. The `Floor` column is each tool's `AdvisorToolSpec.minRole` —
the minimum board role a caller must hold for that specific tool, not a
stack-wide setting — and it is enforced on BOTH surfaces, against the caller's
effective board role from `AccessService.getEffectiveRole`. The two surfaces
enforce it by different mechanisms, because they are shaped differently: `/mcp`
is one long-lived connection whose `boardId` arrives per call, so it resolves the
role per call and REFUSES a tool above the caller's floor
(`forbidden: no edit access to board`); the in-app loop builds its tool set per
request against one already-authorized board, so it simply does not REGISTER a
tool above the caller's floor — a board VIEWER is never offered
`propose_board_changes` and cannot generate a proposal for anyone to apply.

| Tool | Floor | Arguments | Returns |
|---|---|---|---|
| `get_team_overview` | VIEWER | `boardId` (string), `fromDays` (int, 1-365, default 90) | Team KPIs (PRs merged, median cycle time, active devs, AI-assisted %) over the last N days |
| `find_slowdowns` | VIEWER | `boardId` (string), `thresholdPct` (number ≤ 0, default -0.4) | Developers whose merge throughput dropped sharply vs. their own baseline |
| `get_ai_breakdown` | VIEWER | `boardId` (string), `fromDays` (int, 1-365, default 90) | AI-assisted PR share per developer over the last N days |
| `get_ticket_timeline` | VIEWER | `boardId` (string), `ticketKey` (string) | Unified activity timeline (Jira/GitHub/GitLab/ADO) for one ticket key |
| `list_board_rows` | VIEWER | `boardId` (string), `groupId` (string, optional), `statusId` (string, optional), `hasDescription` (boolean, optional), `search` (string, optional), `limit` (int, 1-200, default 50), `cursor` (string, optional) | A page of board rows — name, group, status, owner, assignee, description, Jira key, custom column values — plus `nextCursor` and `totalMatching` |
| `get_board_structure` | VIEWER | `boardId` (string) | The board's groups, statuses and custom columns (with their ids), plus `syncOwnedFields` per connected source |
| `list_excluded_rows` | VIEWER | `boardId` (string) | The board's sync blacklist — rows excluded from re-sync, with source, external id, and who excluded them |
| `propose_board_changes` | EDITOR | `boardId` (string), `ops` (array, 1-50 entries: `create_group{name}`, `move_rows{rowIds,targetGroupId}`, `set_fields{rowIds,patch}` where `patch` is any of `name`/`description`/`statusId`/`owner`) | On success, a `changeSetId`, a row-level `preview`, and `status: "PENDING"` — the board is unchanged. On rejection, `proposed: false` plus which op failed and why. Caps: 500 rows per op, 500 total rows across the whole change-set. |

Each tool returns a single text content block containing a JSON payload (or a JSON
error payload with `isError: true` on unauthorized/forbidden access).

`propose_board_changes` only ever creates a row in `advisor_change_sets`; it does
not touch a board. There is no corresponding apply tool — applying a change-set is
`POST /boards/:boardId/advisor/change-sets/:id/apply`, a normal authenticated REST
call under the caller's own re-verified `EDITOR` role, restricted to the change-set's
own creator. See [Board scoping and access control](#board-scoping-and-access-control)
above.

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
