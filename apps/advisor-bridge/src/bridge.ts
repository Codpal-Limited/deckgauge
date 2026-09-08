import { AcpClient, type AskHandlers, type BuildMcpServer } from './acp/acp-client.js';
import { detectAgent, type AcpAgent } from './acp/agent-adapter.js';
import { buildDeckgaugeMcpConfig } from './mcp-config.js';
import { preflightDeckgaugeMcp } from './mcp-preflight.js';

/**
 * The subset of `AcpClient` `AdvisorBridge` drives. Kept narrow and
 * library-shape-agnostic so a unit test can supply a scripted fake with no
 * real agent subprocess or ACP connection involved.
 */
export interface AcpClientLike {
  start(agent: AcpAgent, buildMcpServer: BuildMcpServer): Promise<void>;
  ask(question: string, handlers: AskHandlers): Promise<void>;
  stop(): Promise<void>;
  /** Can a rotated token be installed on this live session? See `AcpClient`. */
  canReconnectMcp(): boolean;
  /** Installs a rebuilt MCP config on the live session. See `AcpClient`. */
  reconnectMcp(buildMcpServer: BuildMcpServer): Promise<void>;
  /** Is a prompt turn streaming right now? */
  isBusy(): boolean;
}

/**
 * Checks that `token` can actually reach Deckgauge's MCP tools, resolving with
 * their names. Injectable so tests don't need a live API.
 */
export type PreflightFn = (params: { mcpUrl: string; token: string }) => Promise<string[]>;

/**
 * Detects the first available local ACP agent. Structurally narrower than
 * `detectAgent`'s real `DetectAgentOptions` (which also takes an injectable
 * `which`) — the real `detectAgent` is still assignable here, since it
 * accepts every options shape this type calls it with.
 */
export type DetectAgentFn = (opts?: {
  prefer?: 'claude' | 'codex';
  force?: 'claude' | 'codex';
}) => AcpAgent | null;

export interface AdvisorBridgeConfig {
  /** Base URL of Deckgauge's MCP endpoint, e.g. `http://localhost:3001/mcp`. */
  mcpUrl: string;
  /**
   * The operator's Deckgauge API token, resolved from `DECKGAUGE_TOKEN` by
   * the CLI — kept out of `process.env` here for testability. Optional: when
   * omitted, `start()` only detects the local agent and leaves the ACP
   * session unstarted until `authenticate()` is called with a token the
   * browser panel supplies over the bridge's WebSocket (the operator's own
   * NextAuth/Keycloak session — see `ws-server.ts`'s `authenticate`
   * message). Set `DECKGAUGE_TOKEN` for a bridge that should run headless,
   * with no browser connection required.
   */
  token?: string;
  prefer?: 'claude' | 'codex';
  /** Selects that agent outright, skipping the machine-evidence check. */
  force?: 'claude' | 'codex';
}

export interface AdvisorBridgeDeps {
  /** Defaults to the real `detectAgent`. */
  detect?: DetectAgentFn;
  /** Defaults to `() => new AcpClient()`. */
  createClient?: () => AcpClientLike;
  /** Defaults to the real `preflightDeckgaugeMcp`. */
  preflight?: PreflightFn;
}

const NO_AGENT_FOUND_ERROR =
  'No local agent found. Install and sign in to Claude Code (or Codex) and try again.';

/**
 * Thrown by `start()` when no local ACP agent is installed — as opposed to the
 * other way `start()` can fail (a `DECKGAUGE_TOKEN` that can't reach `/mcp`).
 * The CLI needs to tell them apart: "install and sign in to an agent" is
 * actively misleading advice for a rejected token or a down API.
 */
export class NoLocalAgentError extends Error {
  constructor() {
    super(NO_AGENT_FOUND_ERROR);
    this.name = 'NoLocalAgentError';
  }
}

/**
 * Orchestrates one advisor session against a local coding agent: detects an
 * installed ACP agent, builds the Deckgauge MCP config, and drives an
 * `AcpClient` through its lifecycle. Consumers (a later CLI task) resolve
 * `config.token` from `DECKGAUGE_TOKEN` and pass it in — this class never
 * reads `process.env` itself.
 */
export class AdvisorBridge {
  private readonly config: AdvisorBridgeConfig;
  private readonly detect: DetectAgentFn;
  private readonly createClient: () => AcpClientLike;
  private readonly preflight: PreflightFn;

  private agent: AcpAgent | null = null;
  private client: AcpClientLike | null = null;
  private authenticatedToken: string | null = null;
  /**
   * Bumped on entry to every `authenticate()` call. A call whose generation is
   * no longer current by the time its session is up has been superseded and
   * must not install itself — see `authenticate()`.
   */
  private authGeneration = 0;
  /**
   * A rotated token that has passed preflight but has NOT yet been installed.
   *
   * Rotations are applied lazily — see `authenticate()` — so this is the queue
   * of one, flushed by `ask()`.
   */
  private pendingToken: string | null = null;
  /**
   * The swap currently being applied, if any. `ask()` joins it rather than
   * racing past it: the pending token is consumed before the swap is awaited,
   * so without this a second `ask()` entering during that await would find
   * nothing pending and prompt a session the agent is mid-way through
   * recreating — and the history replay would arrive with a turn's handlers
   * installed. `ws-server` dispatches `ask` fire-and-forget, so the panel not
   * issuing overlapping asks is a UI invariant one layer away, not a guarantee
   * this class can rely on.
   */
  private pendingSwap: Promise<string | null> | null = null;

