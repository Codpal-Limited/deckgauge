import type { FocusTransition } from './attention-days.js';

export type ApprovedVerdict = 'groomed' | 'completion' | 'ambiguous' | 'unknown';

export interface ApprovedCheck {
  outOfApproved: number;
  toWorking: number;
  verdict: ApprovedVerdict;
}

const APPROVED = 'Approved';
/** Below this, the state is doing two jobs and the view should say so. */
const CLEAR_MAJORITY = 0.6;

/**
 * Check what `Approved` actually means in THIS project, from THIS window's
 * transitions, rather than trusting the stage map.
 *
 * In the reference project `Approved` means groomed and ready to start — the
 * observed path is New -> Approved -> In Progress. Reading it as completion put
 * roughly 30 phantom deliveries into an early draft of the report, so the view
 * re-derives it per window and prints what it found.
 *
 * Four answers, and three of them are not "groomed":
 * - `groomed`    — a clear majority left Approved into a working state;
 * - `completion` — a clear majority left it into something else, so it really
 *                  does mark finished work here and the stage map is wrong;
 * - `ambiguous`  — neither side is clear, meaning the state is doing two jobs.
 *                  Worth saying out loud rather than resolving by coin flip;
 * - `unknown`    — no evidence, no claim. TWO causes: nothing left Approved in
 *                  the window, or there is no working vocabulary to compare
 *                  departures against. `outOfApproved` tells them apart, and
 *                  the caveat says which.
 */
export function verifyApprovedIsNotDone(
  transitions: FocusTransition[],
  workingStates: readonly string[],
): ApprovedCheck {
  const working = new Set(workingStates);
  const departures = transitions.filter((t) => t.fromState === APPROVED);
  const outOfApproved = departures.length;

  if (outOfApproved === 0) return { outOfApproved: 0, toWorking: 0, verdict: 'unknown' };

  // No vocabulary, no claim — and this guard is load-bearing rather than
  // defensive. Without it the arithmetic reads silence as EVIDENCE: `toWorking`
  // is 0, `share` is 0, `1 - share >= CLEAR_MAJORITY` is true, and the verdict
  // is `completion` — the strongest claim here, rendered to the reader as "it
  // marks completed work in this project" on the strength of nothing.
  //
  // `outOfApproved` is REPORTED, not zeroed: the caveat needs it to tell this
  // apart from the case above, where genuinely nothing left Approved.
  if (working.size === 0) return { outOfApproved, toWorking: 0, verdict: 'unknown' };

  const toWorking = departures.filter((t) => working.has(t.toState)).length;
  const share = toWorking / outOfApproved;

  const verdict: ApprovedVerdict =
    share >= CLEAR_MAJORITY
      ? 'groomed'
      : 1 - share >= CLEAR_MAJORITY
        ? 'completion'
        : 'ambiguous';

  return { outOfApproved, toWorking, verdict };
}
