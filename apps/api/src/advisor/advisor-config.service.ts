import type { PrismaClient } from '@deckgauge/db';
import { generateText } from 'ai';
import { resolveProvider } from './llm-provider.js';
import { advisorConfigFromEnv, sourceLookupEnabledFromEnv } from './advisor-config-env.js';
import type { AdvisorConfigInput } from '@deckgauge/shared';

const SINGLETON_ID = 'advisor-config-singleton';

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

  async getConfig(): Promise<AdvisorConfigInput | null> {
    const row = await this.prisma.advisorConfig.findFirst();
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

  async saveConfig(input: AdvisorConfigInput): Promise<void> {
    const data = {
      provider: input.provider,
      model: input.model,
      apiKey: input.provider === 'anthropic' ? input.apiKey : null,
      baseUrl: input.provider === 'ollama' ? input.baseUrl : null,
    };
    await this.prisma.advisorConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
  }

  /**
   * Whether the help route may offer `search_source`/`read_source` at all.
   *
   * Precedence mirrors `getConfig` exactly — a saved row is the operator's
   * explicit override, the environment is the deployment default — so an
   * operator does not have to reason about two different precedence rules for
   * two settings that live on the same row.
   */
  async isSourceLookupEnabled(): Promise<boolean> {
    const row = await this.prisma.advisorConfig.findFirst();
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
  async setSourceLookupEnabled(enabled: boolean): Promise<boolean> {
    const row = await this.prisma.advisorConfig.findFirst();
    if (!row) return false;
    await this.prisma.advisorConfig.update({
      where: { id: row.id },
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
