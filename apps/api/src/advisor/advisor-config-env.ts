// Declarative advisor provider config, read from the environment.
//
// The settings UI (`PUT /advisor/config`) writes an `AdvisorConfig` row, which
// works well for a human clicking through the app but not for a deployment:
// a fresh Docker staging stack or a fresh open-source clone starts with an
// empty table, so every advisor question 409s with `advisor_not_configured`
// until somebody opens the settings page. Letting the same config come from
// `.env` makes the advisor configurable the same way every other integration
// in this repo is.
//
// A saved row always wins over these variables (see `AdvisorConfigService`) —
// env is the deployment default, the UI is the operator's override.
import { advisorConfigSchema, type AdvisorConfigInput } from '@deckgauge/shared';

function read(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/**
 * `advisorConfigSchema`'s `z.string().url()` alone is not enough here:
 * `new URL('localhost:11434')` succeeds (it reads `localhost:` as the
 * protocol), so a base URL missing its `http://` would pass validation and
 * then fail confusingly at request time. Requiring an http(s) scheme turns
 * that common `.env` typo into a plain "not configured yet" instead.
 */
function readHttpUrl(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = read(env, key);
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value : undefined;
}

/**
 * Builds an advisor provider config from environment variables, or returns
 * `null` when none is configured.
 *
 * Returns `null` — rather than throwing or half-applying — for anything
 * incomplete or invalid, so a partial deployment config degrades to exactly
 * the same "not configured yet" state as an empty one, and the panel's
 * settings prompt still tells the operator what to do. `server.ts` logs a
 * warning at boot when `ADVISOR_PROVIDER` is set but nothing usable came out,
 * so a typo is loud rather than silent.
 *
 * Note the Anthropic key is read ONLY from the namespaced
 * `ADVISOR_ANTHROPIC_API_KEY`, never from a bare `ANTHROPIC_API_KEY` that may
 * be present in the environment for unrelated reasons — silently spending
 * someone's ambient key on board questions is not a surprise worth risking.
 */
/**
 * Values that switch source lookup OFF. Everything else — unset, empty, or
 * unrecognised — leaves it on.
 */
const SOURCE_LOOKUP_DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * Whether the Advisor's `search_source`/`read_source` tools are enabled for a
 * deployment with **no saved `AdvisorConfig` row**.
 *
 * This exists because `advisorConfigFromEnv` above is a real deployment path,
 * not a convenience: Docker staging and a fresh clone run with an empty
 * `AdvisorConfig` table. A column-only off switch would therefore be
 * unreachable for exactly those deployments, which is the case the spec's
 * operator switch exists for. `AdvisorConfigService.isSourceLookupEnabled`
 * gives a saved row priority over this, matching `getConfig`'s precedence.
 *
 * Fails OPEN — an unrecognised value means enabled. That is safe here because
 * the tools read only source this repo already publishes, through a path
 * allowlist; silently disabling a documented default on a typo would instead
 * make the Advisor quietly less useful with nothing to point at.
 */
export function sourceLookupEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  const raw = env.ADVISOR_SOURCE_LOOKUP?.trim().toLowerCase();
  if (!raw) return true;
  return !SOURCE_LOOKUP_DISABLED_VALUES.has(raw);
}

export function advisorConfigFromEnv(
  env: Record<string, string | undefined>,
): AdvisorConfigInput | null {
  const provider = read(env, 'ADVISOR_PROVIDER');
  if (!provider) return null;

  const model = read(env, 'ADVISOR_MODEL');
  const candidate =
    provider === 'anthropic'
      ? { provider, model, apiKey: read(env, 'ADVISOR_ANTHROPIC_API_KEY') }
      : provider === 'ollama'
        ? { provider, model, baseUrl: readHttpUrl(env, 'ADVISOR_OLLAMA_BASE_URL') }
        : null;
  if (!candidate) return null;

  // Env is untrusted input like any other boundary — validate it with the
  // same schema the HTTP route uses rather than trusting the shape.
  const parsed = advisorConfigSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
