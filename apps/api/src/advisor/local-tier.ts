import { MAX_STEPS } from "./advisor.service.js";
import type { LlmProvider } from "./llm-provider.js";

/**
 * Step ceiling for providers that are poor at multi-tool calling.
 *
 * `MAX_STEPS` (6) is tuned for a fast hosted model. On CPU-only inference every
 * step re-prefills a growing prefix, so six round trips is the difference
 * between minutes and tens of minutes per answer (spec §5.1).
 */
export const LOCAL_MAX_STEPS = 3;

type Tiered = Pick<LlmProvider, "supportsRichTools">;

export function stepsForProvider(provider: Tiered): number {
  return provider.supportsRichTools ? MAX_STEPS : LOCAL_MAX_STEPS;
}

/**
 * Narrows a tool set for weak local models.
 *
 * `llm-provider.ts` has declared `supportsRichTools` since the Ollama provider
 * was added, and its comment claimed "the loop uses this to trim the tool set" —
 * but no production code read it. This is that trim, in one place, so the two
 * advisor services cannot drift apart.
 *
 * Fails CLOSED: if none of `keep` is present the result is empty, never the full
 * set. Handing a weak model every tool is the failure this module prevents.
 */
export function toolsForProvider<T extends Record<string, unknown>>(
  provider: Tiered,
  tools: T,
  keep: readonly string[],
): T {
  if (provider.supportsRichTools) return tools;
  // Returned as `T`, not `Partial<T>`, on purpose. Callers pass index-signature
  // records (`ToolSet` is `Record<string, Tool>`), and a record with fewer entries
  // is still a valid record of that type — whereas `Partial<T>` widens every value
  // to `| undefined`, which `streamText` rejects and which invites an `as` cast at
  // each call site. The values here are never undefined: only present keys copy.
  const out = {} as T;
  for (const name of keep) {
    if (name in tools) {
      out[name as keyof T] = tools[name as keyof T];
    }
  }
  return out;
}
