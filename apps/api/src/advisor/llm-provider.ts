import { createAnthropic } from '@ai-sdk/anthropic';
import { createOllama } from 'ollama-ai-provider-v2';
import type { LanguageModel } from 'ai';

export type AdvisorProviderConfig =
  | { provider: 'anthropic'; apiKey: string; model: string }
  | { provider: 'ollama'; baseUrl: string; model: string };

export interface LlmProvider {
  model: LanguageModel;
  // Weak local models are poor at multi-tool calling. `local-tier.ts` reads this
  // to trim the tool set and lower the step ceiling for the Ollama tier; both
  // advisor services go through those helpers.
  //
  // This comment previously claimed "the loop uses this" while no production code
  // read the flag at all — declared, set, tested, and never connected.
  supportsRichTools: boolean;
}

export function resolveProvider(config: AdvisorProviderConfig): LlmProvider {
  switch (config.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: config.apiKey });
      return { model: anthropic(config.model), supportsRichTools: true };
    }
    case 'ollama': {
      const ollama = createOllama({ baseURL: `${config.baseUrl.replace(/\/$/, '')}/api` });
      return { model: ollama(config.model), supportsRichTools: false };
    }
    default:
      throw new Error(`unknown advisor provider: ${(config as { provider: string }).provider}`);
  }
}