  constructor(config: AdvisorBridgeConfig, deps: AdvisorBridgeDeps = {}) {
    this.config = config;
    this.detect = deps.detect ?? detectAgent;
    this.createClient = deps.createClient ?? (() => new AcpClient());
    this.preflight = deps.preflight ?? preflightDeckgaugeMcp;
  }

  /**
   * Detects a local agent. Rejects with a clear, actionable error if none is
   * found. If `config.token` was set at construction (headless/CI use), also
   * authenticates immediately with it, matching the pre-browser-auth
   * behavior. Otherwise leaves the ACP session unstarted — the agent is
   * detected (so the CLI can print it), but no session exists until
   * `authenticate()` is called.
   */
  async start(): Promise<{ agent: AcpAgent }> {
    const agent = this.detect({ prefer: this.config.prefer, force: this.config.force });
    if (!agent) {
      throw new NoLocalAgentError();
    }
    this.agent = agent;

    if (this.config.token) {
      await this.authenticate(this.config.token);
    }

    return { agent };
  }

  /**
   * Starts (or restarts) the ACP session using `token`. A no-op if already
   * authenticated with this exact token. For a different token, starts a
   * fresh client before stopping the old one, so a brief overlap beats a gap
   * in which `ask()` would fail.
   *
   * Rejects — rather than reporting success — when `token` can't actually
   * reach the board tools. The agent connects to `/mcp` on its own and treats
   * a rejected token as "no tools available", which used to surface as a
   * cheerfully connected panel whose answers had no board data behind them.
   * The preflight turns that into an error the operator can act on, before any
   * session is opened.
   *
   * This bridge serves one operator on one machine: it holds exactly one ACP
   * session, so if two different browser identities were to authenticate
   * concurrently, the second would win and the first's session would be torn
   * down out from under it. That's out of scope for this bridge's design —
   * it's a per-operator local companion process, not a multi-tenant server.
   */
  async authenticate(token: string): Promise<void> {
    if (!this.agent) {
      throw new Error('AdvisorBridge: authenticate() called before start() completed');
    }
    if (token === this.authenticatedToken && this.client) {
      return;
    }

    // Two `authenticate()` calls can be in flight at once — the panel
    // re-authenticates on token rotation without waiting for the previous
    // handshake to confirm, and `ws-server` dispatches each message without
    // serializing. Both take seconds (preflight + adapter spawn), so they can
    // finish out of order. Without this generation check, a slower *earlier*
    // call would install its older token last and stop the newer session,
    // leaving the bridge holding a token the panel has already moved past —
    // precisely the stale-token state the re-auth path exists to prevent.
    const generation = ++this.authGeneration;

    await this.preflight({ mcpUrl: this.config.mcpUrl, token });

    if (generation !== this.authGeneration) {
      // Superseded while we were in preflight: do not install an older token
      // over a newer one.
      return;
    }

    // A session already exists, so this is a ROTATION: record it and return.
    // Installing it here is what made the panel reset its agent on a timer.
    if (this.client) {
      this.pendingToken = token;
      return;
    }

    await this.openSession(token);
  }

  /**
   * Opens the first session for `token`, replacing any existing one.
   *
   * The new session is started BEFORE the old one is stopped, so a brief
   * overlap beats a gap in which `ask()` would fail. Only reached for the
   * initial handshake and for the fallback rotation path (an agent that cannot
   * load sessions) — `flushPendingToken()` prefers an in-place swap.
   */
  private async openSession(token: string): Promise<boolean> {
    if (!this.agent) {
      throw new Error('AdvisorBridge: openSession() called before start() completed');
    }
    const generation = this.authGeneration;

    const nextClient = this.createClient();
    await nextClient.start(this.agent, ({ supportsHttp }) =>
      buildDeckgaugeMcpConfig({ mcpUrl: this.config.mcpUrl, token, supportsHttp })
    );

    if (generation !== this.authGeneration) {
      // Superseded while we were starting: discard our own session rather than
      // clobber the newer one. Reported so the caller does not treat this token
      // as installed — it is not.
      await nextClient.stop();
      return false;
    }

    const previousClient = this.client;
    this.client = nextClient;
    this.authenticatedToken = token;

    if (previousClient) {
      await previousClient.stop();
    }
    return true;
  }

