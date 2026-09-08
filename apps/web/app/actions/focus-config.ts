'use server';
import type { FocusStageMapSettings, StageMapOverrides } from '@deckgauge/shared';
import { authFetch } from './api';

/**
 * Extract a human-readable message from a non-ok API response.
 *
 * The object branch is not decoration: both routes answer a malformed payload
 * with `error: <ZodError>.flatten()`, so a string-only reader falls through and
 * renders raw JSON into the dialog. Unreachable from this editor, which cannot
 * build a bad payload — but the branch exists, so it says something.
 */
async function readApiError(res: Response): Promise<string> {
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

/**
 * The stage-map settings for one board: the states its sources report, what it
 * has overridden, and what is still unmapped.
 */
export async function fetchFocusStageMap(boardId: string): Promise<FocusStageMapSettings> {
  const res = await authFetch(`/boards/${boardId}/focus/stage-map`);
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()) as FocusStageMapSettings;
}

export type SaveStageMapOutcome =
  | { ok: true; settings: FocusStageMapSettings }
  | { ok: false; error: string };

/**
 * Persist a board's stage-map overrides.
 *
 * RETURNS its failure rather than throwing. A thrown error inside a server
 * action reaches the browser as an opaque Next digest, and the message this
 * endpoint produces is the useful part — it names the state the board's sources
 * do not report, which is the whole reason the write is refused.
 */
export async function saveFocusStageMap(
  boardId: string,
  overrides: StageMapOverrides,
): Promise<SaveStageMapOutcome> {
  const res = await authFetch(`/boards/${boardId}/focus/stage-map`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true, settings: (await res.json()) as FocusStageMapSettings };
}
