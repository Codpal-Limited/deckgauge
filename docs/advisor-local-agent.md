# Deckgauge Advisor local-agent bridge

If you have [Claude Code](https://docs.claude.com/en/docs/claude-code) or
[Codex](https://github.com/openai/codex) installed and signed in on your machine,
Deckgauge's Advisor panel can drive that local agent to answer board questions
directly — no API key, no model config, no separate LLM bill. The agent reaches
board data through the same board-scoped [`/mcp` tools](./advisor-mcp.md) that
any external MCP client would use; this bridge just wires your local agent up to
them and gives the in-app panel a "Local agent" mode. Seven of those tools are
reads; the eighth can propose a batch of board changes for the user to approve,
but nothing reachable through `/mcp` — from this bridge or any other client —
can apply one. See [Security model](#security-model) below for what that means
for a local agent driven this way.

It is the host-side companion to the server-side `/mcp` endpoint documented in
[`advisor-mcp.md`](./advisor-mcp.md).
Read that doc first if you want the details of the tools themselves — the
engineering-intelligence reads (`get_team_overview`, `find_slowdowns`,
`get_ai_breakdown`, `get_ticket_timeline`), the board-content reads
(`list_board_rows`, `get_board_structure`, `list_excluded_rows`), and the one
proposal tool (`propose_board_changes`) — and the board-access contract; this
doc covers the bridge that lets your own local agent call them from inside the
Advisor panel.

## What it is

`apps/advisor-bridge` (published as `@deckgauge/advisor-bridge`) is a small
host-side process — not part of the web app or API — that:

1. Detects whether you actually have a supported local coding agent — Claude
   Code or Codex — and which of the two to drive.
2. Spawns that adapter and opens an [Agent Client Protocol](https://agentclientprotocol.com)
   (ACP) session with it, declaring Deckgauge's `/mcp` server as a client MCP
   tool source for that session.
3. Listens on a localhost WebSocket that the web app's Advisor panel connects
   to, so questions typed into the panel get routed to your local agent
   instead of (or in addition to) the existing provider-based chat loop.

Your model credentials never touch Deckgauge: the agent you're driving is
*your own* already-authenticated Claude Code or Codex session, running on your
machine, under your login.

## The flow (zero-config)

1. **Install and sign in** to Claude Code or Codex, as you normally would for
   any other project.
2. **Run the bridge.** If you're running the app with `pnpm dev`, this already
   happened — `pnpm dev` is `turbo run dev` and this package has a `dev`
   script, so the bridge starts alongside web/api/worker. To run just the
   bridge in the foreground:

   ```bash
   pnpm deckgauge:advisor
   ```

   It detects your local agent, spawns its ACP adapter, and starts listening
   on `127.0.0.1:4779`. You'll see lines like:

   ```
   No DECKGAUGE_TOKEN set — waiting for the Advisor panel to authenticate this bridge with your browser session. Open a board's advisor panel while signed in to Deckgauge. Set DECKGAUGE_TOKEN instead if you want the bridge to run headless, with no browser required.
   Detected Claude Code — bridge listening on 127.0.0.1:4779. Open a board's advisor panel and pick "Local agent".
   ```

3. **Sign in to Deckgauge and open a board's Advisor panel.** There's no
   separate login step for the bridge itself — the panel authenticates it
   automatically using the same NextAuth/Keycloak access token your browser
   session already has (see [Auth](#auth--the-operator-token) below). Once
   that handshake completes you'll see:

   ```
   Connected to your local Claude Code — ready
   ```

   From here, every question you ask in the panel is routed to your local
   agent instead of the panel's built-in provider flow.

Before reporting success, the bridge checks that the token it was just handed
can actually reach the board tools — it asks `/mcp` for its tool list itself.
If that check fails (not signed in, token expired, no board access, API down)
you get the reason as an error and the panel falls back to the provider flow,
rather than a panel that says "Connected" while the agent quietly has no board
data behind it.

If the bridge isn't running, isn't reachable within ~1.5s, has no signed-in
Deckgauge session to authenticate with, or fails that `/mcp` check, the panel
falls back to its existing provider-based flow automatically and shows a
one-line hint instead:

```
Run pnpm deckgauge:advisor to use your local Claude Code
```

Nothing else about the panel changes in that case — it behaves exactly as it
does with no bridge installed at all.

## Running it next to the Docker stack

The bridge is the one piece of Deckgauge that **cannot** be a container. It
spawns your local ACP adapter, which authenticates as your own signed-in
Claude Code / Codex session — a container has neither the adapter binary nor
that login. So when the rest of Deckgauge runs in Docker, the bridge runs on
the host beside it:

```bash
pnpm deckgauge:advisor      # foreground — what you want while developing
```

To run it detached instead:

```bash
pnpm advisor:start          # detaches, waits for readiness, reports the agent
pnpm advisor:status
pnpm advisor:stop
```

These wrap `scripts/advisor-bridge.sh`, which keeps its PID in
`.advisor-bridge.pid` and its output in `.advisor-bridge.log` (both
gitignored). `start` is idempotent — if something is already listening on the
port it leaves it alone rather than racing it — and it waits for the bridge to
actually serve before reporting success, tailing the log if it doesn't.

`stop` takes down whatever holds the port, which is what you mean by "stop" even
if that bridge was started some other way. It needs `lsof` to find that process;
without it, it can only signal the PID it recorded and will tell you so rather
than claim success.

### Starting it from a deploy step

`ADVISOR_BRIDGE_AUTOSTART` is a convention for whatever *calls* the script — the
script itself always starts the bridge when invoked. Deckgauge's own deploy step
checks the variable and starts the bridge unless it is `false`:

```bash
ADVISOR_BRIDGE_AUTOSTART=false
```

It's on by default there. Opt-in was the original choice, on the reasoning that
launching a local agent process shouldn't happen by surprise — but the practical
effect was that every deploy left the bridge down, so the Advisor fell back to
the server-side provider flow and asked for an API key, which is the opposite of
the intended default. Startup being idempotent means re-arming it can't race a
bridge you're already running, and a failure can't break the deploy, since the
app works fine without it. If you wire your own pipeline, that's the behaviour
worth copying.

What a deploy starts is the bridge process itself. With `DECKGAUGE_TOKEN`
unset — the default — no agent is launched until the Advisor panel connects and
authenticates; set `DECKGAUGE_TOKEN` and the ACP adapter spawns at startup with
no browser involved.

## The other way to configure the Advisor: a server-side provider

The bridge is one of two independent ways the Advisor gets a model. The other
is a server-side provider — an Anthropic key or an Ollama server — which the
API uses for its own SSE chat flow whenever no bridge is running. Configure it
either in **Settings → Advisor**, or declaratively in `.env`:

| Variable | Purpose |
|---|---|
| `ADVISOR_PROVIDER` | `anthropic` or `ollama`. Blank ⇒ no server-side provider. |
| `ADVISOR_MODEL` | e.g. `claude-haiku-4-5`, `llama3.2`. |
| `ADVISOR_ANTHROPIC_API_KEY` | Anthropic only. |
| `ADVISOR_OLLAMA_BASE_URL` | Ollama only; must include the `http://` scheme. |

A config saved through the settings UI wins over these variables — env is the
deployment default, the UI is the operator's override. An incomplete or
invalid env config is treated as "no provider" rather than half-applied, and
the API logs a warning at boot naming what to check, so a typo is loud instead
of silent.

With neither a provider nor a bridge, asking a question shows a message
explaining that no model is configured, with a link to the settings page.

## Config (env)

The bridge reads its entire configuration from environment variables. It also
picks these same variables up from the repo's `.env` — searching upward from
its own location, so it finds the file whichever directory you started it from
— and a variable already set in your shell always wins over the file. Only the
variables in the table below are taken from `.env`, never the rest of it: the
bridge spawns your local agent as a child process, which inherits its
environment, and that agent has no business seeing the stack's `DATABASE_URL`
or Keycloak client secret.

| Variable | Default | Purpose |
|---|---|---|
| `DECKGAUGE_API_URL` | `http://localhost:3001` | Base URL of the Deckgauge API. The bridge appends `/mcp` itself. |
| `DECKGAUGE_TOKEN` | *(none)* | Optional. Runs the bridge headless, with no browser involved — otherwise the Advisor panel authenticates it automatically with your Deckgauge login. See below. |
| `ADVISOR_BRIDGE_PORT` | `4779` | Localhost port the bridge's WebSocket server listens on. |
| `ADVISOR_PREFER` | *(none)* | `claude` or `codex` — tries that agent first when both are set up. It orders the candidates; it cannot select an agent you don't have. |
| `ADVISOR_AGENT` | *(none)* | `claude` or `codex` — selects that agent outright, skipping the check for whether this machine looks like it has one. The escape hatch for a machine detection reads wrong. |
| `ADVISOR_ALLOWED_ORIGINS` | *(none — any loopback origin)* | Comma-separated list of `Origin` headers the bridge's WebSocket server accepts a handshake from. Unset, it accepts any loopback origin (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) on **any** port, so the Advisor works whatever port you publish the web app on. A non-empty list **replaces** that rule with exactly those origins — the way to pin the bridge, or to allow a LAN hostname you browse from (include your local origin too if you still use it). See [Security model](#security-model). |

The bridge prints the policy in force at startup (`Origin policy: …`), and logs
a line naming any handshake it turns away — worth knowing about, because that
rejection is otherwise completely mute on the browser side (see
[Troubleshooting](#troubleshooting)).

`DECKGAUGE_TOKEN` is optional, not required — that's the default, zero-config
path. Leave it unset and the bridge starts, detects the agent, and waits for
the Advisor panel to authenticate it with your own Deckgauge login. Set it
only if you want the bridge to run with no browser involved at all (e.g. as a
background service); board tool calls are unauthorized until either that env
var is set or the panel has authenticated the connection.

If `ADVISOR_BRIDGE_PORT`'s port is already taken (e.g. another bridge
instance is already running), the CLI prints an error naming the conflict and
exits non-zero rather than binding silently to something else.

## Auth / the operator token

The bridge itself never handles your model credentials — the local agent you
run it against uses **your own existing Claude Code or Codex login**, exactly
as if you'd started that agent yourself outside of Deckgauge.

What the bridge *does* need, separately, is a Deckgauge **operator token** — a
Keycloak JWT (realm `deckgauge`) so the agent's calls to `/mcp` can be
authenticated — but by default you never mint one by hand. **The Advisor
panel supplies it automatically**: once you're signed in to Deckgauge in your
browser, `useLocalBridge` sends your own NextAuth/Keycloak access token to the
bridge right after it connects (the `authenticate` message described in
[How it works](#how-it-works-architecture)), and the bridge uses it for every
subsequent `/mcp` tool call. No admin API, no test user, no copying a bearer
token out of devtools.

Whichever user that token belongs to needs at least **VIEWER** access on any
board you ask the advisor about — the `/mcp` tools re-resolve that user's
effective board role fresh on every single call, not just once at connection
time, so a token whose user loses (or never had) board access simply gets a
forbidden tool error instead of data. See the [security model](#security-model)
below for how that role is resolved and why it is not a grant-row lookup.

**Running the bridge with no browser at all** (a background service, CI, a
headless box) needs `DECKGAUGE_TOKEN` set instead, since there's no browser
session to supply one. Since the `deckgauge` realm seeds no direct-grant user
out of the box, there isn't yet a one-command way to mint that token — get one
by minting it directly against the Keycloak admin API (`:8080`): create a test
user, enable direct-access grants on a client, then request a token for that
user.

## Security model

This is the part worth reading closely if you're wondering what letting a
local agent drive Deckgauge questions actually exposes:

1. **Board data access is board-scoped, and the bridge adds no new path to
   it — including the one path that isn't a plain read.** The agent can only
   reach Deckgauge data through the `/mcp` tools — the exact same server-side
   tools documented in [`docs/advisor-mcp.md`](./advisor-mcp.md). Every call
   re-resolves the calling token's effective role on the named board —
   `AccessService.getEffectiveRole` gated by `meetsBoardRole`, fresh per call,
   never cached and never inherited from an earlier call in the same session —
   and each tool declares its own minimum role: seven sit at `VIEWER`, and
   `propose_board_changes` sits at `EDITOR`. Deliberately not a `BoardAccess`
   grant-row check: the resolver reads the board *through* the caller's
   organization, so a board in another tenant answers "no role" rather than
   inheriting any implicit ownership, while an organization ADMIN — an implicit
   owner of every board in their own organization, holding no grant row — is
   correctly admitted. The board's data scope is then built server-side; it is
   never something the agent (or the bridge) can supply as input.

   `propose_board_changes` is the one tool that writes anything, and what it
   writes is narrow: one row in `advisor_change_sets`, owned by the token's own
   user, carrying a preview. It does not touch a board — no row, group,
   status, or column changes as a result of calling it. Applying that proposal
   is a separate, authenticated REST call
   (`POST /boards/:boardId/advisor/change-sets/:id/apply`) outside `/mcp`
   entirely, gated at `EDITOR` again and restricted to the change-set's own
   creator — there is no apply tool for the agent to call, on this bridge or
   any other MCP client, so an agent driven through this bridge can propose a
   change but cannot make one happen. **Nothing behind `/mcp` writes to Jira,
   GitHub, ADO, or GitLab — that remains true without qualification, for every
   tool, at every role.** The bridge is a wire — it doesn't add a second,
   looser data path alongside `/mcp`, and it doesn't add a path to apply either.
2. **The bridge is localhost-only.** It binds `127.0.0.1` exclusively and is
   never exposed as a network service. It's a local developer companion
   process you run next to `pnpm dev`, not something reachable from another
   machine. The bridge's WebSocket server also only accepts handshakes whose
   `Origin` header (browsers set this on every WS connection and page JS
   can't forge it) passes an origin check — by default any origin served from
   your own loopback interface, on any port — so a malicious page you happen
   to have open in the same browser can't drive-by connect to the bridge and
   read board answers. That default is deliberately about *your machine*
   rather than one port: pinning it to `:3000` silently disabled the Advisor
   for anyone self-hosting the web app on a different port. The trade-off is
   that it does not distinguish between things served from your own loopback
   interface — if you want the bridge pinned to exactly one origin, set
   `ADVISOR_ALLOWED_ORIGINS`, which replaces the loopback rule outright.
   Note the allowlist deliberately accepts a handshake with *no* `Origin`
   header at all (that's how non-browser clients connect), so it is not a
   defence against another **local process**: one can connect, send its own
   `authenticate` frame to displace the token the panel installed, or issue
   `ask` calls that ride the token already there.

   **The token no longer reaches the process table on the Claude Code path.**
   It used to: the bridge proxied `/mcp` through `mcp-remote`, passing the
   token as a command-line argument (`--header 'Authorization: Bearer …'`),
   readable by any other user on the host via `ps`. That mattered a lot on the
   browser-auth path, where the token is your **live session JWT** —
   authenticating as you against the *whole* API, not just `/mcp`.

   The size of that exposure is the token's own lifetime, and it used to be a
   day: the `deckgauge-web` CLIENT pinned `"access.token.lifespan": "86400"`
   (24h), overriding the realm. That override is gone — the client now inherits
   the realm's ~5 minutes — which narrows the window sharply but does not close
   it, and does nothing for the `stdio` path described below.

   **How a rotation reaches a live agent.** With the 5-minute token, NextAuth
   mints a new one every few minutes while the panel is open, and
   `useLocalBridge` re-sends `authenticate` on each change — it must, because
   the agent carries the token on every `/mcp` call. Two things keep that from
   disturbing the session:

   - **It is applied lazily**, just before the next `ask()`, so a panel left
     open costs nothing and a turn already streaming is never interrupted.
     Several rotations during a quiet spell collapse into one.
   - **It is applied in place** when the agent advertises the `loadSession`
     capability: `session/load` restores the conversation AND connects to the
     `mcpServers` the request carries, so the credential swaps while the
     conversation survives.

   Both adapters this package pins advertise `loadSession: true` — grepped from
   the installed builds of `@agentclientprotocol/claude-agent-acp` 0.49.0 and
   `@agentclientprotocol/codex-acp` 1.1.9, so treat it as true of these pinned
   versions rather than as a guarantee about either agent.

   **"In place" means the adapter SUBPROCESS survives, not that nothing is
   rebuilt.** On the pinned Claude adapter a session is fingerprinted as
   `JSON.stringify({ cwd, mcpServers })`, and the token lives inside
   `mcpServers` — so a rotation always changes the fingerprint, and the adapter
   always tears its session down and recreates it with `resume:`. The
   conversation survives because of that `resume:`, and two things follow that
   are easy to get wrong:

   - The recreated session comes back in the ADAPTER'S default mode, so the
     bridge re-asserts `CLIENT_DECIDES_MODE_ID` after every reload. Without
     that, the agent would approve its own tool calls from the first rotation
     onward and the destructive-tool deny policy would never be consulted again.
   - A prompt sent while the reload is in flight would land on a session
     mid-teardown, so the bridge serialises the two: an `ask` joins an in-flight
     swap instead of racing it.

   An agent WITHOUT it still needs a replacement session, and there the
   conversation is lost — but only on the first question after a rotation, never
   mid-answer. That fallback is the DEFAULT in the bridge's own test fakes, so it
   stays exercised rather than rotting. If you are debugging an advisor session
   that has forgotten its context, check whether your agent advertises
   `loadSession`.

   Agents that advertise the http MCP transport (Claude Code's adapter does)
   now hold the `/mcp` connection themselves, with the token as a real request
   header, so nothing lands in argv. The `mcp-remote` stdio fallback remains
   for agents without http support, and on **that** path the argv exposure is
   unchanged. The bridge prints which transport a session got
   (`MCP transport: http …` / `… stdio via mcp-remote …`) when it authenticates,
   so you can tell from its output which case you're in.

   **On a shared or multi-user machine, don't run the bridge at all.** Closing
   the argv leak on the http path narrows the exposure; it doesn't make a
   multi-user host safe. The bridge is a localhost developer companion that
   drives an agent authenticated as you.
3. **Destructive local tool calls are denied, not just unprompted — and this
   is the guard that actually closes off the write path, now that one
   exists.** Running this bridge means the local agent answers headlessly —
   there's no interactive terminal for it to ask "may I run this?". So the
   bridge itself answers every ACP permission request on the agent's behalf:
   it auto-approves non-destructive tool calls (read/search/fetch — including
   every Deckgauge MCP call, `propose_board_changes` among them, since from
   the ACP classifier's point of view a remote MCP call is not a local file
   edit or shell execution), so the agent can actually gather evidence,
   propose a change, and answer. But it auto-**denies** any tool call
   classified as destructive (`edit`, `delete`, `move`, or `execute` — i.e.
   local file writes/deletes/moves or shell execution). Driving your local
   agent through this bridge will not let it silently edit or delete files, or
   run shell commands, on your machine.

   This deny is more load-bearing than it used to be. Before a write path
   existed at all, denying `execute` only protected the developer's own
   filesystem. Now the bridge hands the agent the user's live Deckgauge
   session token (see [Auth](#auth--the-operator-token) above) for every
   `/mcp` call — and that token authenticates against the *whole* API, not
   just `/mcp`. If the agent could run a shell command, it would not need
   `propose_board_changes` or the apply endpoint's own `EDITOR` re-check at
   all: it could simply `curl` the board's REST API directly with that same
   token and write to the board itself, walking straight past the proposal
   gate this feature exists to enforce. The `execute` deny is what stands
   between "the agent can only ever propose, never apply" and "the agent can
   silently do anything the token's user is authorized to do." It is the
   single point closing that bypass — not the tool catalog, not the `EDITOR`
   floor on `propose_board_changes`, both of which a shell-capable agent could
   simply route around.

   For that policy to be the one in force, the bridge asks for the session
   mode where the **client** decides permissions. Claude Code's adapter opens
   sessions in `auto` mode, where its own model classifier approves or denies
   tool calls — which bypasses the policy above entirely, since the bridge is
   never consulted. The bridge moves the session to `default` mode, which
   routes those decisions back to it. If an agent offers no such mode, or
   refuses the switch, the bridge says so on stderr rather than pretending its
   deny policy applies.

4. **The session runs in a scratch directory, not your checkout.** ACP sessions
   take a working directory, and it used to be wherever you started the bridge
   — in practice the Deckgauge repo. A local agent treats its working directory
   as context: it reads files there and picks up project-level agent
   configuration. But the advisor's subject is board data reached through
   `/mcp`, not your source tree, so the session opens in a fresh empty
   directory under the system temp dir instead — created with `mkdtemp`, so the
   path can't be pre-created and seeded with a `CLAUDE.md` or
   `.claude/settings.json` by another local user.

   This narrows *context*, not capability. The agent is still your full local
   Claude Code or Codex: it ships file-edit, shell, and web-fetch tools, and
   loads your user-level MCP servers, whatever directory it stands in. That is
   what the permission policy in (3) is for, and it is the reason to run this
   only against an agent you'd trust on your own machine anyway.

## How it works (architecture)

`apps/advisor-bridge` is an [ACP](https://agentclientprotocol.com) **client**:

- **Agent detection** (`acp/agent-adapter.ts`) requires two things of a
  candidate, and picks the first that satisfies both:

  1. Its ACP adapter is runnable — `claude-agent-acp` (from
     `@agentclientprotocol/claude-agent-acp`) or `codex-acp` (from
     `@agentclientprotocol/codex-acp`), on `PATH` or in a local
     `node_modules/.bin`.
  2. There is evidence you actually have that agent: its own CLI (`claude`,
     `codex`) on `PATH`, or the config it writes on first use (`~/.claude`,
     `~/.claude.json`, `~/.codex`).

  The second check is not optional bookkeeping. Both adapters are ordinary
  dependencies of this package, so `pnpm install` puts *both* bins on every
  machine — keying detection on the adapter alone reported "Detected Claude
  Code" for everyone, handed Codex users the wrong adapter, and turned "no
  local agent found" into an error nobody could ever see. It is a heuristic
  about your machine, not proof of a valid login: only driving the agent
  proves that.
- **The ACP client** (`acp/acp-client.ts`) spawns the detected adapter's
  resolved binary as a subprocess, wires an ACP connection over its
  stdio, and drives the `initialize` → `session/new` → `session/prompt`
  handshake. `session/new` declares Deckgauge's `/mcp` server as one of the
  session's MCP servers.
- **The MCP config** (`mcp-config.ts`) is an **http** entry pointing straight
  at Deckgauge's `/mcp`, with the operator's token as an `Authorization`
  header, whenever the agent advertises `mcpCapabilities.http` on `initialize`
  (Claude Code's adapter does). Agents without it get the old stdio entry that
  shells out to [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) to
  proxy their stdio MCP client onto the HTTP endpoint.

  The stdio hop was the default until it turned out to fail badly: given a
  token the API rejects, `mcp-remote` reads the 401 as "this server wants
  OAuth", discards the `Authorization` header it was handed, attempts dynamic
  client registration against the API, and exits fatally. The agent was left
  with no `deckgauge` tools and no error to report — while the panel showed
  "Connected". Going direct also drops an `npx` package download from the
  connect path (which is why the panel needed a 30s authenticate deadline) and
  keeps the token out of argv.
- **The `/mcp` preflight** (`mcp-preflight.ts`) is what makes an unusable token
  loud. Before any session opens, the bridge POSTs a `tools/list` to `/mcp`
  with the token and requires real tools back; 401/403, an unreachable API, or
  an empty tool list all become an operator-readable error. `/mcp` is stateless
  (a fresh server per request), so a bare `tools/list` is a complete request —
  no `initialize` round-trip needed.
- **`AdvisorBridge`** (`bridge.ts`) ties detection + the ACP client together
  into one session lifecycle: `start()` detects the agent (and authenticates
  immediately if `DECKGAUGE_TOKEN` was set); `authenticate(token)` preflights
  the token, then starts — or, for a different token, restarts — the ACP
  session using it; `ask()` / `stop()` round out the lifecycle. A token that
  fails preflight leaves any session already running untouched.
- **The WebSocket server** (`ws-server.ts`) is what the web app talks to. It
  listens on `127.0.0.1:<ADVISOR_BRIDGE_PORT>`, sends a `ready` frame with the
  detected agent's display name on connect, then accepts a
  `{ type: "authenticate", token }` message — forwarded to
  `AdvisorBridge.authenticate()` — replying `{ type: "authenticated" }` on
  success or `{ type: "error", message }` on failure. Once authenticated, it
  turns each `{ type: "ask", boardId, question, widgetType }` message into a
  prompt for the agent, streaming back `delta` / `toolCall` / `done` /
  `error` frames as the agent answers.
- **The panel side** (`apps/web/components/advisor/useLocalBridge.ts`) opens
  that WebSocket on mount and, once `ready` arrives, sends your Deckgauge
  session's own access token (from NextAuth's `useSession()`) as an
  `authenticate` message — only once that's confirmed does it report
  `'ready'` to `AdvisorPanel`. It re-sends whenever NextAuth rotates that
  token, since the bridge holds whichever token it was given for the life of
  its session and the agent carries it on every `/mcp` call — without the
  re-send, board tools start 401ing partway through a session that still looks
  connected. If a refreshed token is refused, the panel drops back to the
  provider flow instead of staying "ready". It tracks `connecting` → `ready` /
  `unavailable`, and gives `AdvisorPanel` an `ask()` that behaves like its
  existing SSE-based `ask` call. `AdvisorPanel` prefers the bridge whenever
  it's `ready`, and otherwise falls back to its original provider-backed
  `/api/advisor/.../ask` flow unchanged.
- **The CLI** (`cli.ts`, run via `pnpm deckgauge:advisor`) is the only place
  in the package that reads `process.env` or prints to the console — it
  builds config from `DECKGAUGE_API_URL` / `DECKGAUGE_TOKEN` (optional) /
  `ADVISOR_BRIDGE_PORT` / `ADVISOR_PREFER`, starts the `AdvisorBridge`
  (authenticating immediately only if `DECKGAUGE_TOKEN` was set), then starts
  the WebSocket server once an agent is confirmed.

## Troubleshooting

- **"No local agent found. Install and sign in to Claude Code (or Codex) and
  try again."** — Nothing on this machine looks like a set-up Claude Code or
  Codex: no `claude`/`codex` CLI on `PATH`, and none of `~/.claude`,
  `~/.claude.json`, `~/.codex` (or a `CLAUDE_CONFIG_DIR` / `CODEX_HOME` you've
  pointed elsewhere). Install and sign in to one of them, then rerun
  `pnpm deckgauge:advisor`.

  Note this is *not* about the ACP adapters — those ship as dependencies of
  `@deckgauge/advisor-bridge`, so they're always installed. If you do have an
  agent and detection is reading your machine wrong, set `ADVISOR_AGENT=claude`
  (or `codex`) to select it outright and skip the check.
- **The panel never reaches "Connected", even though the bridge's own
  terminal shows "Detected ... bridge listening..."** — The bridge found an
  agent, but nothing has authenticated it yet. Make sure you're signed in to
  Deckgauge in the browser tab with the panel open — a logged-out session has
  no token to send, so the panel gives up and falls back to the provider
  flow. If you are signed in, the bridge's `/mcp` preflight is the next thing
  to check: its rejection message names the cause (see the two entries below).
- **"Deckgauge rejected the bridge's token…"** — The preflight did its job: the
  token the panel (or `DECKGAUGE_TOKEN`) supplied isn't accepted by `/mcp`. On
  the browser-auth path, make sure you're signed in to Deckgauge with the
  board's Advisor panel open (that's what sends the token), and that your user
  has at least VIEWER access on the board — `/mcp` re-checks board access on
  every call, so access that's fine for one board can still be forbidden on
  another. Running headless, check that `DECKGAUGE_TOKEN` is set, hasn't
  expired, and belongs to a user with that same board access.
- **"Could not reach Deckgauge's MCP endpoint at …"** — The API isn't up, or
  `DECKGAUGE_API_URL` points somewhere else. The URL in the message is exactly
  what the bridge tried.
- **The advisor answers, but clearly without board data** — This was the
  failure mode the `/mcp` preflight exists to prevent, so it should now surface
  as one of the two errors above instead. If you still see it, check the
  bridge's output — the terminal if you ran it in the foreground, otherwise
  `.advisor-bridge.log` — for the `MCP transport:` line it prints when it
  authenticates: `stdio via mcp-remote` means the agent has no http MCP support
  and you're on the fallback path, which reports auth failures poorly. Also
  look for a warning about the session mode.
- **The panel says no advisor model is configured, but the bridge is running** —
  Two different things produce that one message, because a browser cannot read
  the HTTP status off a failed WebSocket handshake: the panel can't tell "no
  bridge here" from "the bridge refused me", and falls back to the server-side
  provider flow either way.

  Check the bridge is up and listening: `lsof -nP -iTCP:4779 -sTCP:LISTEN`
  (a `curl` of that port answering `426 Upgrade Required` is also healthy — it
  only speaks WebSocket). If it is up, look in its output for
  `Refused an advisor WebSocket handshake from Origin …`: that names the origin
  turned away by the Origin policy, and the fix is to browse Deckgauge from a
  loopback origin or to add that origin to `ADVISOR_ALLOWED_ORIGINS`. The most
  common cause is browsing over a LAN hostname or IP (`http://192.168.1.10:3000`,
  `http://my-box.local:3000`) rather than `localhost` — that's not loopback, so
  it needs allowing explicitly. Also check the `Origin policy: …` line the
  bridge prints at startup, in case an `ADVISOR_ALLOWED_ORIGINS` you set
  elsewhere is pinning it tighter than you meant.

  Where that output lands depends on how the bridge was started: the terminal
  in the foreground, otherwise `.advisor-bridge.log`, or your service manager's
  log if you run it as one.
- **The panel shows "Run `pnpm deckgauge:advisor` to use your local Claude
  Code" instead of "Connected"** — The bridge isn't running (or the panel's
  connection attempt timed out). Start it with `pnpm deckgauge:advisor` and
  reopen the panel; it fell back to the normal provider flow automatically so
  you're never blocked in the meantime.
- **"Port `<port>` is already in use..."** — Another bridge instance (or
  something else) is already bound to `4779`. Stop it, or set
  `ADVISOR_BRIDGE_PORT` to a free port and restart both the bridge and the
  panel's connection (the panel currently connects on the default port, so a
  non-default `ADVISOR_BRIDGE_PORT` needs the matching port wired into the
  panel too).
