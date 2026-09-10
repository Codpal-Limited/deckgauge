/**
 * Tells the rest of the page that a board just changed underneath it.
 *
 * Exactly two tools write anything through this signal — `propose_board_changes`
 * and `set_focus_verdicts` — whether the Advisor is answering over the SSE
 * route or a local agent bridge (`useLocalBridge`'s `toolCall` frames). They are
 * not the same kind of write: `propose_board_changes` persists a proposal (an
 * `AdvisorChangeSet` row) that a human later applies and does not itself touch
 * the board's own content (`apps/api/src/advisor/tools.ts`'s comment beside it
 * states the rule this is the one stated exception to), while `set_focus_verdicts`
 * writes board-visible state directly. Both still belong in this set, because
 * either one leaves something on the page stale until a refetch — the change-set
 * list for the first, the board's own classes for the second. Every read tool
 * (`get_team_overview`, `list_unclassified_tasks`, etc.) also arrives as a
 * `toolCall`, so the set below is what tells a mutation apart from a lookup;
 * naming it explicitly, rather than treating "any toolCall" as a signal, is what
 * keeps a read from causing a pointless refetch.
 *
 * Deliberately NOT part of `AdvisorContextValue`: a module-level subscriber
 * list lets a widget (e.g. `FocusLedgerWidget`) listen without needing
 * `AdvisorProvider` anywhere in its render tree, which is how its tests
 * already render it standalone.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'propose_board_changes',
  'set_focus_verdicts',
]);

/** Notified with the id of the board a mutating tool just wrote to. */
type BoardMutatedListener = (boardId: string) => void;

const listeners = new Set<BoardMutatedListener>();

/**
 * Subscribes to the signal. Returns an unsubscribe function — call it from a
 * `useEffect` cleanup so a widget that unmounts (or switches boards) stops
 * hearing about mutations it no longer cares about.
 */
export function subscribeBoardMutated(listener: BoardMutatedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `AdvisorProvider`'s entry point: call this with the toolCall's board id
 * (whichever board the ask was scoped to — may be absent for a help
 * conversation) and the tool name, on every `toolCall` frame regardless of
 * transport. A no-op unless both a board id is present and the name is one of
 * `MUTATING_TOOL_NAMES`.
 */
export function notifyToolCall(boardId: string | null | undefined, toolName: string): void {
  if (!boardId || !MUTATING_TOOL_NAMES.has(toolName)) return;
  for (const listener of listeners) listener(boardId);
}

/**
 * Test-only: clears every subscriber. The registry is module-level, not
 * per-test-file, so a test in this module's own suite that doesn't need (or
 * forgets) to call its `subscribeBoardMutated` return value leaves a dead
 * listener behind for every test that runs after it. Mirrors
 * `useCollapsedGroups.ts`'s `__resetForTest` convention.
 */
export function __resetForTest(): void {
  listeners.clear();
}

/**
 * Test-only probe: lets a test prove the registry is actually empty, rather
 * than trusting `__resetForTest` (or an individual test's own unsubscribe) to
 * have worked.
 */
export function __listenerCountForTest(): number {
  return listeners.size;
}
