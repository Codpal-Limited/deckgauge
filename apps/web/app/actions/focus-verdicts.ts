'use server';
import type { FocusClassKey } from '@deckgauge/shared';
import { authFetch } from './api';
import { readApiError } from '../lib/read-api-error';

export type FocusVerdictOutcome = { ok: true } | { ok: false; error: string };

function verdictPath(boardId: string, fingerprint: string): string {
  return `/boards/${boardId}/focus/verdicts/${fingerprint}`;
}

/**
 * Record one person's class for one task.
 *
 * RETURNS its failure rather than throwing, for the reason `saveFocusStageMap`
 * documents: a thrown error inside a server action reaches the browser as an
 * opaque Next digest, and the message is the useful part here — the API refuses
 * a caller who has board access but no organization membership, and that
 * sentence explains an otherwise inexplicable non-response.
 *
 * `UNCLASSIFIED` is a real choice, not a clear. Clearing is `clearFocusVerdict`.
 */
export async function setFocusVerdict(
  boardId: string,
  fingerprint: string,
  cls: FocusClassKey,
  reason?: string,
): Promise<FocusVerdictOutcome> {
  const res = await authFetch(verdictPath(boardId, fingerprint), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // Omitted rather than sent empty: the schema rejects a blank reason, because
    // a reason column containing nothing reads in the ledger as a call with no
    // justification. Absent means "fill in who and when".
    body: JSON.stringify(reason?.trim() ? { class: cls, reason: reason.trim() } : { class: cls }),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true };
}

/** Forget the stored decision, so the classifiers below a human decide it again. */
export async function clearFocusVerdict(
  boardId: string,
  fingerprint: string,
): Promise<FocusVerdictOutcome> {
  const res = await authFetch(verdictPath(boardId, fingerprint), { method: 'DELETE' });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true };
}
