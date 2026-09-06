# Phase-2 Spike — ACP + MCP client wiring findings

**Date:** 2026-08-04. Spike run inline. Goal: de-risk the ACP client library + Claude/Codex adapter + how a session receives Deckgauge's MCP server, before building the bridge.

## Outcome summary

- **The risky part is de-risked.** The full ACP client/adapter/MCP-config API is pinned against the *installed* packages (versions + exact types below). The plan's biggest unknowns are resolved.
- **The plan's open questions are answered** (client library + connection class, `session/new` MCP-server shape, adapter spawn + auth).
- **Remaining gate for a live end-to-end demo:** a Deckgauge operator token for `/mcp` (a Keycloak JWT). This is *not* an ACP problem — it's local auth provisioning (see "Auth / operator token"). Bounded and well-understood; do it as part of the build's manual smoke.

## Environment (verified live)

- `claude` CLI present (`/opt/homebrew/bin/claude`); `codex` not installed here.
- Phase-1 API running + healthy at `http://localhost:3001` (`/health` → `{"status":"ok"}`).
- `POST /mcp` → **HTTP 401** unauthenticated (the `requireUser` gate works — needs a valid Keycloak JWT).
- node v20.20.2, npx 10.8.2. `ANTHROPIC_API_KEY` unset; no `ant` CLI.

## Confirmed packages + versions

- **ACP client library:** `@zed-industries/agent-client-protocol@0.4.5` (ESM; `dist/acp.js`, types `dist/acp.d.ts`, `dist/schema.d.ts`, `dist/stream.d.ts`).
- **Claude adapter:** `@agentclientprotocol/claude-agent-acp@0.49.0` — `bin: { "claude-agent-acp": "dist/index.js" }`; deps include `@anthropic-ai/claude-agent-sdk` (⇒ uses the developer's Claude auth) + `@agentclientprotocol/sdk` + `zod`.
- **Codex adapter (not installed here):** `@agentclientprotocol/codex-acp` — spawn as `codex-acp` (verify args when a Codex install is available).

## Client API (from `acp.d.ts`)

- The **client** drives the agent via **`ClientSideConnection implements Agent`** (acp.d.ts:166). Key methods:
  - `newSession(params: schema.NewSessionRequest): Promise<schema.NewSessionResponse>` (acp.d.ts:507)
  - `prompt(params: schema.PromptRequest): Promise<schema.PromptResponse>` (acp.d.ts:570)
  - The client also has an `initialize` handshake (version/capabilities) before `newSession`.
- **Receiving streamed output:** the client supplies a handler whose **`sessionUpdate(params: schema.SessionNotification)`** (acp.d.ts:383) is invoked for each `session/update` — assistant message chunks, tool calls, etc. Map: message-chunk update → `onDelta`; tool-call update → `onToolCall`; turn end → `onDone`.
- **Transport wiring:** connect `ClientSideConnection` to the spawned subprocess's `stdin`/`stdout` via the library's stream helpers (`dist/stream.d.ts`). (Confirm the exact helper name when writing `acp-client.ts` — it's a thin stdio↔JSON-RPC bridge.)

## MCP servers on `session/new` — THE key decision

- `NewSessionRequest.mcpServers: McpServer[]` (schema.d.ts:953/1018). `McpServer` (schema.d.ts:207) is a **union of transports**:
  - **Stdio** — "All Agents MUST support this transport" (schema.d.ts:975-977). Shape: `{ name, command, args, env }`.
  - **Http** — capability-gated (agent advertises `mcpCapabilities.http`; schema.d.ts:1159). Shape: `{ name, url, headers }`.
  - **Sse** — capability-gated (schema.d.ts:1163).
- **Decision (resolves plan Task 3):** use a **Stdio** MCP-server entry that runs **`mcp-remote`** to proxy to Deckgauge's HTTP `/mcp`, since Stdio is universally supported and avoids depending on the agent's optional HTTP-MCP capability:
  ```
  { name: 'deckgauge', command: 'npx',
    args: ['-y', 'mcp-remote', 'http://localhost:3001/mcp',
           '--header', 'Authorization: Bearer ' + token] }
  ```
  (Optionally prefer an `Http` entry `{ name, url, headers: { Authorization } }` when the agent's `initialize` response advertises `mcpCapabilities.http` — a small optimization; the Stdio+mcp-remote path is the reliable default.)

## Adapter spawn + auth

- Claude: spawn **`npx claude-agent-acp`** (or `node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`). It authenticates via `@anthropic-ai/claude-agent-sdk`, which resolves the developer's existing Claude credentials (Claude Code login / OAuth profile / `ANTHROPIC_API_KEY`). **Verify at build time** that in a plain shell (no `ANTHROPIC_API_KEY`) it picks up the Claude Code login — if it requires an explicit key, document that in the CLI's setup notes.
- Codex: spawn `codex-acp` (verify args/auth against a real Codex install in Task 2).

## Auth / operator token (remaining live-proof gate)

- `/mcp` needs `request.user`, set only from a **valid Keycloak JWT** (`keycloak-auth.plugin.ts:24-37`). Realm = `deckgauge`. The realm export seeds **no user and no direct-grant client**, so a token can't be minted by a simple password grant out of the box.
- **To mint a local token** (build-time manual smoke): use the Keycloak admin API (`admin/admin` at `:8080`) to create a test user + enable direct-access-grants on a client (or reuse the web app's login to copy a Bearer token from the browser session). Then the bridge passes it via the `mcp-remote --header` above. Keep this zero-friction: the bridge reads `DECKGAUGE_TOKEN` from env; the CLI docs the one-time token step. (This matches the Phase-1 doc's "external clients need a browser-obtained token" note.)
- The `BoardAccess` check still applies: the token's user must have ≥ VIEWER on the board the tool call targets.

## Impact on the plan

- Task 2 (adapters): `CLAUDE_AGENT` spawn = `npx claude-agent-acp`; `CODEX_AGENT` = `codex-acp` (verify).
- Task 3 (mcp-config): implement the **Stdio + `mcp-remote`** entry above (not a raw HTTP entry) as the default.
- Task 4 (acp-client): use `ClientSideConnection` + the stdio stream helper; map `sessionUpdate` variants to `onDelta`/`onToolCall`/`onDone`.
- Task 7/9 (CLI/docs): document the one-time `DECKGAUGE_TOKEN` step and the Claude-auth expectation.

## Not yet demonstrated

A full live "agent calls a Deckgauge board tool and answers" run was **not** completed inline, gated only on the Keycloak operator token provisioning (above). All ACP-side risk is retired; recommend completing the live smoke during Task 7 once a token is minted.
