import type { ApprovedVerdict } from './verify-approved.js';

export interface FocusCaveat {
  /** Short label, e.g. "Window", "Identity". */
  key: string;
  text: string;
}

export interface CaveatInputs {
  window: { from: Date; to: Date };
  /** Bounded early when a source stopped returning commits — see below. */
  commitWindowEndsAt?: Date | null;
  sources: string[];
  totalTasks: number;
  jiraOnlyCount?: number;
  mergedPairs: number;
  migrationCutoff?: Date | null;
  identityMerges?: number;
  identityPeople?: number;
  lateJoiners?: { name: string; from: Date }[];
  approved?: { verdict: ApprovedVerdict; outOfApproved: number; toWorking: number } | null;
  unclassified?: number;
  unmappedStates?: string[];
  /**
   * Tasks cancelled before any work began, excluded from the funnel's
   * population. Stated here because the caveats widget is the page-level
   * statement of what the render did — leaving it only on the funnel means the
   * page never accounts for the missing tasks.
   */
  cancelledNeverWorked?: number;
  /**
   * The FEATURE count, when the page is showing two grains.
   *
   * The funnel and the shipped ratio count features; provenance, the roadmap
   * share, board coverage and never-moved count issues. Two totals on one page
   * that are not meant to match is the kind of thing a reader reports as a bug,
   * so it is stated here — R6.15 makes this widget the page-level account of
   * what the render did. Omitted means "not applicable", not zero.
   */
  featureTaskCount?: number;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the caveat block from what this render actually did.
 *
 * Generated, not authored. A fixed list of disclaimers gets skimmed and stops
 * being read; a list where every entry corresponds to something that happened to
 * THIS window keeps its weight. So a caveat that does not apply is absent, not
 * greyed out — no late joiner, no late-joiner entry.
 *
 * Two entries are unconditional, because they are true of the method rather than
 * of the data: attention days are a proxy, and lines-changed is unavailable.
 * Dropping either would let someone quote a number the view cannot support.
 */
export function buildFocusCaveats(input: CaveatInputs): FocusCaveat[] {
  const out: FocusCaveat[] = [];

  out.push({
    key: 'Window',
    text: `${isoDay(input.window.from)} to ${isoDay(input.window.to)}.`,
  });

  if (input.commitWindowEndsAt && input.commitWindowEndsAt < input.window.to) {
    out.push({
      key: 'Commit window',
      text:
        `Commit data stops at ${isoDay(input.commitWindowEndsAt)}, so commit and active-day ` +
        `figures are bounded there. This is a data boundary, not inactivity.`,
    });
  }

  if (input.featureTaskCount !== undefined) {
    out.push({
      key: 'Two grains',
      text:
        `The delivery funnel and the shipped ratio count ${input.featureTaskCount} FEATURES — ` +
        `issues rolled up to the top-level item they hang under, so work on a sub-task ` +
        `counts for its epic. Every other figure on this page counts ` +
        `${input.totalTasks} issues. The two are not meant to match.`,
    });
  }

  if (input.cancelledNeverWorked !== undefined && input.cancelledNeverWorked > 0) {
    out.push({
      key: 'Cancelled before starting',
      text:
        `${input.cancelledNeverWorked} tasks were cancelled before any work began and are ` +
        `excluded from the delivery-stage counts. They are not stalled work and they are ` +
        `not work at all, so counting them either way would misdescribe the window.`,
    });
  }

  out.push({
    key: 'Systems',
    text: `${input.sources.join(' and ')} — ${input.totalTasks} tasks after de-duplication.`,
  });

  if (input.jiraOnlyCount !== undefined && input.jiraOnlyCount < input.totalTasks) {
    out.push({
      key: 'Both systems',
      text:
        `Counting one system alone would have found ${input.jiraOnlyCount} tasks rather than ` +
        `${input.totalTasks}. A window that spans a migration must count both.`,
    });
  }

  if (input.mergedPairs > 0) {
    out.push({
      key: 'De-duplication',
      text:
        `${input.mergedPairs} ${input.mergedPairs === 1 ? 'task' : 'tasks'} existed in both ` +
        `systems and ${input.mergedPairs === 1 ? 'was' : 'were'} merged on a normalised title: ` +
        `keys stripped, brackets removed, punctuation collapsed.`,
    });
  }

  if (input.migrationCutoff) {
    out.push({
      key: 'Task age',
      text:
        `Changelog entries at or before ${input.migrationCutoff.toISOString().slice(0, 16)} are ` +
        `treated as migration artifacts, not work. Origin dates come from the older system ` +
        `where a task exists in both.`,
    });
  }

  if (input.identityMerges && input.identityPeople) {
    out.push({
      key: 'Identity',
      text:
        `${input.identityMerges} logins resolved to ${input.identityPeople} people, matched on ` +
        `email rather than display name. A wrong merge is as damaging as a missing one, and this ` +
        `view cannot show you which merges it made.`,
    });
  }

  for (const joiner of input.lateJoiners ?? []) {
    out.push({
      key: 'Late joiner',
      text:
        `${joiner.name}: first recorded ticket movement ${isoDay(joiner.from)}. Every rate for ` +
        `this person runs from that date, not the full window. Commits are not yet ` +
        `counted in this date, so a person who was committing earlier will have a ` +
        `window that is too short and a rate that is flattered.`,
    });
  }

  if (input.approved && input.approved.verdict !== 'unknown') {
    const { verdict, outOfApproved, toWorking } = input.approved;
    const finding =
      verdict === 'groomed'
        ? `counted as NOT started`
        : verdict === 'completion'
          ? `counted as started — it marks completed work in this project`
          : `doing two jobs here, so its tasks may be misplaced in the funnel`;
    out.push({
      key: '"Approved"',
      text: `${toWorking} of ${outOfApproved} transitions out of Approved led to a working state — ${finding}.`,
    });
  } else if (input.approved) {
    out.push({
      key: '"Approved"',
      text:
        `Nothing left the Approved state in this window, so what it means here could not be ` +
        `verified. It is counted as not started on the shipped default.`,
    });
  }

  if (input.unmappedStates?.length) {
    out.push({
      key: 'Unmapped states',
      text:
        `${input.unmappedStates.join(', ')} are not in this board's stage map and were counted ` +
        `as not started, which empties the two middle bars of the delivery funnel. Map them with ` +
        `"Configure stage map" on the Where the Work Ended Up widget.`,
    });
  }

  if (input.unclassified) {
    out.push({
      key: 'Unclassified',
      text:
        `${input.unclassified} tasks carry no classification, most often because no advisor ` +
        `model is configured. They are excluded from the class split rather than assumed.`,
    });
  }

  out.push({
    key: 'Attention days',
    text:
      `A share-of-attention proxy, not effort. Tasks overlap — one person can hold a dozen in ` +
      `a working state at once, so their days across tasks can exceed the days in the window.`,
  });

  out.push({
    key: 'Not measured',
    text:
      `Lines changed and pull-request size. Azure DevOps reports zero additions and deletions ` +
      `on nearly all pull requests and counts files rather than lines, so any metric built on ` +
      `it would be wrong. Omitted rather than estimated.`,
  });

  return out;
}
