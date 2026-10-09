// EI-031 — server actions for the intelligence UI.
'use server';

import { authFetch } from './api';

type SyncSource = 'jira' | 'github' | 'ado' | 'gitlab';

/**
 * `tone` drives how the trigger renders the result. `notice` is the issue #8 case —
 * a sync (or part of one) that had nothing attached to fetch. That is not a
 * failure of the product, so it is not shown in error-red.
 */
export interface SyncTriggerResult {
  ok: boolean;
  tone: 'success' | 'notice' | 'error';
  message: string;
}

const SOURCE_LABEL: Record<SyncSource, string> = {
  jira: 'Jira',
  github: 'GitHub',
  ado: 'Azure DevOps',
  gitlab: 'GitLab',
};

// The heading of the /sources panel that attaches each source's projects/repos.
const ATTACH_PANEL: Record<SyncSource, string> = {
  jira: 'Jira project syncs',
  github: 'GitHub repo syncs',
  ado: 'Azure DevOps project syncs',
  gitlab: 'GitLab project syncs',
};

const ATTACH_NOUN: Record<SyncSource, string> = {
  jira: 'a project',
  github: 'a repo',
  ado: 'a project',
  gitlab: 'a project',
};

function isSource(s: unknown): s is SyncSource {
  return s === 'jira' || s === 'github' || s === 'ado' || s === 'gitlab';
}

function nothingAttachedHint(source: SyncSource): string {
  return `${SOURCE_LABEL[source]} has nothing attached — add ${ATTACH_NOUN[source]} under "${ATTACH_PANEL[source]}" on this page, or in a board's Sources tab.`;
}

function sourceList(value: unknown): SyncSource[] {
  return Array.isArray(value) ? value.filter(isSource) : [];
}

export async function triggerIntelligenceSync(
  source: SyncSource | 'all',
): Promise<SyncTriggerResult> {
  try {
    const resp = await authFetch('/intelligence/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const body = (await resp.json().catch(() => ({}))) as {
      error?: string;
      sources?: unknown;
      enqueued?: unknown;
      skipped?: unknown;
    };

    if (resp.status === 409 && body.error === 'NOTHING_TO_SYNC') {
      const sources = sourceList(body.sources);
      return {
        ok: false,
        tone: 'notice',
        message: ['Nothing to sync.', ...sources.map(nothingAttachedHint)].join(' '),
      };
    }
    if (!resp.ok) {
      return { ok: false, tone: 'error', message: `API ${resp.status} ${resp.statusText}`.trim() };
    }

    const skipped = sourceList(body.skipped);
    if (skipped.length === 0) return { ok: true, tone: 'success', message: 'Sync enqueued.' };
    const enqueued = sourceList(body.enqueued).map((s) => SOURCE_LABEL[s]);
    return {
      ok: true,
      tone: 'notice',
      message: [`Sync enqueued for ${enqueued.join(', ')}.`, ...skipped.map(nothingAttachedHint)].join(' '),
    };
  } catch (err) {
    return { ok: false, tone: 'error', message: err instanceof Error ? err.message : 'Unknown error' };
  }
}
