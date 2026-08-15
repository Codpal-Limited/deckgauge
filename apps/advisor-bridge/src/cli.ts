#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { AcpClient } from './acp/acp-client.js';
import { AdvisorBridge, NoLocalAgentError } from './bridge.js';
import { startWsServer, type WsServerHandle } from './ws-server.js';

/** Agents `detectAgent` (via `AdvisorBridge`) knows how to look for. */
export type PreferAgent = 'claude' | 'codex';

export interface CliConfig {
  /** Base URL of the Deckgauge API, e.g. `http://localhost:3001`. */
  apiUrl: string;
  /** `${apiUrl}/mcp` — the endpoint `AdvisorBridge` hands the local agent. */
  mcpUrl: string;
  /**
   * The operator's Deckgauge API token, for a headless bridge. Undefined is
   * the expected default: the Advisor panel supplies its own token — the
   * operator's NextAuth/Keycloak session — over the WebSocket instead (see
   * `main()` and `AdvisorBridge.authenticate()`).
   */
  token: string | undefined;
  /** Localhost port the bridge's WebSocket server listens on. */
  port: number;
  prefer?: PreferAgent;
  /**
   * Escape hatch: select this agent outright, skipping the check for whether
   * the machine shows any sign of having it. For a machine detection reads
   * wrong -- without it, a false negative disables the Advisor's local-agent
   * mode with no operator override.
   */
  force?: PreferAgent;
  /**
   * Origins allowed to open the bridge's WebSocket (see
   * `ws-server.ts`'s `allowedOrigins`). Defaults to the Deckgauge web
   * app's own origin so a same-host malicious page can't drive-by connect
   * and read board answers.
   */
  allowedOrigins: string[];
}

const DEFAULT_API_URL = 'http://localhost:3001';
const DEFAULT_PORT = 4779;
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
}

/**
 * Comma-separated `ADVISOR_ALLOWED_ORIGINS` → a trimmed, non-empty list of
 * origins. Falls back to `DEFAULT_ALLOWED_ORIGINS` when unset, blank, or
 * left with nothing after trimming/dropping empty entries.
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS;
}

function parsePrefer(raw: string | undefined): PreferAgent | undefined {
  return raw === 'claude' || raw === 'codex' ? raw : undefined;
}

/**
 * Pure env → config mapping, kept side-effect-free so it's directly
 * unit-testable with a plain object in place of `process.env`.
 */
export function readConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): CliConfig {
  const apiUrl = env.DECKGAUGE_API_URL?.trim() || DEFAULT_API_URL;
  const mcpUrl = `${apiUrl}/mcp`;
  const token = env.DECKGAUGE_TOKEN?.trim() || undefined;
  const port = parsePort(env.ADVISOR_BRIDGE_PORT);
  const prefer = parsePrefer(env.ADVISOR_PREFER);
  const force = parsePrefer(env.ADVISOR_AGENT);
  const allowedOrigins = parseAllowedOrigins(env.ADVISOR_ALLOWED_ORIGINS);

  return { apiUrl, mcpUrl, token, port, prefer, force, allowedOrigins };
}

/** The success banner printed once the bridge is up and listening. */
export function formatReady(agentDisplayName: string, port: number): string {
  return (
    `Detected ${agentDisplayName} — bridge listening on 127.0.0.1:${port}. ` +
    `Open a board's advisor panel and pick "Local agent".`
  );
}

/**
 * Printed when `DECKGAUGE_TOKEN` is unset — the expected default. The
 * bridge still starts and detects the agent; it just waits for the Advisor
 * panel to authenticate it with the operator's own browser session token.
 */
export function formatWaitingForBrowserAuth(): string {
  return (
    'No DECKGAUGE_TOKEN set — waiting for the Advisor panel to authenticate this bridge with ' +
    "your browser session. Open a board's advisor panel while signed in to Deckgauge. " +
    'Set DECKGAUGE_TOKEN instead if you want the bridge to run headless, with no browser required.'
  );
}

/**
 * Wraps `AdvisorBridge.start()`'s rejection message with an install/auth hint.
 *
 * Deliberately does NOT tell the operator to install an ACP adapter: both
 * adapters are dependencies of this package, so `pnpm install` already put
 * them there and this error is never about them. What's missing is the agent
 * itself — so name what detection actually looked for, and offer the override
 * for a machine it reads wrong.
 */
export function formatNoAgent(message: string): string {
  return [
    message,
    '',
    'Install and sign in to Claude Code or Codex, then retry. Detection looks for:',
    '  - the agent\'s CLI on PATH ("claude" or "codex"), or',
    '  - the config it writes on first use (~/.claude, ~/.claude.json, ~/.codex),',
    '    or a relocated config dir via CLAUDE_CONFIG_DIR / CODEX_HOME.',
    '',
    'If you do have one installed and this is wrong, set ADVISOR_AGENT=claude',
    '(or codex) to select it outright and skip this check.',
  ].join('\n');
}