  /**
   * Installs a rotated token, if one is waiting, on the session `ask()` is
   * about to use.
   *
   * Two reasons this runs here rather than in `authenticate()`:
   *
   * - **An idle panel costs nothing.** Tokens live ~5 minutes, so a panel left
   *   open rotates every few minutes whether or not anyone is using it. Applying
   *   each one immediately reset the agent on a timer.
   * - **A turn is never interrupted.** Between asks there is no answer to lose.
   *   A swap during one drops the output being streamed, which is the symptom a
   *   user actually notices.
   *
   * Prefers `reconnectMcp()`, which re-points the LIVE session's MCP server at
   * the new credential and keeps the conversation. Only an agent that cannot
   * load sessions pays for a replacement.
   *
   * Returns an error message if the swap failed, so the caller can report it
   * instead of asking on a credential known to be stale.
   */
  private async flushPendingToken(): Promise<string | null> {
    // Join a swap already running rather than racing past it.
    const inFlight = this.pendingSwap;
    if (inFlight) {
      return inFlight;
    }

    const client = this.client;
    if (this.pendingToken === null || !client) {
      return null;
    }
    // A turn is streaming. Leave the rotation pending for the next ask.
    if (client.isBusy()) {
      return null;
    }

    const swap = this.performSwap();
    this.pendingSwap = swap;
    try {
      return await swap;
    } finally {
      this.pendingSwap = null;
    }
  }

  /**
   * Applies the pending token, restoring it if it could not be installed.
   *
   * Restoring matters more than it looks: the token is consumed before the
   * attempt, so a swap that failed and dropped it left every LATER ask running
   * silently on the expired credential — board tools 401 and the panel answers
   * with no board data behind it, the exact failure `authenticate()`'s docstring
   * says must never happen. Only the first ask would have seen an error.
   *
   * The `pendingToken === null` guard is what keeps a rotation that landed
   * DURING the attempt from being overwritten by the token that just failed.
   */
  private async performSwap(): Promise<string | null> {
    const token = this.pendingToken;
    const client = this.client;
    if (token === null || !client) {
      return null;
    }
    this.pendingToken = null;

    try {
      if (client.canReconnectMcp()) {
        await client.reconnectMcp(({ supportsHttp }) =>
          buildDeckgaugeMcpConfig({ mcpUrl: this.config.mcpUrl, token, supportsHttp })
        );
        this.authenticatedToken = token;
      } else if (!(await this.openSession(token))) {
        // Installed NOTHING: a concurrent `authenticate()` bumped the generation
        // while the replacement session was starting, so `openSession` tore its
        // own client down. The reachable trigger is an ordinary successful
        // rotation landing during that spawn — a subprocess plus a full ACP
        // handshake, seconds wide against a five-minute token — not only the
        // rarer case where the concurrent call leaves no pending token because
        // its preflight rejected.
        //
        // Reporting this as success is what the sibling `catch` below exists to
        // prevent: `this.client` is still the ORIGINAL session on the ORIGINAL
        // token, so `ask()` would answer from a credential two rotations stale —
        // board tools 401 and a reply with no board data behind it, with no
        // error shown. One failed ask, and the restored token makes the next one
        // work.
        this.restorePending(token, client);
        return 'AdvisorBridge: the token rotation was superseded before it could be installed; try again.';
      }
      return null;
    } catch (error: unknown) {
      this.restorePending(token, client);
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Puts an uninstalled token back so the next `ask()` retries it.
   *
   * Guarded twice. A newer rotation that landed during the attempt must win, so
   * a token already pending is never overwritten. And the restore is skipped if
   * the session it belonged to is no longer mounted — otherwise a `stop()` that
   * cleared the queue mid-swap would leave a stale token behind for a LATER
   * session to install backwards.
   */
  private restorePending(token: string, client: AcpClientLike): void {
    if (this.pendingToken === null && this.client === client) {
      this.pendingToken = token;
    }
  }

  /**
   * Delegates to the authenticated client's `ask()`. If no session has been
   * authenticated yet — `start()` hasn't completed, or it completed with no
   * `config.token` and `authenticate()` was never called — surfaces a clear
   * error via `handlers.onError` rather than throwing an opaque error from a
   * null client, mirroring `AcpClient.ask()`'s own "never throws" contract.
   */
  async ask(question: string, handlers: AskHandlers): Promise<void> {
    if (!this.client) {
      handlers.onError('AdvisorBridge: ask() called before authenticate() completed');
      return;
    }

    const swapFailure = await this.flushPendingToken();
    if (swapFailure !== null) {
      handlers.onError(swapFailure);
      return;
    }

    // Re-read: the fallback rotation path replaces `this.client`.
    const client = this.client;
    if (!client) {
      handlers.onError('AdvisorBridge: ask() called before authenticate() completed');
      return;
    }
    await client.ask(question, handlers);
  }

  /** Delegates to the client's `stop()`. Safe no-op if never authenticated. */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.authenticatedToken = null;
    this.pendingToken = null;
    this.pendingSwap = null;
    if (client) {
      await client.stop();
    }
  }
}
