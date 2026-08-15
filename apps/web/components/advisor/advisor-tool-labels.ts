/**
 * Human labels for the tools the Advisor ran, shown in an answer's receipts
 * disclosure.
 *
 * The panel used to render raw tool names, which made a source-derived answer
 * indistinguishable from a documented one unless the reader happened to know
 * what `read_source` means. The Advisor's source tools read implementation
 * detail rather than documented behaviour, so the spec requires those answers to
 * be *labelled* — this map is where that labelling happens.
 *
 * Both source tools share one label on purpose: a search-then-read pair is a
 * single claim about where the answer came from, not two.
 */
const TOOL_LABELS = new Map<string, string>([
  ['search_product_help', 'product documentation'],
  ['get_page_state', 'your configuration'],
  ['search_source', 'derived from source'],
  ['read_source', 'derived from source'],
]);

/**
 * A `Map`, not an object literal, and looked up with `get`: tool names arrive
 * from the server's SSE payload, so a name like `constructor` or `toString`
 * would otherwise resolve through `Object.prototype` and render a function's
 * source as a receipt label. The same trap `page-state.resolver.ts` was fixed
 * for on the API side.
 */
export function advisorToolLabel(toolName: string): string {
  return TOOL_LABELS.get(toolName) ?? toolName;
}

/**
 * The labels to show for one answer: deduplicated, in the order the tools were
 * first used. Three `read_source` calls are one provenance claim, so rendering
 * three identical pills would just be noise.
 */
export function advisorReceiptLabels(toolNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const name of toolNames) {
    const label = advisorToolLabel(name);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}
