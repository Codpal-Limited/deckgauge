'use client';

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_PREFIX = 'deckgauge:collapsedGroups:';

function storageKey(boardId: string): string {
  return `${STORAGE_PREFIX}${boardId}`;
}

function readFromStorage(boardId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(boardId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function writeToStorage(boardId: string, value: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      storageKey(boardId),
      JSON.stringify([...value]),
    );
  } catch {
    // Quota / private mode / disabled storage — keep in-memory state, drop the write.
  }
}

// Module-level cache so `getSnapshot` returns the same Set reference until
// state actually changes. `useSyncExternalStore` requires snapshot stability.
const snapshots = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const EMPTY_SET: ReadonlySet<string> = new Set();

function getSnapshot(boardId: string): Set<string> {
  let s = snapshots.get(boardId);
  if (!s) {
    s = readFromStorage(boardId);
    snapshots.set(boardId, s);
  }
  return s;
}

function getServerSnapshot(): Set<string> {
  return EMPTY_SET as Set<string>;
}

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith(STORAGE_PREFIX)) {
      const boardId = e.key.slice(STORAGE_PREFIX.length);
      snapshots.set(boardId, readFromStorage(boardId));
      cb();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(cb);
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

function mutate(
  boardId: string,
  producer: (current: Set<string>) => Set<string>,
): void {
  const current = getSnapshot(boardId);
  const next = producer(current);
  snapshots.set(boardId, next);
  writeToStorage(boardId, next);
  notify();
}

export function useCollapsedGroups(boardId: string | undefined): {
  collapsed: Set<string>;
  toggle: (groupId: string) => void;
  collapseAll: (allGroupIds: string[]) => void;
} {
  const subscribeFn = useCallback(
    (cb: () => void) => (boardId ? subscribe(cb) : () => {}),
    [boardId],
  );
  const getSnap = useCallback(
    () => (boardId ? getSnapshot(boardId) : (EMPTY_SET as Set<string>)),
    [boardId],
  );

  const collapsed = useSyncExternalStore(
    subscribeFn,
    getSnap,
    getServerSnapshot,
  );

  const toggle = useCallback(
    (groupId: string) => {
      if (!boardId) return;
      mutate(boardId, (current) => {
        const next = new Set(current);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        return next;
      });
    },
    [boardId],
  );

  const collapseAll = useCallback(
    (allGroupIds: string[]) => {
      if (!boardId) return;
      mutate(boardId, () => new Set(allGroupIds));
    },
    [boardId],
  );

  return { collapsed, toggle, collapseAll };
}

// Test-only: clears module-level snapshot cache and listeners between test runs.
// Module-level state is necessary for useSyncExternalStore snapshot stability.
export function __resetForTest(): void {
  snapshots.clear();
  listeners.clear();
}
