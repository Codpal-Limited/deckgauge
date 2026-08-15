import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A local coding agent that speaks the Agent Client Protocol (ACP).
 */
export interface AcpAgent {
  id: 'claude' | 'codex';
  displayName: string;
  /**
   * Name of the ACP adapter binary for this agent (distinct per agent so
   * `detectAgent` can probe it independently). A later task launches it by
   * resolving `packageName`'s installed `bin` entry (see `acp-client.ts`) —
   * NOT via `npx <spawnCommand>`, which treats the bin name as a package
   * name and 404s against the npm registry.
   */
  spawnCommand: string;
  spawnArgs: string[];
  /**
   * The npm package that provides `spawnCommand`'s ACP adapter `bin`.
   * Resolved via `require.resolve('<packageName>/package.json')` to find
   * the adapter's real installed path, offline, without going through the
   * registry.
   */
  packageName: string;
  /**
   * The agent's own CLI on `PATH` (`claude`, `codex`) — one signal that the
   * operator actually has this agent, as opposed to merely having our adapter
   * dependency installed. Distinct from `spawnCommand`, which is the adapter.
   */
  cliName: string;
  /**
   * Home-relative files/directories the agent creates once it has been set up
   * (config, credentials). The second evidence signal, and the one that covers
   * an agent installed somewhere off `PATH`.
   */
  configPaths: string[];
  /**
   * The agent's own environment variable for relocating `configPaths`
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Checked first: someone who has moved
   * their agent config *and* runs the agent off `PATH` would otherwise look
   * like they have no agent at all.
   */
  configDirEnvVar: string;
}

export const CLAUDE_AGENT: AcpAgent = {
  id: 'claude',
  displayName: 'Claude Code',
  spawnCommand: 'claude-agent-acp',
  spawnArgs: [],
  packageName: '@agentclientprotocol/claude-agent-acp',
  cliName: 'claude',
  configPaths: ['.claude', '.claude.json'],
  configDirEnvVar: 'CLAUDE_CONFIG_DIR',
};

export const CODEX_AGENT: AcpAgent = {
  id: 'codex',
  displayName: 'Codex',
  spawnCommand: 'codex-acp',
  spawnArgs: [],
  packageName: '@agentclientprotocol/codex-acp',
  cliName: 'codex',
  configPaths: ['.codex'],
  configDirEnvVar: 'CODEX_HOME',
};

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Returns true if `cmd` resolves either on PATH or in a local `.bin`
 * directory (this package's or the repo root's `node_modules/.bin`).
 * Kept simple and dependency-light; exactness is secondary here — a later
 * live-smoke task validates the real spawn path.
 */
function defaultWhich(cmd: string): boolean {
  const localBin = join(PACKAGE_ROOT, 'node_modules', '.bin', cmd);
  const repoRootBin = join(PACKAGE_ROOT, '..', '..', 'node_modules', '.bin', cmd);
  if (existsSync(localBin) || existsSync(repoRootBin)) {
    return true;
  }
  const result = spawnSync('which', [cmd]);
  return result.status === 0;
}

/**
 * Returns true if there is evidence the operator actually has `agent` — its
 * CLI on `PATH`, or the config/credentials it writes on first use.
 *
 * This is deliberately a *heuristic about the operator's machine*, not a proof
 * of a valid login: nothing short of driving the agent proves that. It only
 * has to separate "this person uses Claude Code / Codex" from "this person has
 * never installed either", which the adapter-bin check cannot do at all — both
 * adapters are dependencies of this package, so `pnpm install` puts both bins
 * on every machine, and detection reported an agent for everyone.
 */
export interface AgentEvidenceDeps {
  /** Defaults to `which <cmd>`. */
  isOnPath?: (cmd: string) => boolean;
  /** Defaults to `node:fs`'s `existsSync`. */
  fileExists?: (path: string) => boolean;
  /** Defaults to `node:os`'s `homedir`. */
  homeDir?: () => string;
  /**
   * Defaults to `process.env`. The one place in this package outside the CLI
   * that reads it, deliberately: these are the *agents'* own variables
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) describing the machine, not this
   * bridge's configuration, and the CLI has no way to know about them.
   */
  env?: Record<string, string | undefined>;
}

export function hasAgentEvidence(agent: AcpAgent, deps: AgentEvidenceDeps = {}): boolean {
  const isOnPath = deps.isOnPath ?? ((cmd: string): boolean => spawnSync('which', [cmd]).status === 0);
  const fileExists = deps.fileExists ?? existsSync;
  const env = deps.env ?? process.env;

  // A relocated config directory is the strongest signal available, and the
  // only one that survives an agent installed off `PATH` with a moved config.
  const configuredDir = env[agent.configDirEnvVar]?.trim();
  if (configuredDir && fileExists(configuredDir)) {
    return true;
  }

  if (isOnPath(agent.cliName)) {
    return true;
  }

  const home = (deps.homeDir ?? homedir)();
  return agent.configPaths.some((relativePath) => fileExists(join(home, relativePath)));
}

export interface DetectAgentOptions {
  prefer?: 'claude' | 'codex';
  /**
   * Skips the evidence check for this agent and selects it outright, provided
   * its adapter is runnable. The escape hatch for a machine the heuristic
   * reads wrong — without one, a false negative disables the whole feature
   * with no way for the operator to override it.
   */
  force?: 'claude' | 'codex';
  /** Probes whether an ACP *adapter* bin is runnable. */
  which?: (cmd: string) => boolean;
  /** Probes whether the operator actually has that *agent*. */
  hasAgentEvidence?: (agentId: 'claude' | 'codex') => boolean;
}

/**
 * Detects a local ACP agent the operator can actually be driven through.
 *
 * A candidate qualifies only if BOTH hold: its ACP adapter is runnable, and
 * there is evidence the agent itself is set up on this machine. Requiring only
 * the first made every install look like Claude Code — so a Codex user got the
 * Claude adapter spawned at them, and someone with no agent at all got a
 * cheerful "Detected Claude Code" whose failure surfaced only when they asked
 * their first question, instead of the actionable "no local agent found".
 *
 * `opts.prefer` orders the candidates; it cannot promote an agent that isn't
 * there, since preferring an absent agent would reintroduce exactly that
 * failure.
 */
export function detectAgent(opts: DetectAgentOptions = {}): AcpAgent | null {
  const which = opts.which ?? defaultWhich;
  const checkEvidence =
    opts.hasAgentEvidence ??
    ((agentId: 'claude' | 'codex'): boolean =>
      hasAgentEvidence(agentId === 'codex' ? CODEX_AGENT : CLAUDE_AGENT));

  if (opts.force) {
    const forced = opts.force === 'codex' ? CODEX_AGENT : CLAUDE_AGENT;
    return which(forced.spawnCommand) ? forced : null;
  }

  // Default order is claude, then codex; `prefer: 'codex'` puts codex first.
  const candidates: AcpAgent[] =
    opts.prefer === 'codex' ? [CODEX_AGENT, CLAUDE_AGENT] : [CLAUDE_AGENT, CODEX_AGENT];

  for (const candidate of candidates) {
    if (which(candidate.spawnCommand) && checkEvidence(candidate.id)) {
      return candidate;
    }
  }
  return null;
}
