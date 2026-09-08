import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type ToolKind,
} from '@zed-industries/agent-client-protocol';
import type { AcpAgent } from './agent-adapter.js';

/**
 * Callbacks an `ask()` caller supplies to receive a prompt turn's streamed
 * output. Exactly one of `onDone`/`onError` fires per `ask()` call.
 */
export interface AskHandlers {
  onDelta(text: string): void;
  onToolCall(name: string): void;
  onDone(): void;
  onError(message: string): void;
}

/**
 * The subset of a spawned ACP-adapter subprocess `AcpClient` needs. `stdin`
 * and `stdout` are opaque (`unknown`) at this level — only the paired
 * `createConnection` implementation knows how to wire them into an ACP
 * `Stream`; the default pairing narrows them to real Node streams (see
 * `defaultCreateConnection`), and a test's fake pairing never dereferences
 * them at all.
 */
export interface SpawnedAgentProcess {
  readonly stdin: unknown;
  readonly stdout: unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * The subset of `ClientSideConnection` (`@zed-industries/agent-client-protocol`)
 * `AcpClient` drives. Kept narrow and library-shape-agnostic so a unit test
 * can implement it directly against a scripted fake, with no real ACP
 * connection or subprocess involved.
 */
export interface AcpAgentConnection {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  /**
   * Optional: only agents that advertise session modes implement it, and
   * `start()` only calls it when `session/new` came back with modes.
   */
  setSessionMode?(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;
  /**
   * Optional: only agents advertising `agentCapabilities.loadSession`
   * implement it. `reconnectMcp()` is the only caller.
   */
  loadSession?(params: LoadSessionRequest): Promise<LoadSessionResponse>;
}

/**
 * What `start()` learned about the agent from its `initialize` reply, handed to
 * the MCP-config factory so it can pick a transport the agent can actually
 * take (see `buildDeckgaugeMcpConfig`).
 */
export interface AgentMcpCapabilities {
  supportsHttp: boolean;
}

/** Builds the MCP server entry for a session, once capabilities are known. */
export type BuildMcpServer = (capabilities: AgentMcpCapabilities) => McpServer;

/** The concrete `command`/`args` pair to hand to `spawn` for a given agent. */
export interface ResolvedCommand {
  command: string;
  args: string[];
}

export interface AcpClientDeps {
  /** Defaults to resolving the agent's adapter bin — see `resolveAgentCommand`. */
  resolveCommand?: (agent: AcpAgent) => ResolvedCommand;
  /** Defaults to `node:child_process`'s `spawn`. */
  spawn?: (command: string, args: string[]) => SpawnedAgentProcess;
  /** Defaults to wiring a real `ClientSideConnection` over stdio. */
  createConnection?: (clientHandler: Client, input: unknown, output: unknown) => AcpAgentConnection;
  /** Defaults to `defaultSessionCwd` — see that function for why not `process.cwd()`. */
  sessionCwd?: () => string;
  /**
   * Called when a non-fatal hardening step didn't take (e.g. the agent
   * refused `session/set_mode`), so the CLI can print it. Errors here are
   * reported, never swallowed — but they don't fail an otherwise usable
   * session either.
   */
  onWarning?: (message: string) => void;
  /**
   * Called with one-line facts about the session worth surfacing — currently
   * which MCP transport the agent's capabilities selected. Without it there is
   * no way to tell from the outside whether a session is on the direct http
   * path or the `mcp-remote` fallback, which changes both how auth failures
   * report and whether the token reaches the process table.
   */
  onInfo?: (message: string) => void;
}

/**
 * The session mode to request when the agent offers modes.
 *
 * Claude Code's adapter opens a session in `auto` mode, where *its own* model
 * classifier approves or denies tool calls. That silently bypasses this
 * bridge's policy: `requestPermission` below is written to auto-deny local
 * edits/deletes/moves/shell execution, but it is never consulted for a
 * decision the agent already made internally. `default` mode ("prompts for
 * dangerous operations") routes those decisions back to the client — i.e. to
 * `autoApprovePermission` — which is the only way this bridge's deny policy
 * actually governs an unattended session.
 */
const CLIENT_DECIDES_MODE_ID = 'default';

/**
 * The directory an advisor session runs in.
 *
 * Deliberately NOT `process.cwd()`, which is wherever the operator started the
 * bridge — in practice the Deckgauge checkout itself. A local agent pointed at
 * a source tree treats it as the working context: it reads files there, and
 * loads any project-level agent configuration it finds. But the advisor's job
 * is to answer board questions through the read-only `/mcp` tools; the
 * operator's source tree is not its subject matter. An empty scratch directory
 * gives the agent a neutral place to stand.
 *
 * This narrows *context*, not capability: the agent still ships whatever local
 * tools it ships (Bash, file edits, web fetch), which is why the permission
 * policy below — and `CLIENT_DECIDES_MODE_ID`, which makes it apply — matter.
 *
 * Uses `mkdtempSync`, not a fixed name under `tmpdir()`. A predictable path in
 * a world-writable directory can be pre-created (or symlinked) by another local
 * user and seeded with the very project-level agent configuration — a
 * `CLAUDE.md`, a `.claude/settings.json` — that standing outside the checkout
 * is meant to avoid. A fresh unpredictable directory per session can't be
 * squatted that way.
 */
export function defaultSessionCwd(): string {
  return mkdtempSync(join(tmpdir(), 'deckgauge-advisor-'));
}

/**
 * Reads `agent.packageName`'s installed `package.json` to find its real
 * `bin` entry, using `agent.spawnCommand` to disambiguate a multi-bin
 * package. Deliberately narrow (`typeof`/`in` checks, no `any`) since a
 * `package.json`'s parsed shape is untrusted at the type level.
 */
function resolveBinPath(pkgJson: unknown, pkgJsonPath: string, agent: AcpAgent): string {
  const notFound = (): never => {
    throw new Error(
      `AcpClient: ${agent.packageName}/package.json has no usable "bin" entry for "${agent.spawnCommand}"`
    );
  };
  if (typeof pkgJson !== 'object' || pkgJson === null || !('bin' in pkgJson)) {
    return notFound();
  }
  const { bin } = pkgJson as { bin: unknown };
  if (typeof bin === 'string') {
    return resolvePath(dirname(pkgJsonPath), bin);
  }
  if (typeof bin === 'object' && bin !== null) {
    const binMap = bin as Record<string, unknown>;
    const named = binMap[agent.spawnCommand];
    const binRelative =
      typeof named === 'string'
        ? named
        : Object.values(binMap).find((value): value is string => typeof value === 'string');
    if (binRelative) {
      return resolvePath(dirname(pkgJsonPath), binRelative);
    }
  }
  return notFound();
}

/**
 * Resolves `agent`'s ACP adapter to a runnable `{ command, args }` by
 * finding its installed `bin` file on disk via Node module resolution
 * (`require.resolve('<packageName>/package.json')`) and running it with
 * `node` directly.
 *
 * Deliberately NOT `npx <spawnCommand>`: `spawnCommand` is only the *bin
 * name* (e.g. `claude-agent-acp`), which differs from the *package name*
 * (e.g. `@agentclientprotocol/claude-agent-acp`) that provides it. `npx`
 * treats its argument as a package name, hits the npm registry looking for
 * a package literally called `claude-agent-acp`, and 404s — the adapter
 * never launches. Resolving the bin path ourselves is offline and reliable.
 */
export function resolveAgentCommand(agent: AcpAgent): ResolvedCommand {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${agent.packageName}/package.json`);
  const pkgJson: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const binPath = resolveBinPath(pkgJson, pkgJsonPath, agent);
  return { command: process.execPath, args: [binPath, ...agent.spawnArgs] };
}

function defaultSpawn(command: string, args: string[]): SpawnedAgentProcess {
  const child = nodeSpawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: (signal) => child.kill(signal),
  };
}

/**
 * Wires a real `ClientSideConnection` over the agent subprocess's stdio,
 * using the library's `ndJsonStream` helper. `input`/`output` are narrowed
 * from `unknown` at this single boundary — the only place this module
 * assumes they are real Node streams (true for `defaultSpawn`'s output).
 */
function defaultCreateConnection(
  clientHandler: Client,
  input: unknown,
  output: unknown
): AcpAgentConnection {
  if (!(input instanceof Readable) || !(output instanceof Writable)) {
    throw new Error(
      'AcpClient: default createConnection requires a Readable input and a Writable output stream'
    );
  }
  // `Writable.toWeb`/`Readable.toWeb` return Node's `node:stream/web` types,
  // which are structurally identical to but not nominally the same as the
  // DOM `WritableStream`/`ReadableStream` types `ndJsonStream` expects — a
  // known Node/TS friction point. The runtime values are interchangeable;
  // narrow the cast through `unknown` at this single boundary.
  const stream = ndJsonStream(
    Writable.toWeb(output) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(input) as unknown as ReadableStream<Uint8Array>
  );
  return new ClientSideConnection(() => clientHandler, stream);
}

/** Longest `data` payload appended to an error message before it is truncated. */
const ERROR_DATA_MAX_CHARS = 200;

/** `JSON.stringify`, but never throws on a cyclic or unserialisable value. */
function tryStringify(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}

/** The `{code, data}` tail appended after a JSON-RPC error's own message. */
function describeJsonRpcDetail(code: unknown, data: unknown): string {
  const parts: string[] = [];
  if (typeof code === 'number') {
    parts.push(`code ${code}`);
  }
  const json = data === undefined ? null : tryStringify(data);
  if (json !== null && json !== '{}') {
    parts.push(
      json.length > ERROR_DATA_MAX_CHARS ? `${json.slice(0, ERROR_DATA_MAX_CHARS - 1)}…` : json
    );
  }
  return parts.length > 0 ? ` (${parts.join(': ')})` : '';
}

/**
 * Turns whatever a rejected ACP call threw into a sentence a person can read.
 *
 * `String(error)` is NOT enough here. `ClientSideConnection` rejects a pending
 * request with the wire `error` member verbatim — a plain
 * `{code, message, data}` object, not an `Error` (see the library's
 * `#handleResponse`). Every agent-side failure of `session/prompt` therefore
 * used to reach the advisor panel as the literal string "[object Object]",
 * which told the operator nothing and hid the agent's own explanation.
 *
 * So: `Error` → its message; a JSON-RPC error object → its message plus the
 * code and any `data` it carries; anything else object-shaped → its JSON.
 * `String()` remains the fallback for primitives (a thrown string still
 * reports as itself).
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const { message, code, data } = error as { message?: unknown; code?: unknown; data?: unknown };
    if (typeof message === 'string' && message.trim() !== '') {
      return `${message}${describeJsonRpcDetail(code, data)}`;
    }
    const json = tryStringify(error);
    if (json !== null) {
      return json;
    }
  }
  return String(error);
}

function extractText(content: ContentBlock): string | null {
  return content.type === 'text' ? content.text : null;
}

/**
 * The `Client` handler `AcpClient` registers with the agent connection.
 * `sessionUpdate` routes each streamed notification to whichever `ask()`
 * call is currently in flight; `requestPermission` answers tool-call
 * permission requests without an interactive user (this bridge is a
 * headless CLI companion) — see `autoApprovePermission` for the
 * approve/deny policy.
 */
function buildClientHandler(getCurrentHandlers: () => AskHandlers | null): Client {
  return {
    async sessionUpdate(notification: SessionNotification): Promise<void> {
      const handlers = getCurrentHandlers();
      if (!handlers) {
        return;
      }
      const update = notification.update;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = extractText(update.content);
          if (text !== null) {
            handlers.onDelta(text);
          }
          break;
        }
        case 'tool_call': {
          handlers.onToolCall(update.title);
          break;
        }
        default:
          break;
      }
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return autoApprovePermission(params);
    },
  };
}

