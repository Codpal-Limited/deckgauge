import type { PrismaClient } from '@deckgauge/db';
import { generateText } from 'ai';
import { resolveProvider } from './llm-provider.js';
import { advisorConfigFromEnv, sourceLookupEnabledFromEnv } from './advisor-config-env.js';
import type { AdvisorConfigInput } from '@deckgauge/shared';

export interface AdvisorConfigServiceOptions {
  /** Injectable for tests; defaults to the process environment. */
  env?: Record<string, string | undefined>;
}

export interface AdvisorTestConnectionResult {
  ok: boolean;
  model: string;
  latencyMs?: number;
  error?: string;
}

export class AdvisorConfigService {
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly prisma: PrismaClient,
    opts: AdvisorConfigServiceOptions = {},
  ) {
    this.env = opts.env ?? process.env;
  }

  /**
   * The advisor config used to be a process-wide singleton row keyed by a
   * hardcoded id. It is now one row per organization — `AdvisorConfig`
   * carries `organizationId String @unique`, so the uniqueness that made the
   * singleton work is now per-tenant and the hardcoded id is gone.
   *
   * This also closes §11 precondition 4's highest-consequence remaining row:
   * `findFirst()` with no filter and no `orderBy` meant org B's advisor made LLM
   * calls on org A's API key, model and `baseUrl`, silently ignoring B's own row.
   */
  async getConfig(organizationId: string): Promise<AdvisorConfigInput | null> {
    const row = await this.prisma.advisorConfig.findUnique({ where: { organizationId } });
    // No saved row: fall back to the deployment's env config so a fresh
    // stack (Docker staging, a fresh clone) answers questions without anyone
    // opening the settings page first. A row always wins — saving in the UI
    // is an explicit operator override of the deployment default.
    if (!row) return advisorConfigFromEnv(this.env);
    if (row.provider === 'anthropic') {
      return { provider: 'anthropic', apiKey: row.apiKey ?? '', model: row.model };
    }
    return { provider: 'ollama', baseUrl: row.baseUrl ?? '', model: row.model };
  }

  async saveConfig(organizationId: string, input: AdvisorConfigInput): Promise<void> {
    const data = {
      provider: input.provider,
      model: input.model,
      apiKey: input.provider === 'anthropic' ? input.apiKey : null,
      baseUrl: input.provider === 'ollama' ? input.baseUrl : null,
    };
    await this.prisma.advisorConfig.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
  }

  /**
   * Whether the help route may offer `search_source`/`read_source` at all.
   *
   * Scoped like `getConfig`, and for the same reason: the row is per-organization
   * now, so an unfiltered `findFirst` would answer with whichever tenant's row
   * happened to come back first.
   *
   * Precedence mirrors `getConfig` exactly — a saved row is the operator's
   * explicit override, the environment is the deployment default — so an
   * operator does not have to reason about two different precedence rules for
   * two settings that live on the same row.
   */
  async isSourceLookupEnabled(organizationId: string): Promise<boolean> {
    const row = await this.prisma.advisorConfig.findUnique({ where: { organizationId } });
    if (row) return row.sourceLookupEnabled;
    return sourceLookupEnabledFromEnv(this.env);
  }

  /**
   * Flips the flag on the saved row. Returns `false` when there is no row to
   * flip, which the route reports as 409 rather than inventing one:
   * `AdvisorConfig` requires `provider` and `model`, so an upsert here would
   * have to fabricate provider credentials. A deployment with no row switches
   * source lookup off through `ADVISOR_SOURCE_LOOKUP` instead.
   */
  async setSourceLookupEnabled(organizationId: string, enabled: boolean): Promise<boolean> {
    const row = await this.prisma.advisorConfig.findUnique({ where: { organizationId } });
    if (!row) return false;
    await this.prisma.advisorConfig.update({
      where: { organizationId },
      data: { sourceLookupEnabled: enabled },
    });
    return true;
  }

  async testConnection(input: AdvisorConfigInput): Promise<AdvisorTestConnectionResult> {
    const started = Date.now();
    try {
      const provider = resolveProvider(input);
      await generateText({ model: provider.model, prompt: 'ping', maxOutputTokens: 1, maxRetries: 0 });
      return { ok: true, model: input.model, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, model: input.model, error: err instanceof Error ? err.message : 'connection failed' };
    }
  }
}
