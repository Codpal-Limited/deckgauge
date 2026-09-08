import type { FocusTransition } from './attention-days.js';

/**
 * Did anyone ever actually work on this task?
 *
 * The discriminator behind the WASTED EFFORT stage. A cancelled ticket nobody
 * touched cost nothing and is not a process signal; a cancelled ticket somebody
 * built is the thing worth counting. Only the second is reported, which is why
 * this predicate exists rather than the stage map simply having a `CANCELLED`
 * entry and being done with it.
 *
 * **Deliberately NOT window-clipped**, unlike every other measure in this
 * directory. A task worked six months ago and cancelled last week is wasted
 * effort in full; asking "did work happen inside the last 90 days" answers a
 * different and less useful question. On the reference board, in-window work
 * covers 12 of the 28 wasted-effort tasks — so a windowed predicate would drop
 * more than half of them. `buildFocusTransitionsSql` is already unwindowed for a
 * related reason, so the rows are in hand.
 *
 * `toState` only. Consulting `fromState` adds nothing: leaving a working state
 * requires having entered it, and that entry transition is always present —
 * including the `fromState: null` row that records a task created directly into
 * a working state.
 *
 * Empty `workingStates` is false, matching `attentionDaysInWindow`'s guard. With
 * no vocabulary there is no answer, and "everything counts" is the wrong default
 * for a figure the widget presents as waste.
 */
export function everEnteredWorkingState(
  transitions: FocusTransition[],
  workingStates: readonly string[],
): boolean {
  if (transitions.length === 0 || workingStates.length === 0) return false;

  const working = new Set(workingStates);
  return transitions.some((t) => working.has(t.toState));
}
