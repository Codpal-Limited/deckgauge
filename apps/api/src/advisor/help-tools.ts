import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { searchHelpCorpus, type HelpDoc } from './help-corpus.js';

/**
 * The Advisor's only tool in product-help mode.
 *
 * A miss returns an explicit note rather than the nearest doc: the whole point
 * of grounding is that "the docs don't cover this" is a better answer than a
 * confident irrelevant one.
 */
export function buildHelpTools(docs: readonly HelpDoc[]): ToolSet {
  return {
    search_product_help: tool({
      description:
        'Search the Deckgauge product documentation for how a feature works. Use this before answering any question about the product itself.',
      inputSchema: z.object({
        query: z.string().min(1).describe('The user question, or the key terms from it.'),
      }),
      execute: async ({ query }: { query: string }) => {
        const hits = searchHelpCorpus(docs, query);
        return {
          docs: hits.map((doc) => ({ title: doc.title, body: doc.body })),
          note:
            hits.length === 0
              ? 'This topic is not covered by the product documentation. Say so plainly rather than guessing.'
              : undefined,
        };
      },
    }),
  };
}