/**
 * Tool kinds that mutate the developer's machine (local file edits/deletes/
 * moves, or shell execution) rather than just reading or fetching data.
 */
const DESTRUCTIVE_TOOL_KINDS: ReadonlySet<ToolKind> = new Set([
  'edit',
  'delete',
  'move',
  'execute',
]);

function isDestructiveToolCall(kind: ToolKind | null | undefined): boolean {
  return kind != null && DESTRUCTIVE_TOOL_KINDS.has(kind);
}

/**
 * Decides how `AcpClient` answers a `session/request_permission` call.
 *
 * This bridge only drives the agent to ANSWER board questions via the Deckgauge
 * MCP tools — those surface as `read`/`fetch`/`other` (and sometimes
 * `search`/`think`/`switch_mode`) tool calls, which are safe to auto-approve
 * since there's no interactive user to ask. That set is safe because of what the
 * MCP surface itself permits, not because it is read-only: seven of its eight
 * tools only read, and the eighth (`propose_board_changes`) writes one proposal
 * row for a board EDITOR, which a human must then apply in Deckgauge. Every one
 * of them is board-scoped, authorized server-side per call, and cannot touch the
 * developer's machine.
 *
 * This permission gate is the *only* checkpoint between an unattended headless
 * session and the agent editing/deleting files or running shell commands on the
 * developer's machine — a capability the local agent has of its own accord,
 * entirely outside the MCP surface and unconstrained by anything Deckgauge
 * authorizes. So destructive kinds (`edit`, `delete`, `move`, `execute`) are
 * auto-DENIED instead: never silently authorize local file mutation or shell
 * execution. Widening the MCP tool catalogue is NOT a reason to relax this deny;
 * the two are unrelated boundaries.
 *
 * Kept as one small pure function so the policy is unit-testable without a
 * live connection.
 */
