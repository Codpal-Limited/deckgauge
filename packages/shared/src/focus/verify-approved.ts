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
 * - `unknown`    — nothing left Approved in the window. No evidence, no claim.
 */
export function verifyApprovedIsNotDone(
  transitions: FocusTransition[],
  workingStates: readonly string[],
): ApprovedCheck {
  const working = new Set(workingStates);
  const departures = transitions.filter((t) => t.fromState === APPROVED);
  const outOfApproved = departures.length;

  if (outOfApproved === 0) return { outOfApproved: 0, toWorking: 0, verdict: 'unknown' };

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
