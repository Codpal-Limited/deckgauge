/**
 * Extract a human-readable message from a non-ok API response.
 *
 * The `flatten` branch is not decoration: routes answer a malformed payload with
 * `error: <ZodError>.flatten()`, so a reader that only understands string
 * `error` / `message` falls through and renders raw JSON into the dialog.
 *
 * It was added here rather than in a second shared module. Three
 * implementations of this function exist today — this one, and local copies in
 * `actions/board-sources.ts` and `actions/advisor.ts` that lack the flatten
 * branch. Those two are deliberately untouched: folding divergent behaviours
 * together is its own change and does not belong inside a feature branch. This
 * version is a strict superset of the one it replaces — the flatten branch only
 * runs when both string branches miss — so `retired-projects.ts`, the existing
 * caller, gains a readable message where it previously showed raw JSON.
 */
export async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.message === 'string') return parsed.message;
    const flattened = parsed.error as
      | { formErrors?: string[]; fieldErrors?: Record<string, string[]> }
      | undefined;
    if (flattened && typeof flattened === 'object') {
      const messages = [
        ...(flattened.formErrors ?? []),
        ...Object.entries(flattened.fieldErrors ?? {}).map(
          ([field, errs]) => `${field}: ${errs.join(', ')}`,
        ),
      ].filter((m) => m.length > 0);
      if (messages.length > 0) return messages.join('; ');
    }
  } catch {
    // Body was not JSON — fall through to the raw text.
  }
  return text || `Request failed (${res.status})`;
}
