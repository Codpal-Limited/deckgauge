import {
  DEFAULT_STAGE_MAP,
  type FocusProvider,
  type FocusStage,
} from '../focus/delivery-stage.js';
import { isInProgressByStatusName } from '../timesheet/status-rules.js';

/**
 * What a tracker status MEANS, in the five words a business user reads.
 *
 * Ordered as work flows, which is also the order `bucketToFocusStage` is
 * asserted in — reordering this reorders that test's expectation, deliberately.
 */
export const STATUS_BUCKETS = [
  'TODO',
  'IN_PROGRESS',
  'WAITING_TO_SHIP',
  'DONE',
  'ABORTED',
] as const;

export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/**
 * The ONE place the two vocabularies meet.
 *
 * Team Focus stores `FocusStage` and the config panel speaks `StatusBucket`;
 * they are the same five things under two names, because the panel is read in
 * plain language by people who do not use Jira and the funnel is read as a
 * delivery pipeline. A second copy of this table anywhere is how they drift —
 * flagged in review on the branch that renamed `CANCELLED`'s label, and the
 * reason this function exists rather than an inline `Record`.
 *
 * `ABORTED` and `CANCELLED` are the pair to watch: the bucket is named after
 * what happened to the work, the stage key after the source state, and the key
 * cannot be renamed because it is a stored value in every board's
 * `FocusConfig.stageMap` JSON.
 */
const BUCKET_TO_STAGE: Record<StatusBucket, FocusStage> = {
  TODO: 'NOT_STARTED',
  IN_PROGRESS: 'IN_DEVELOPMENT',
  WAITING_TO_SHIP: 'WAITING_TO_SHIP',
  DONE: 'IN_PRODUCTION',
  ABORTED: 'CANCELLED',
};

export function bucketToFocusStage(bucket: StatusBucket): FocusStage {
  return BUCKET_TO_STAGE[bucket];
}

/**
 * Derived, never hand-written. A second literal here would be a second source
 * of truth for the same table — and `CANCELLED` proves the point: rule 1
 * intercepts every cancelled status before this map is consulted, so that entry
 * is unreachable and a hand-written one could be wrong indefinitely without a
 * test noticing. Inverting removes the surface rather than testing it.
 */
const STAGE_TO_BUCKET = Object.fromEntries(
  STATUS_BUCKETS.map((bucket) => [BUCKET_TO_STAGE[bucket], bucket]),
) as Record<FocusStage, StatusBucket>;

/**
 * Jira's three category names. `'Unknown'` is deliberately NOT one of them:
 * `statusCategoryOf` in the intelligence adapter writes that string whenever
 * Jira sent no category, and `jira_transitions.to_category` is `'Unknown'` for
 * every row by design. Treating it as a value would file the whole pool into
 * one bucket.
 */
const CATEGORY_TO_BUCKET: Record<string, StatusBucket> = {
  'To Do': 'TODO',
  'In Progress': 'IN_PROGRESS',
  Done: 'DONE',
};

/**
 * Statuses the curated map calls `WAITING_TO_SHIP` that the 2026-09-09 product
 * decision places in `IN_PROGRESS` instead: **QA counts as active work.**
 *
 * Narrow on purpose, and each exclusion is a judgement worth stating:
 * `QA In Progress` means QA is working the ticket, so it is somebody's labour.
 * `QA Ready` is NOT here — it means the ticket is waiting for QA to pick it up,
 * which is parked, and `NON_IN_PROGRESS_STATUSES` independently agrees: it
 * already lists `ready for qa analysis`. Nor is `Client Review`, which is
 * sign-off outside the team.
 *
 * `Live Testing` is NOT here either, and that one is genuinely arguable rather
 * than settled: it plausibly IS the team working, in production. It stays
 * parked because `DEFAULT_STAGE_MAP` was curated against these real workflows
 * and calls it `WAITING_TO_SHIP`, and because widening this set on a guess is
 * how an explicit decision about QA becomes an implicit decision about four
 * other states. It is one of the 16 whose hours stop, and it was approved as
 * part of that list — so if anyone disputes it, the answer is to move that one
 * row in the panel, not to edit this set.
 *
 * This set exists because rule 3 would otherwise silently overrule an explicit
 * decision whenever Jira supplies no category — and `delivery-stage.ts` names
 * this exact seam itself: "QA and client-review states are the arguable ones".
 */
const QA_IN_PROGRESS_OVERRIDES: ReadonlySet<string> = new Set(['QA In Progress']);

export interface SeedBucketInput {
  status: string;
  provider: FocusProvider;
  /** Jira's `status_category`; `null` for ADO and GitHub, which have none. */
  statusCategory: string | null;
}

