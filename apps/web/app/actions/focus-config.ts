'use server';
import type { FocusStageMapSettings, StageMapOverrides } from '@deckgauge/shared';
import { authFetch } from './api';
import { readApiError } from '../lib/read-api-error';

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
