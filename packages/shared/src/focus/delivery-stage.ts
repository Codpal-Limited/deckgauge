/**
 * Ordered as the funnel draws them: shipped, nearly shipped, being built,
 * abandoned, never begun.
 *
 * `CANCELLED` is a value a board SELECTS in the stage-map editor, and it means
 * only "this state means the work was abandoned". Whether such a task is
 * actually COUNTED is derived rather than configured — see
 * `everEnteredWorkingState` and `tallyDeliveryStages`.
 */
export type FocusStage =
  | 'IN_PRODUCTION'
  | 'WAITING_TO_SHIP'
  | 'IN_DEVELOPMENT'
  | 'CANCELLED'
  | 'NOT_STARTED';

export type FocusProvider = 'jira' | 'ado';

export type StageMap = Record<FocusProvider, Record<string, FocusStage>>;

/**
 * The shipped default, editable per board.
 *
 * The boundary between IN_DEVELOPMENT and WAITING_TO_SHIP is **merged**, and it
 * is the most important line in this file. In development is the engineer's to
 * finish; waiting to ship is not. Keeping them apart is what lets the view say
 * the bottleneck sits downstream of the engineers rather than reporting "56
 * unfinished tasks", which reads as the opposite.
 *
 * QA and client-review states are the arguable ones — they are 14 of the 38
 * waiting-to-ship tasks on the reference window — which is why boards can edit
 * this rather than argue with it.
 */
export const DEFAULT_STAGE_MAP: StageMap = {
  jira: {
    Done: 'IN_PRODUCTION',

    'Ready to Deploy': 'WAITING_TO_SHIP',
    'Client Review': 'WAITING_TO_SHIP',
    'QA Ready': 'WAITING_TO_SHIP',
    'QA In Progress': 'WAITING_TO_SHIP',
    'Live Testing': 'WAITING_TO_SHIP',

    'In Progress': 'IN_DEVELOPMENT',
    'Code Review': 'IN_DEVELOPMENT',

    /**
     * Abandoned, not stalled. Only counted when someone actually worked the
     * ticket — see `tallyDeliveryStages`. On the reference board this covers 150
     * tickets, of which 28 were worked and 122 were never touched.
     */
    Cancelled: 'CANCELLED',

    'To Do': 'NOT_STARTED',
    'On Hold': 'NOT_STARTED',
    Blocked: 'NOT_STARTED',
  },
  ado: {
    Done: 'IN_PRODUCTION',
    Closed: 'IN_PRODUCTION',
    'Deployed to All Prod': 'IN_PRODUCTION',
    'Deployed to ZA': 'IN_PRODUCTION',
    'Deployed to Africa1': 'IN_PRODUCTION',

    'Pull Request Done': 'WAITING_TO_SHIP',
    'Deployed to Uat': 'WAITING_TO_SHIP',
    'Deployed to Dev': 'WAITING_TO_SHIP',

    'In Progress': 'IN_DEVELOPMENT',
    'Pull Request Doing': 'IN_DEVELOPMENT',
    'Send Back to Dev': 'IN_DEVELOPMENT',

    New: 'NOT_STARTED',
    'To Do': 'NOT_STARTED',
    /**
     * Groomed and ready to start, NOT finished. The observed path is
     * New -> Approved -> In Progress, and `verifyApprovedIsNotDone` re-checks it
     * against each window's own transitions rather than trusting this line.
     */
    Approved: 'NOT_STARTED',
    'On Hold': 'NOT_STARTED',
    /**
     * Moved off NOT_STARTED when the CANCELLED stage arrived. Removed work is
     * abandoned rather than un-started, and the worked/untouched split is what
     * makes it reportable. Deployment-wide at the time of the change this
     * reclassified 783 worked items as wasted effort and took 2,224 untouched
     * ones out of ADO denominators — observable on no board then, since none
     * carried Focus widgets, which is luck rather than safety.
     */
    Removed: 'CANCELLED',
  },
};

export function mapDeliveryStage(
  state: string,
  provider: FocusProvider,
  map: StageMap,
): FocusStage {
  return map[provider][state] ?? 'NOT_STARTED';
}

export interface StageTally {
  counts: Record<FocusStage, number>;
  /** States the map did not know, each listed once. */
  unmapped: string[];
  /**
   * Cancelled tasks nobody ever worked on — excluded from `counts` AND from any
   * total derived from it.
   *
   * Reported rather than silently dropped, for the same reason `unmapped` is a
   * named list: an exclusion nobody can see is indistinguishable from a bug. The
   * auditable invariant is `sum(counts) + cancelledNeverWorked === tasks.length`.
   */
  cancelledNeverWorked: number;
}

/**
 * Count tasks by stage, report any state the map could not place, and hold back
 * cancelled work nobody ever started.
 *
 * An unknown state still lands in NOT_STARTED so the totals always add up, but
 * it is also named — silently defaulting is how a workflow state someone added
 * last month becomes a growing stalled pile that nobody can account for.
 *
 * `everWorked` is the one input that is not a property of `(state, provider)`,
 * and it is why this function takes tasks rather than a map lookup being enough.
 * A cancelled task somebody built is wasted effort worth reporting; a cancelled
 * task nobody touched was never work at all, and the widget it feeds is titled
 * "Where the Work Ended Up". So the second kind leaves the population entirely
 * rather than being counted as not started, which would describe untouched
 * cancellations as a stalled pile.
 *
 * The flag is REQUIRED, not defaulted. A caller that forgets must fail to
 * compile: a silent `everWorked: false` would quietly delete every cancelled
 * task from the funnel, and a silent `true` would count 122 untouched tickets on
 * the reference board as wasted effort. Neither is a safe default, so there is
 * none.
 */
export function tallyDeliveryStages(
  tasks: readonly { state: string; provider: FocusProvider; everWorked: boolean }[],
  map: StageMap,
): StageTally {
  const counts: Record<FocusStage, number> = {
    IN_PRODUCTION: 0,
    WAITING_TO_SHIP: 0,
    IN_DEVELOPMENT: 0,
    CANCELLED: 0,
    NOT_STARTED: 0,
  };
  const unmapped = new Set<string>();
  let cancelledNeverWorked = 0;

  for (const t of tasks) {
    if (map[t.provider][t.state] === undefined) unmapped.add(t.state);

    const stage = mapDeliveryStage(t.state, t.provider, map);
    if (stage === 'CANCELLED' && !t.everWorked) {
      cancelledNeverWorked += 1;
      continue;
    }
    counts[stage] += 1;
  }

  return { counts, unmapped: [...unmapped], cancelledNeverWorked };
}
