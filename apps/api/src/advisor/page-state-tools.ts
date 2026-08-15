import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { resolvePageState } from './page-state/page-state.resolver.js';
import type { PageStateDeps } from './page-state/page-state.types.js';

const inputSchema = z.object({
  itemName: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The name of the item the question is about, when the question names one (used by the roadmap page; ignored elsewhere).',
    ),
});

type GetPageStateInput = z.infer<typeof inputSchema>;

export interface PageStateToolDeps extends PageStateDeps {
  pageKey: string;
  /**
   * Optional server-side reporting seam for a resolver failure. The
   * user-facing `reason` is fixed and must never carry the error itself — a
   * provider-visible tool result is the wrong place for internal detail —
   * but swallowing the error everywhere would leave a genuine database
   * outage indistinguishable from ordinary degradation in the logs. The
   * route supplies this from its own logger; tests need not.
   */
  logError?: (error: unknown) => void;
}

/**
 * Reads the user's own configuration for the page they asked from.
 *
 * The page and the board are closure state, set by the route AFTER
 * authorization — deliberately not tool inputs, so the model cannot ask for
 * another page's or another board's configuration. The only input is which
 * roadmap item the question is about.
 *
 * A resolver failure becomes `available: false`, never an exception: a
 * database hiccup must degrade to "I can't read your configuration" and let
 * the documentation answer, not abort the whole reply. That promise holds
 * even if `logError` itself throws — logging is diagnostic only and must
 * never be able to turn a degrade into a crash, so its call is guarded by
 * its own try/catch below.
 */
export function buildPageStateTools(deps: PageStateToolDeps): ToolSet {
  return {
    get_page_state: tool({
      description:
        "Read the user's own Deckgauge configuration and data for the screen they are on — not how the feature works in general. " +
        'For example: NOT for "how does the timesheet decide what counts as in progress" or "how do roadmap sizes map to durations" — those are documentation questions, answered by search_product_help. ' +
        'YES for "is my In Review status actually counting hours", "why hasn\'t my GitHub source synced", or "why is this roadmap item scheduled after that one" — those need this instance\'s actual configuration. ' +
        'If it reports available:false, fall back to the documentation instead.',
      inputSchema,
      execute: async ({ itemName }: GetPageStateInput) => {
        try {
          return await resolvePageState(deps.pageKey, deps, { itemName });
        } catch (error: unknown) {
          try {
            deps.logError?.(error);
          } catch {
            // Logging is diagnostic only, never load-bearing: a broken
            // logger (misconfigured, or rejecting a non-serializable
            // payload) must not turn this already-failing call into an
            // uncaught exception on top of the resolver failure it was
            // trying to record. Deliberately swallowed.
          }
          return {
            available: false,
            reason:
              "I could not read your configuration just now. Answer from the documentation, and say that you could not check this instance's settings.",
          };
        }
      },
    }),
  };
}