/**
 * `start()`'s other failure mode: an agent *was* found, but `DECKGAUGE_TOKEN`
 * couldn't reach `/mcp` (rejected token, API down). Printing `formatNoAgent`
 * here would tell the operator to install an agent they already have — and
 * since autostart is on by default, that wrong advice is what lands in
 * `.advisor-bridge.log` and the deploy summary. Pass the real reason through.
 */
export function formatStartupFailure(message: string): string {
  return [
    message,
    '',
    'The local agent was found, so this is not an install problem — the bridge could not',
    'reach Deckgauge with DECKGAUGE_TOKEN. Unset it to have the Advisor panel authenticate',
    'the bridge with your browser session instead.',
  ].join('\n');
}

/**
 * Warns that an `ADVISOR_AGENT` value was not understood and therefore ignored.
 *
 * Silently dropping it is worse here than for `ADVISOR_PREFER`: someone setting
 * `ADVISOR_AGENT` is already working around detection reading their machine
 * wrong, and a typo (`ADVISOR_AGENT=claude-code`) would hand them the identical
 * "No local agent found" with no sign their override never applied.
 */
export function formatInvalidAgentOverride(raw: string): string {
  return (
    `Ignoring ADVISOR_AGENT="${raw}": expected "claude" or "codex". ` +
    'Detection will run normally.'
  );
}

/** Printed when `startWsServer`'s listen fails (e.g. `EADDRINUSE`). */
export function formatPortInUse(port: number): string {
  return (
    `Port ${port} is already in use. Stop the process using it, or set ADVISOR_BRIDGE_PORT ` +
    `to a different port, then retry.`
  );
}

// A small status-logger layer: the CLI entrypoint is the one place in this
// package allowed to print (see CLAUDE.md conventions) — every library
// module (bridge/acp/ws/mcp-config) stays console-free.
function printLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function printErrorLine(message: string): void {
  console.error(message);
}

/** The subset of `AdvisorBridge` `handlePortInUseError` needs to tear down. */
interface StoppableBridge {
  stop(): Promise<void>;
}

/**
 * Handles a `startWsServer` bind failure (e.g. `EADDRINUSE`): prints the
 * conflict message, marks the process to exit non-zero, and closes the WS
 * handle — same as before. Additionally now stops `bridge`: by the time
 * this fires, `bridge.start()` has already spawned the ACP adapter
 * subprocess (piped stdio keeps the event loop alive), so without this the
 * CLI would set `process.exitCode` but never actually exit. Extracted so
 * it's unit-testable without a real socket bind failure.
 */
export function handlePortInUseError(params: {
  bridge: StoppableBridge;
  handle: WsServerHandle;
  port: number;
}): void {
  printErrorLine(formatPortInUse(params.port));
  process.exitCode = 1;
  params.handle.close();
  void params.bridge.stop();
}

/**
 * Wires up one advisor session: detects a local agent via `AdvisorBridge`,
 * then starts the localhost WebSocket server the board's advisor panel
 * (Task 8) connects to. Side-effecting by design — the pure pieces above
 * are what `cli.test.ts` exercises directly.
 */
export async function main(): Promise<void> {
  const config = readConfig(process.env);

  const agentOverride = process.env.ADVISOR_AGENT?.trim();
  if (agentOverride && !config.force) {
    printErrorLine(formatInvalidAgentOverride(agentOverride));
  }

  if (!config.token) {
    printLine(formatWaitingForBrowserAuth());
  }

  const bridge = new AdvisorBridge(
    {
      mcpUrl: config.mcpUrl,
      token: config.token,
      prefer: config.prefer,
      force: config.force,
    },
    // The session's hardening steps (see `AcpClient`'s session-mode handling)
    // report anything that didn't take through `onWarning`; this is the one
    // place in the package allowed to print, so route it to stderr here rather
    // than let it pass unnoticed.
    { createClient: () => new AcpClient({ onWarning: printErrorLine, onInfo: printLine }) }
  );

  let agentDisplayName: string;
  try {
    const { agent } = await bridge.start();
    agentDisplayName = agent.displayName;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    printErrorLine(
      error instanceof NoLocalAgentError ? formatNoAgent(message) : formatStartupFailure(message)
    );
    process.exitCode = 1;
    return;
  }

  const handle = startWsServer(bridge, {
    host: '127.0.0.1',
    port: config.port,
    agent: agentDisplayName,
    allowedOrigins: config.allowedOrigins,
    onError: (_error: Error) => {
      handlePortInUseError({ bridge, handle, port: config.port });
    },
  });

  printLine(formatReady(agentDisplayName, config.port));
}

/**
 * True only when this module is the process entrypoint (`node dist/cli.js`
 * or `tsx src/cli.ts`) — false when a test imports it for its pure helpers.
 * The ESM equivalent of CommonJS's `require.main === module`.
 */
function isDirectlyExecuted(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isDirectlyExecuted()) {
  void main();
}