function autoApprovePermission(params: RequestPermissionRequest): RequestPermissionResponse {
  if (isDestructiveToolCall(params.toolCall.kind)) {
    const rejectOption =
      params.options.find((option) => option.kind === 'reject_once') ??
      params.options.find((option) => option.kind === 'reject_always');
    if (!rejectOption) {
      return { outcome: { outcome: 'cancelled' } };
    }
    return { outcome: { outcome: 'selected', optionId: rejectOption.optionId } };
  }

  const allowOption =
    params.options.find((option) => option.kind === 'allow_once') ??
    params.options.find((option) => option.kind === 'allow_always') ??
    params.options[0];
  if (!allowOption) {
    return { outcome: { outcome: 'cancelled' } };
  }
  return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
}

/**
 * Owns one ACP session's lifecycle against a local coding agent: spawning
 * the adapter subprocess, the `initialize`/`session/new` handshake, and
 * mapping streamed `session/update` notifications to per-`ask()` callbacks.
 * All ACP-library-specific shapes are isolated inside this class.
 */
export class AcpClient {
  private readonly resolveCommand: (agent: AcpAgent) => ResolvedCommand;
  private readonly spawnProcess: (command: string, args: string[]) => SpawnedAgentProcess;
  private readonly createConnection: (
    clientHandler: Client,
    input: unknown,
    output: unknown
  ) => AcpAgentConnection;
  private readonly sessionCwd: () => string;
  private readonly onWarning: (message: string) => void;
  private readonly onInfo: (message: string) => void;