/**
 * The bucket a status starts in, before anyone has said otherwise.
 *
 * Four rules, in this order, and the order is the design:
 *
 * 1. **Abandonment wins outright.** No status category expresses "the work was
 *    binned" — a cancelled Jira status carries category `Done`. So where the
 *    curated map knows a state means abandonment, that is the only place the
 *    fact exists, and letting the category overwrite it would file real
 *    cancelled work as delivered and overstate throughput.
 * 2. **Then the customer's own Jira category.** It is their statement about
 *    their workflow; `DEFAULT_STAGE_MAP` is our guess about it. For the three
 *    buckets a category can express, theirs outranks ours. This is also what
 *    implements the 2026-09-09 decision that QA counts as in-progress work:
 *    `QA In Progress` is `WAITING_TO_SHIP` in the curated map, and a Jira that
 *    calls it In Progress must still land it in `IN_PROGRESS`, or QA engineers
 *    show zero hours the day this ships.
 * 2.5 **Then the QA decision**, via `QA_IN_PROGRESS_OVERRIDES` — because rule 3
 *    would otherwise overrule it whenever Jira supplies no category, which is
 *    every ADO state and any Jira status not currently on an issue.
 * 3. **Then the curated map**, which is the only source for `WAITING_TO_SHIP`.
 *    Without this the fifth bucket starts empty on every source and the
 *    parked-time finding does not exist on day one.
 * 4. **Otherwise the status NAME**, via `isInProgressByStatusName` — and this
 *    one is load-bearing rather than a fallback. That predicate returns TRUE
 *    for anything it does not recognise ("Unknown/new statuses default to
 *    in-progress"), and every ADO state reaches the timesheet through it
 *    because ADO has no category. Seeding an unplaced status to `TODO` instead
 *    would take it out of the counted set and drop those hours to zero on the
 *    deploy — no error, no empty state, just lower numbers that read as a quiet
 *    quarter.
 *
 * **What is and is not preserved, stated precisely, because the loose version
 * of this sentence is a trap.** Rule 4 makes the seed agree with today's
 * counted-ness for every status ABSENT from `DEFAULT_STAGE_MAP`. It says
 * nothing about the 28 statuses the curated map places, because rule 3 fires
 * first and the name rule never runs for them — and **16 of those 28 stop
 * counting**, which is the deliberate correction the owner approved on
 * 2026-09-09. The exact 16 are pinned in `status-bucket.test.ts`. Rule 2 can
 * also move counted-ness the OTHER way for an uncurated status, when a
 * customer's Jira reports a category the name rule disagrees with; that
 * direction is pinned too. Do not read this function as a no-op.
 */
export function seedBucket({ status, provider, statusCategory }: SeedBucketInput): StatusBucket {
  const curated = DEFAULT_STAGE_MAP[provider][status];

  // 1 — abandonment, which no category can state.
  if (curated === 'CANCELLED') return 'ABORTED';

  // 2 — a curated PARKED reading, which no category can express either.
  //
  // Above the customer's category, and that ordering is the whole reason this
  // bucket exists at all. Jira has three categories — To Do, In Progress, Done
  // — so `CATEGORY_TO_BUCKET` has no `WAITING_TO_SHIP` member, and while rule 3
  // ran first NO Jira status carrying a real category could ever seed parked.
  // On the reference data that is every one of them: `Client Review`,
  // `Ready to Deploy` and `Live Testing` report `In Progress`, `QA Ready`
  // reports `To Do`, and the stage emptied from 821 tasks to zero the moment
  // anything consumed it. The owner asked for this bucket precisely to see "how
  // much time things are parked"; a category cannot answer that question, so it
  // does not get to overrule an answer that can.
  //
  // `Done` is the direction that matters most: it would file
  // finished-but-not-shipped work into the DELIVERED denominator, which is a
  // stronger claim than merely relabelling it.
  if (curated === 'WAITING_TO_SHIP') {
    // Except for the one the owner moved by name: "QA goes to in progress for
    // now." Inside this branch rather than after it, so the decision survives a
    // category as well as its absence.
    return QA_IN_PROGRESS_OVERRIDES.has(status) ? 'IN_PROGRESS' : 'WAITING_TO_SHIP';
  }

  // 3 — the customer's own category, for the three it covers. Still ahead of the
  // rest of the curated map: for every stage a category CAN express, the
  // customer knows their workflow better than a default written for everyone.
  const fromCategory = statusCategory === null ? undefined : CATEGORY_TO_BUCKET[statusCategory];
  if (fromCategory !== undefined) return fromCategory;

  // 4 — the rest of the curated map.
  if (curated !== undefined) return STAGE_TO_BUCKET[curated];

  // 5 — the name rule, so counted-ness does not move.
  return isInProgressByStatusName(status) ? 'IN_PROGRESS' : 'TODO';
}
