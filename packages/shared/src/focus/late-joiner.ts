import type { FocusWindow } from './attention-days.js';

const MS_PER_DAY = 86_400_000;

export interface MemberWindow {
  from: Date;
  to: Date;
  workingDays: number;
  isLateJoiner: boolean;
}

/** Weekdays in `[from, to)`. Public holidays are not modelled. */
export function countWorkingDays(from: Date, to: Date): number {
  let count = 0;
  for (let t = from.getTime(); t < to.getTime(); t += MS_PER_DAY) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

/**
 * The window a member's rates should be computed against.
 *
 * Anyone whose first recorded activity falls inside the reporting window is
 * measured from that date, not from the window start. On the reference window
 * this is the difference between 38% active days and 75% for the same person and
 * the same 21 days of work — the first reads as someone barely present, the
 * second as one of the more consistent contributors.
 *
 * **A start date presented as idleness is the worst error this view can make**,
 * so this is applied before any percentage, not offered as an option.
 *
 * No recorded activity at all is NOT a late joiner: there is nothing to measure,
 * and inferring a start date from silence is the same mistake in another form.
 */
export function resolveMemberWindow(
  firstActivity: Date | null,
  window: FocusWindow,
): MemberWindow {
  const isLateJoiner =
    firstActivity !== null &&
    firstActivity > window.from &&
    firstActivity < window.to;

  const from = isLateJoiner ? firstActivity : window.from;
  const effectiveFrom = firstActivity !== null && firstActivity >= window.to ? window.to : from;

  return {
    from: effectiveFrom,
    to: window.to,
    workingDays: countWorkingDays(effectiveFrom, window.to),
    isLateJoiner,
  };
}

/**
 * Share of working days on which a person did something, as a percentage.
 *
 * Capped at 100: weekend and holiday commits are real work but they are not
 * extra working days, and a figure over 100 reads as a bug rather than as
 * diligence.
 */
export function activeDayShare(activeDays: number, workingDays: number): number {
  if (workingDays <= 0) return 0;
  return Math.min(100, Math.round((activeDays / workingDays) * 100));
}
