// EI-031 — server actions for the intelligence UI.
'use server';

import { authFetch } from './api';

interface SyncTriggerResult { ok: boolean; message: string; }

export async function triggerIntelligenceSync(
  source: 'jira' | 'github' | 'ado' | 'gitlab' | 'all',
): Promise<SyncTriggerResult> {
  try {
    const resp = await authFetch('/intelligence/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    if (!resp.ok) return { ok: false, message: `API ${resp.status} ${resp.statusText}` };
    return { ok: true, message: 'Sync enqueued.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Unknown error' };
  }
}