  private process: SpawnedAgentProcess | null = null;
  private connection: AcpAgentConnection | null = null;
  private sessionId: string | null = null;
  private currentHandlers: AskHandlers | null = null;
  /**
   * What `initialize` advertised, kept because `reconnectMcp()` has to rebuild
   * the MCP config from the SAME capabilities `start()` used. Guessing them
   * could hand an http-capable agent the `mcp-remote` stdio config, which puts
   * the token back on a command line — the exposure `mcp-config.ts` avoids.
   */
  private capabilities: AgentMcpCapabilities | null = null;
  private canLoadSession = false;
  /** The cwd this session was opened with; `session/load` must reuse it. */
  private sessionCwdUsed: string | null = null;

  constructor(deps: AcpClientDeps = {}) {
    this.resolveCommand = deps.resolveCommand ?? resolveAgentCommand;
    this.spawnProcess = deps.spawn ?? defaultSpawn;
    this.createConnection = deps.createConnection ?? defaultCreateConnection;
    this.sessionCwd = deps.sessionCwd ?? defaultSessionCwd;
    this.onWarning = deps.onWarning ?? ((): void => undefined);
    this.onInfo = deps.onInfo ?? ((): void => undefined);
  }

  /**
   * Spawns the agent adapter, negotiates the protocol, and opens a session
   * whose MCP server `buildMcpServer` produces from the capabilities the
   * agent just advertised. Throws if any step fails — and if it does, tears
   * down (kills) the already-spawned subprocess first, via `stop()`, so a
   * failed handshake never leaks a running process.
   */
  async start(agent: AcpAgent, buildMcpServer: BuildMcpServer): Promise<void> {
    const { command, args } = this.resolveCommand(agent);
    const proc = this.spawnProcess(command, args);
    this.process = proc;

    try {
      const clientHandler = buildClientHandler(() => this.currentHandlers);
      const connection = this.createConnection(clientHandler, proc.stdout, proc.stdin);
      this.connection = connection;

      const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION });
      const supportsHttp = initialized.agentCapabilities?.mcpCapabilities?.http === true;
      this.capabilities = { supportsHttp };
      this.canLoadSession = initialized.agentCapabilities?.loadSession === true;
      this.onInfo(
        supportsHttp
          ? 'MCP transport: http (the agent connects to /mcp directly; the token stays out of argv).'
          : 'MCP transport: stdio via mcp-remote (the agent has no http MCP support; the token is ' +
              'passed on that subprocess\'s command line, readable by other users on this host).'
      );
      const mcpServer = buildMcpServer({ supportsHttp });
      const cwd = this.sessionCwd();
      this.sessionCwdUsed = cwd;
      const session = await connection.newSession({
        cwd,
        mcpServers: [mcpServer],
      });
      this.sessionId = session.sessionId;
      await this.applyClientDecidesMode(connection, session);
    } catch (error: unknown) {
      await this.stop();
      throw error;
    }
  }

  /**
   * Moves the session onto `CLIENT_DECIDES_MODE_ID` so this client's
   * permission policy governs tool calls (see that constant). A no-op when the
   * agent advertises no modes, or is already in that mode.
   *
   * Hardening, not a precondition: a session that refuses the mode change is
   * still usable for answering board questions, so this reports the failure to
   * `onWarning` instead of tearing the session down — but it never passes
   * silently.
   */
  private async applyClientDecidesMode(
    connection: AcpAgentConnection,
    session: { sessionId: string; modes?: NewSessionResponse['modes'] }
  ): Promise<void> {
    const modes = session.modes;
    if (!modes || !connection.setSessionMode) {
      return;
    }
    if (modes.currentModeId === CLIENT_DECIDES_MODE_ID) {
      return;
    }
    const offersMode = modes.availableModes.some((mode) => mode.id === CLIENT_DECIDES_MODE_ID);
    if (!offersMode) {
      this.onWarning(
        `Agent offers no "${CLIENT_DECIDES_MODE_ID}" session mode, so it stays in ` +
          `"${modes.currentModeId}" — it decides tool permissions itself rather than ` +
          "deferring to this bridge's deny policy."
      );
      return;
    }

    try {
      await connection.setSessionMode({
        sessionId: session.sessionId,
        modeId: CLIENT_DECIDES_MODE_ID,
      });
    } catch (error: unknown) {
      this.onWarning(
        `Could not put the agent session in "${CLIENT_DECIDES_MODE_ID}" mode ` +
          `(${getErrorMessage(error)}); it stays in "${modes.currentModeId}" and decides ` +
          "tool permissions itself rather than deferring to this bridge's deny policy."
      );
    }
  }

  /**
   * Can a rotated token be installed on THIS session, instead of by starting a
   * replacement one?
   *
   * True only when the agent advertised `loadSession` at initialize and a
   * session is actually open. `session/load` is specified to restore the
   * conversation history and connect to the `mcpServers` the request carries,
   * which is exactly a credential swap; without it the only way to change the
   * token is a new subprocess, and the conversation is lost with the old one.
   */
  canReconnectMcp(): boolean {
    return this.canLoadSession && this.connection?.loadSession !== undefined && this.sessionId !== null;
  }

  /**
   * Re-points this session's MCP server at a config built by `buildMcpServer`
   * — the way a rotated token reaches a live agent without discarding its
   * conversation.
   *
   * Throws rather than silently degrading when the agent cannot load sessions:
   * a caller that believes a swap happened would leave the agent holding an
   * expired token and every board tool would 401, which is the failure this
   * whole path exists to prevent. Check `canReconnectMcp()` first.
   */
  async reconnectMcp(buildMcpServer: BuildMcpServer): Promise<void> {
    const { connection, sessionId, capabilities, sessionCwdUsed } = this;
    if (!connection?.loadSession || !this.canLoadSession) {
      throw new Error(
        'AcpClient: this agent does not support session/load, so its MCP server cannot be ' +
          'reconnected in place'
      );
    }
    if (!sessionId || !capabilities || sessionCwdUsed === null) {
      throw new Error('AcpClient: reconnectMcp() called before start() completed');
    }

    const loaded = await connection.loadSession({
      sessionId,
      cwd: sessionCwdUsed,
      mcpServers: [buildMcpServer(capabilities)],
    });

    // A reload is NOT guaranteed to preserve the session mode, so the
    // client-decides mode has to be re-asserted exactly as `start()` asserts it.
    // On the pinned Claude adapter it is guaranteed NOT to: its session
    // fingerprint is `JSON.stringify({ cwd, mcpServers })` and the token lives
    // inside `mcpServers`, so a rotation always changes it, always takes the
    // teardown-and-recreate branch, and always comes back in the adapter's own
    // default mode. Skipping this would mean the agent approves its own tool
    // calls from the first rotation onward — `autoApprovePermission`, the only
    // checkpoint against local file edits and shell execution, would never be
    // consulted again.
    await this.applyClientDecidesMode(connection, { sessionId, modes: loaded.modes });
  }

  /**
   * Is a prompt turn streaming right now?
   *
   * `currentHandlers` is set for exactly the duration of `ask()`, so this is
   * the same signal the notification handler uses. Callers rotate credentials
   * only when it is false — a swap mid-turn would drop the answer being
   * streamed, and `session/load`'s history replay would arrive while a turn's
   * handlers were still installed.
   */
  isBusy(): boolean {
    return this.currentHandlers !== null;
  }

  /**
   * Sends `question` as a `session/prompt` and streams the turn's output to
   * `handlers`. Never throws — transport/agent failures surface via
   * `handlers.onError` instead.
   */
  async ask(question: string, handlers: AskHandlers): Promise<void> {
    const { connection, sessionId } = this;
    if (!connection || !sessionId) {
      handlers.onError('AcpClient: ask() called before start() completed');
      return;
    }

    this.currentHandlers = handlers;
    try {
      await connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: question }],
      });
      handlers.onDone();
    } catch (error: unknown) {
      handlers.onError(getErrorMessage(error));
    } finally {
      this.currentHandlers = null;
    }
  }

  /** Ends the session and kills the subprocess. Safe to call more than once. */
  async stop(): Promise<void> {
    this.connection = null;
    this.sessionId = null;
    this.currentHandlers = null;
    this.capabilities = null;
    this.canLoadSession = false;
    this.sessionCwdUsed = null;
    const proc = this.process;
    this.process = null;
    if (proc) {
      proc.kill();
    }
  }
}
