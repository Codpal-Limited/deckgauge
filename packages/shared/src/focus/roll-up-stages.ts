import type { FocusStage } from './delivery-stage.js';

/**
 * Which stage a FEATURE is in, given the stages of the issues under it.
 *
 * **The order below IS the rule**, which is why it is a list rather than a chain
 * of conditions: active work wins, and shipped beats cancelled. A feature is
 * being built if anyone is building any part of it — the board owner's framing,
 * and the reason an epic whose own status has not moved for months stops reading
 * as idle:
 *
 * > If someone work on an issue, the work should be counted for the top level
 * > feature. So if I am "In progress" on a task, it should be counted as I am
 * > "In progress" on the Epic.
 *
 * **`CANCELLED` sits LAST, and it was second-to-last until review.** A feature
 * reads as wasted effort only when EVERY child was cancelled — the whole thing
 * abandoned — which is what this comment always claimed and what the code did
 * not do. Ranked above `NOT_STARTED`, a feature with one cut sub-task and one
 * unstarted one rolled to `CANCELLED`, then took the caller's never-worked
 * exclusion branch and told the reader it "was cancelled before any work began":
 * a feature that was never cancelled, still holding live scope, gone from the
 * page. R6.9 makes "Not started / stalled" one of the five stages that must be
 * reported.
 *
 * Zero of the 36 affected features on the reference board actually held an
 * unstarted child, so no published figure moved — it was latent, not wrong on
 * that data, which is exactly why only a test could find it.
 *
 * **What this loses, and where it is recovered.** A feature with one shipped
 * child and ten cancelled ones reads `IN_PRODUCTION`: something did ship. Those
 * ten binned children leave the bar entirely — and their days are reported by
 * `wastedDaysInsideLiveFeatures`, which is the only reason losing them here is
 * acceptable. Drop that second figure and this precedence starts hiding waste.
 *
 * **`IN_PRODUCTION` sits BELOW `NOT_STARTED`, and it was above it until a board
 * owner read the funnel.** A feature is in production only when nothing under
 * it is still unstarted. Ranked above, one `Done` sub-task beat two `To Do` ones
 * and an epic in `In Progress` (`PROJ-496` on the reporting board): the funnel
 * called a feature landed in production while most of its scope had not begun,
 * and the remaining work left the page — the SAME defect the CANCELLED demotion
 * above was corrected for, in the one pair of stages that correction did not
 * revisit. Nine of the ten stage assertions in `roll-up-stages.test.ts` hold
 * under BOTH orders, which is why only a reader of the widget found it.
 *
 * `workedChildren` is counted across every stage, not just cancelled ones,
 * because the caller needs it to apply the never-worked exclusion at the root:
 * a feature nobody ever worked was never work.
 */
const PRECEDENCE: readonly FocusStage[] = [
  'IN_DEVELOPMENT',
  'WAITING_TO_SHIP',
  'NOT_STARTED',
  'IN_PRODUCTION',
  'CANCELLED',
];

export function rollUpStages(
  children: readonly { stage: FocusStage; everWorked: boolean }[],
): { stage: FocusStage; workedChildren: number } {
  let workedChildren = 0;
  const present = new Set<FocusStage>();

  for (const c of children) {
    present.add(c.stage);
    if (c.everWorked) workedChildren += 1;
  }

  // Total rather than partial: a root always has children in practice, since
  // roots are derived FROM the in-window issues, but "nothing here" has an
  // honest answer and a function that throws on it is harder to reason about.
  const stage = PRECEDENCE.find((s) => present.has(s)) ?? 'NOT_STARTED';

  return { stage, workedChildren };
}
