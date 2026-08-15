import {
  fetchBoardSyncStatus,
  revalidateBoardData,
  triggerBoardSync,
  type BoardSyncStatus,
  type TriggerResult,
} from '../actions/board-sync';

export const SYNC_POLL_INTERVAL_MS = 1000;
export const SYNC_POLL_MAX_ITERATIONS = 30;

export interface SyncRunOutcome {
  kind: 'success' | 'error' | 'info';
  text: string;
}

/** Injectable clock so tests don't wait out the poll window. */
export interface SyncRunnerDeps {
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function describeTriggerFailure(reason: TriggerResult['reason']): string {
  switch (reason) {
    case 'queue_unavailable':
      return 'the sync queue is offline — contact an admin';
    case 'forbidden':
      return 'you need EDITOR access to sync this board';
    default:
      return 'the sync could not be triggered — try again';
  }
}

/**
 * Waits for the board's sync to report a `finishedAt` newer than the one it had
 * before the trigger. Returns null when the poll window elapses first — the sync
 * may well still be running, so callers should refresh anyway to show partial work.
 */
export async function pollForSyncCompletion(
  boardId: string,
  previousFinishedAt: string | null,
  deps: SyncRunnerDeps = {},
): Promise<BoardSyncStatus | null> {
  const sleep = deps.sleep ?? realSleep;
  for (let i = 0; i < SYNC_POLL_MAX_ITERATIONS; i++) {
    await sleep(SYNC_POLL_INTERVAL_MS);
    const next = await fetchBoardSyncStatus(boardId);
    if (next?.finishedAt && next.finishedAt !== previousFinishedAt) return next;
  }
  return null;
}

function pluralSources(count: number): string {
  return `${count} source${count === 1 ? '' : 's'}`;
}

/**
 * The sync half of "save changes": triggers a board sync, waits for it, and drops
 * the board's cached server data so the next render shows the synced rows.
 *
 * Every message says plainly that the settings were saved, because they were —
 * only the sync can fail from here, and a bare sync error next to a form the user
 * just submitted reads as "nothing was saved".
 */
export async function runSyncAfterSave(
  boardId: string,
  deps: SyncRunnerDeps = {},
): Promise<SyncRunOutcome> {
  const before = await fetchBoardSyncStatus(boardId);

  const triggered = await triggerBoardSync(boardId);
  if (!triggered.ok) {
    return {
      kind: 'error',
      text: `Saved, but ${describeTriggerFailure(triggered.reason)}.`,
    };
  }

  const finished = await pollForSyncCompletion(boardId, before?.finishedAt ?? null, deps);

  // Synced rows arrive through the board's server render, so the cache has to be
  // dropped whether the sync finished or merely made progress.
  await revalidateBoardData(boardId);

  const blocked = triggered.expired ?? [];
  if (blocked.length > 0) {
    return {
      kind: 'info',
      text: `Saved. Sync skipped ${pluralSources(blocked.length)} whose credentials need attention — see the badge above.`,
    };
  }

  if (!finished) {
    return { kind: 'info', text: 'Saved. The sync is still running — the board will catch up shortly.' };
  }

  return { kind: 'success', text: `Saved and synced — ${pluralSources(finished.sourceCount)} updated.` };
}
