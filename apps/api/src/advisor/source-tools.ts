import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { PathAllowlist } from './source-access/path-allowlist.js';
import { MAX_HITS, searchSourceLines } from './source-access/search-source.js';
import { MAX_READ_LINES, readSourceExcerpt } from './source-access/read-source.js';

export interface SourceToolDeps {
  /** The security boundary. Built once by the route from `resolveSourceRoots`. */
  allowlist: PathAllowlist;
  /**
   * Optional server-side reporting seam for an unexpected failure, mirroring
   * `PageStateToolDeps.logError`. The user-facing reason is fixed and never
   * carries the error itself.
   */
  logError?: (error: unknown) => void;
}

const searchInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'An identifier, symbol name, or exact phrase to look for — not a sentence. Matching is a case-insensitive substring, so "computeSchedule" works and "how does scheduling work" does not.',
    ),
});

const readInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('A path exactly as returned by search_source, relative to a source root.'),
  startLine: z.number().int().min(1).optional().describe('First line to read; defaults to 1.'),
  lineCount: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`How many lines to read; capped at ${MAX_READ_LINES}.`),
});

/**
 * The fixed reason an unexpected failure degrades to. Never the underlying
 * error: an internal message (a path, an errno, a stack) is not something to
 * hand a language model that will happily quote it back to a user.
 */
const FAILED = 'I could not read the source just now. Answer from the documentation instead.';

const LAST_RESORT =
  'Use this only as a LAST RESORT, after search_product_help and get_page_state have both failed to answer — it reads the product source code, so an answer from it is implementation detail rather than documented behaviour, and you must say that the answer came from the source. ';

/**
 * The Advisor's source-lookup tools.
 *
 * Offered only when the operator flag is on (`AdvisorConfigService.isSourceLookupEnabled`),
 * and every path they touch passes through `deps.allowlist` — three roots, three
 * extensions, `realpath`-resolved, symlinks rejected. The tools themselves hold
 * no path logic at all, so there is exactly one place where the boundary can be
 * weakened.
 *
 * Both tools degrade rather than throw, for the same reason `get_page_state`
 * does: a filesystem hiccup must leave the documentation free to answer instead
 * of aborting the whole reply. As there, the `logError` call is itself guarded,
 * so a broken logger cannot turn a degrade into a crash.
 */
export function buildSourceTools(deps: SourceToolDeps): ToolSet {
  return {
    search_source: tool({
      description:
        `${LAST_RESORT}Search the readable product source (apps/api/src, packages/shared/src, packages/db/prisma) for a line containing your query. ` +
        `Returns up to ${MAX_HITS} hits as path and line number. Follow up with read_source on a hit to see its surroundings.`,
      inputSchema: searchInput,
      execute: async ({ query }: z.infer<typeof searchInput>) => {
        try {
          return await searchSourceLines(deps.allowlist, { query });
        } catch (error: unknown) {
          report(deps, error);
          return { hits: [], hitsTruncated: false, filesScanned: 0, note: FAILED };
        }
      },
    }),

    read_source: tool({
      description:
        `${LAST_RESORT}Read a bounded excerpt of one readable product source file, at most ${MAX_READ_LINES} lines. ` +
        'Only .ts, .prisma and .md files inside the source roots can be read; anything else is refused with a reason.',
      inputSchema: readInput,
      execute: async (input: z.infer<typeof readInput>) => {
        try {
          return await readSourceExcerpt(deps.allowlist, input);
        } catch (error: unknown) {
          report(deps, error);
          return { ok: false, reason: FAILED };
        }
      },
    }),
  };
}

function report(deps: SourceToolDeps, error: unknown): void {
  try {
    deps.logError?.(error);
  } catch {
    // Diagnostic only, never load-bearing — a broken logger must not turn an
    // already-failing call into an uncaught exception. Deliberately swallowed.
  }
}
