'use server';
import { authFetch } from './api';
import { readApiError } from '../lib/read-api-error';

export interface FocusClassificationRun {
  /** Tasks this run gave a class to. */
  classified: number;
  /** Tasks sent to the model, which is what the run cost. */
  modelCalls: number;
  /** Still unclassified. Non-zero means the budget ran out — press again. */
  remaining: number;
  model: string;
  promptVersion: string;
  /** Set when the provider failed mid-run; what it earned was still saved. */
  providerError?: string;
}

export type FocusClassifyOutcome =
  | { ok: true; result: FocusClassificationRun }
  /**
   * `status` rides along with the message because `FocusClassifyNotice` needs
   * to tell "no advisor configured" (409, and only 409 — see
   * `focus-classify.routes.ts`) apart from every other failure (403, 404, a
   * dropped connection) to decide whether to offer the local agent bridge.
   * The status code is the reliable signal; the message text is copy and
   * could change under it.
   */
  | { ok: false; error: string; status: number };

/**
 * Ask the advisor to classify what nothing cheaper could.
 *
 * RETURNS its failure rather than throwing, following the other focus actions: a
 * thrown error inside a server action reaches the browser as an opaque Next
 * digest, and the message is the whole point here — a board with no advisor
 * configured gets a 409 whose sentence is the only explanation the person has.
 *
 * The widget's config goes with the request so the run covers the window on
 * screen. Without it the run would classify the default window while the ledger
 * shows another, reporting work against tasks nobody is looking at.
 */
export async function runFocusClassification(
  boardId: string,
  config: Record<string, unknown>,
): Promise<FocusClassifyOutcome> {
  const res = await authFetch(`/boards/${boardId}/focus/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res), status: res.status };
  return { ok: true, result: (await res.json()) as FocusClassificationRun };
}
