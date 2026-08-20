import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';

const ENV_FILENAME = '.env';

/**
 * The only variables the bridge itself reads (`readConfig` in `cli.ts`).
 *
 * Deliberately an allowlist rather than "everything in the file": the bridge
 * spawns the local agent as a child process, which inherits its environment.
 * Loading the whole repo `.env` would hand that agent the stack's
 * `DATABASE_URL`, Keycloak client secret and source-integration tokens, none
 * of which it has any business seeing.
 */
const BRIDGE_ENV_KEYS = [
  'DECKGAUGE_API_URL',
  'DECKGAUGE_TOKEN',
  'ADVISOR_BRIDGE_PORT',
  'ADVISOR_PREFER',
  'ADVISOR_AGENT',
  'ADVISOR_ALLOWED_ORIGINS',
] as const;

export type EnvFileOutcome =
  | { kind: 'none' }
  | { kind: 'loaded'; path: string; applied: string[] }
  | { kind: 'unreadable'; path: string; message: string };

/**
 * Nearest `.env` at or above `startDir`, or undefined if there is none before
 * the filesystem root.
 *
 * The bridge needs this because `pnpm --filter @deckgauge/advisor-bridge dev`
 * runs `tsx` with its cwd inside the package, three levels below the `.env`
 * the operator actually edited — so neither dotenv's cwd default nor a
 * cwd-relative path finds it. `exists` is injectable so the walk is testable
 * without touching a real filesystem.
 */
export function findEnvFile(
  startDir: string,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ENV_FILENAME);
    if (exists(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Narrows parsed `.env` contents to `BRIDGE_ENV_KEYS`, dropping blanks.
 *
 * `.env.example` ships every one of these keys present-but-empty, and a blank
 * there means "not set" — the same reading `readConfig` gives it.
 */
export function pickBridgeEnv(parsed: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of BRIDGE_ENV_KEYS) {
    const value = parsed[key];
    if (value !== undefined && value.trim() !== '') {
      picked[key] = value;
    }
  }
  return picked;
}

/**
 * Copies `vars` into `env` without overriding anything already set there, and
 * returns the names it applied. The real environment wins so a one-off
 * `DECKGAUGE_API_URL=… pnpm deckgauge:advisor` still beats the file — the same
 * precedence every other app in this repo uses. A present-but-blank value
 * counts as unset, matching how `readConfig` reads these.
 */
export function applyEnvFileVars(
  vars: Record<string, string>,
  env: Record<string, string | undefined> = process.env
): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    const existing = env[key];
    if (existing !== undefined && existing.trim() !== '') {
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Finds the repo `.env`, and applies the bridge's own variables from it.
 *
 * Returns what happened rather than logging: `cli.ts` is the one module in
 * this package allowed to print. An unreadable file is reported, never
 * swallowed, but is not fatal — the bridge still starts on defaults.
 */
export function loadEnvFile(
  startDir: string,
  env: Record<string, string | undefined> = process.env
): EnvFileOutcome {
  const path = findEnvFile(startDir);
  if (!path) {
    return { kind: 'none' };
  }
  try {
    const parsed = parseDotenv(readFileSync(path, 'utf8'));
    return { kind: 'loaded', path, applied: applyEnvFileVars(pickBridgeEnv(parsed), env) };
  } catch (error: unknown) {
    return {
      kind: 'unreadable',
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
