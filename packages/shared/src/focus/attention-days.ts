const MS_PER_DAY = 86_400_000;

export interface FocusTransition {
  /** Null when the task was created directly into `toState`. */
  fromState: string | null;
  toState: string;
  at: Date;
}

export interface FocusWindow {
  from: Date;
  to: Date;
}

/**
 * Calendar days this task spent in a working state, clipped to the window.
 *
 * This is a SHARE-OF-ATTENTION PROXY, not effort. Tasks overlap — on the
 * reference window one engineer held eleven in a working state at once, so his
 * days across tasks far exceed the days in the window. Any caller that presents
 * this as FTE effort is misreading it, and the widgets say so on their face.
 *
 * Note also that a task accrues days here whether or not anyone touched it. That
 * is deliberate: the parked-versus-moved distinction belongs to
 * `splitMovedParked`, which needs both numbers to make it.
 *
 * Transitions are sorted here rather than assumed sorted — ClickHouse returns
 * rows in no particular order unless asked, and a forgotten ORDER BY should not
 * quietly change an answer.
 */
export function attentionDaysInWindow(
  transitions: FocusTransition[],
  workingStates: readonly string[],
  window: FocusWindow,
): number {
  if (transitions.length === 0 || workingStates.length === 0) return 0;

  const working = new Set(workingStates);
  const ordered = [...transitions].sort((a, b) => a.at.getTime() - b.at.getTime());

  const windowFrom = window.from.getTime();
  const windowTo = window.to.getTime();
  let overlapMs = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i]!;
    if (!working.has(entry.toState)) continue;

    // The spell runs until the next transition, or to the window's end when the
    // task is still sitting in that state.
    const spellStart = entry.at.getTime();
    const spellEnd = ordered[i + 1]?.at.getTime() ?? windowTo;

    const from = Math.max(spellStart, windowFrom);
    const to = Math.min(spellEnd, windowTo);
    if (to > from) overlapMs += to - from;
  }

  return overlapMs / MS_PER_DAY;
}
