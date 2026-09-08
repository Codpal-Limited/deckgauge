import {
  DEFAULT_STAGE_MAP,
  mergeTaskSets,
  attentionDaysInWindow,
  attentionDaysByClass,
  attentionSharesByClass,
  buildFocusCaveats,
  countMovesInWindow,
  everEnteredWorkingState,
  mapDeliveryStage,
  resolveEpicKey,
  resolveMemberWindow,
  rollUpStages,
  splitMovedParked,
  tallyDeliveryStages,
  verifyApprovedIsNotDone,
  type FocusCaveat,
  type FocusClassKey,
  type FocusProvider,
  type FocusStage,
  type FocusTransition,
  type FocusWindow,
  type StageMap,
} from '@deckgauge/shared';
import type { ResolvedVerdict } from '@deckgauge/shared';

export interface FocusTaskRow {
  task_key: string;
  description: string | null;
  provider: FocusProvider;
  title: string;
  state: string;
  assignee: string | null;
  epic_key: string | null;
  created_at: string;
}

export interface FocusTransitionRow {
  task_key: string;
  from_state: string | null;
  to_state: string;
  at: string;
  changed_by: string | null;
}

export interface FocusSnapshotInput {
  tasks: FocusTaskRow[];
  transitions: FocusTransitionRow[];
  verdicts: Map<string, ResolvedVerdict>;
  window: FocusWindow;
  workingStates: readonly string[];
  stageMap?: StageMap;
  /**
   * Issue key -> its parent's key, for the WHOLE board and all time.
   *
   * Required, not optional. An omitted map roots every issue at itself, so the
   * feature counts silently equal the issue counts — a plausible-looking wrong
   * answer, which is exactly the invisible-dropped-argument shape that shipped
   * unpinned on the previous branch. A caller that forgets must fail to compile.
   *
   * Unwindowed on purpose: a parent untouched in the window is still the parent.
   * See `buildFocusParentsSql`.
   */
  parentOf: Map<string, string>;
  migrationCutoff?: Date | null;
  /** First recorded activity per assignee, for the late-joiner floor. */
  firstActivity?: Map<string, Date>;
  onBoardKeys?: ReadonlySet<string>;
  /**
   * When this organisation's sources last completed a sync. Null means never.
   *
   * Carried so an empty result can say WHY it is empty. Without it every widget
   * reports "no tasks in this window", which is the sentence R6.12 forbids: a
   * board whose sync has never run, or has silently degraded, is
   * indistinguishable from a team that did nothing.
   */
  sourcesLastSyncedAt?: Date | null;
  roadmapEpics?: { key: string; title: string }[];
  sources?: string[];
  /**
   * Deliberately NOT accepted from the caller any more.
   *
   * The classifier runs over the RAW rows, so its counts are per pre-merge task
   * and sum to `tasks.length + mergedPairs`. Passing them through put a count
   * larger than its own population on the provenance widget, and made it
   * disagree with the caveats and the roadmap tile on the same page — the exact
   * property a shared snapshot exists to prevent. Provenance is recomputed here,
   * over the merged rows, so every widget divides by the same number.
   */
}

export interface FocusTaskView {
  taskKey: string;
  provider: FocusProvider;
  title: string;
  state: string;
  stage: FocusStage;
  cls: FocusClassKey;
  reason: string;
  epicKey: string | null;
  /** Set when the task existed in BOTH systems, so the ledger can say so. */
  alsoInAdo: boolean;
  owner: string | null;
  attentionDays: number;
  movesInWindow: number;
  /**
   * Whether anyone ever moved this task into a working state, over its FULL
   * history rather than the window. Only load-bearing for cancelled work, where
   * it decides between wasted effort and a ticket nobody touched — but carried
   * on every task so the tally needs no second lookup.
   */
  everWorked: boolean;
  /**
   * Days we have EVIDENCE this task spent in a working state, over its whole
   * history rather than the window.
   *
   * Evidence, not duration: the spell is clipped at the task's last recorded
   * transition, so a task still sitting in a working state UNDER-reports — its
   * open spell is not counted to the present. That is the right answer for the
   * cancelled work this feeds (`wastedAttentionDays`) and the wrong one for a
   * live task, so read the name as the question it answers. It ships to clients
   * through the ledger and map widgets, hence the warning here rather than only
   * on `allTimeWorkingDays`.
   */
  allTimeWorkingDays: number;
  onBoard: boolean;
}

export interface FocusPerson {
  name: string;
  tasks: number;
  neverMoved: number;
  inProduction: number;
  unshipped: number;
  attention: Record<FocusClassKey, number>;
  shares: Record<FocusClassKey, number>;
  workingDays: number;
  isLateJoiner: boolean;
  firstActivity: string | null;
}

export interface FocusSnapshot {
  tasks: FocusTaskView[];
  stageCounts: Record<FocusStage, number>;
  /**
   * Tasks that count as WORK: `tasks.length - cancelledNeverWorked`.
   *
   * The denominator for the two widgets that ask "of N tasks, where did the work
   * end up" — the funnel and the shipped ratio. Computed once here rather than
   * by each caller, because two callers subtracting for themselves is how they
   * come to disagree. Four other Focus widgets deliberately keep `tasks.length`;
   * see § Denominators in the design spec for why each one does.
   */
  workedTaskCount: number;
  /** Cancelled tasks nobody ever worked on, excluded from `stageCounts`. */
  cancelledNeverWorked: number;
  /**
   * The FEATURE grain: every issue rolled up to the root of its parent chain.
   *
   * Read by exactly two widgets — the delivery funnel and the shipped ratio.
   * Every per-issue field above keeps its own meaning and its own consumers, so
   * two grains coexist here deliberately; the funnel labels its population and
   * the caveats widget names both, because a page where one widget says 85 and
   * another says 708 has to explain itself.
   */
  featureCounts: Record<FocusStage, number>;
  featureTaskCount: number;
  /** Features abandoned before anyone worked any part of them. */
  featuresCancelledNeverWorked: number;
  /**
   * Attention days that went into work later cancelled — ALL-TIME, unlike every
   * other day figure in this snapshot.
   *
   * Its own field precisely so no caller can mistake it for a windowed one. The
   * event being reported is "cancelled in this window"; the cost of that event is
   * every day ever spent on it. On the reference board the windowed reading is
   * 22 days and the all-time reading is 268 — a 12x gap, because the effort
   * predates the window and only the cancellation is recent.
   */
  wastedAttentionDays: number;
  /**
   * `wastedAttentionDays`, split by whether the FEATURE survived.
   *
   * Two problems were being added together. `wastedDaysAbandonedFeatures` is
   * "we built a whole feature and binned it" — a scoping failure.
   * `wastedDaysInsideLiveFeatures` is "we trimmed scope inside something that
   * shipped", which is a different and milder thing. On the reference board they
   * are 218 and 51 days.
   *
   * The second one is also what makes `rollUpStages`' precedence honest: a
   * feature with one shipped child and ten cancelled reads IN_PRODUCTION, so its
   * ten binned children leave the bar — and reappear here. Delete this figure
   * and that precedence starts hiding waste.
   *
   * The pair MUST sum to `wastedAttentionDays`; a test asserts it, because a
   * split that does not reconcile is losing days rather than explaining them.
   */
  wastedDaysAbandonedFeatures: number;
  wastedDaysInsideLiveFeatures: number;
  unmappedStates: string[];
  attentionDays: Record<FocusClassKey, number>;
  attentionShares: Record<FocusClassKey, number>;
  neverMoved: number;
  parkedDays: number;
  people: FocusPerson[];
  epics: { key: string; title: string; touched: boolean; tasks: number }[];
  offBoardTasks: number;
  provenance: { HUMAN: number; CAPEX: number; RULE: number; MODEL: number; NONE: number };
  caveats: FocusCaveat[];
  /** ISO date, or null if this organisation has never completed a sync. */
  sourcesLastSyncedAt: string | null;
}

/**
 * The verdict for a merged row, under ONE rule.
 *
 * Extracted because two loops resolved the same thing differently: the task
 * loop fell back to the ADO key, the provenance loop did not. They cannot
 * disagree today — `classifyTasks` writes an entry for every raw key, so the
 * primary lookup always hits — but once classification runs after the merge,
 * which is the natural next step when the advisor model is wired, the ledger
 * and the provenance widget would diverge again in exactly the way that was
 * just fixed. One rule removes the trap.
 */
function verdictFor(
  row: { id: string; jiraId: string | null; adoId: string | null },
  verdicts: Map<string, ResolvedVerdict>,
): ResolvedVerdict | undefined {
  return (
    verdicts.get(row.id) ??
    (row.jiraId ? verdicts.get(row.jiraId) : undefined) ??
    (row.adoId ? verdicts.get(row.adoId) : undefined)
  );
}

/** A source row in the shape `mergeTaskSets` reconciles on. */
function toSourceTask(t: FocusTaskRow) {
  return {
    id: t.task_key,
    title: t.title,
    description: t.description,
    createdAt: new Date(t.created_at.replace(' ', 'T') + 'Z'),
    state: t.state,
    assignee: t.assignee,
  };
}

const EMPTY_CLASS: Record<FocusClassKey, number> = { A: 0, B: 0, C: 0, UNCLASSIFIED: 0 };

/**
 * Assemble everything the Focus widgets render, from raw rows.
 *
 * Pure: no database, no ClickHouse, no clock. Every rule that decides what a
 * number MEANS — window clipping, parked versus moved, stage mapping, the
 * late-joiner floor — is applied here through `@deckgauge/shared`, so the whole
 * view can be asserted against the reference report without infrastructure.
 *
 * Tasks with no verdict keep class UNCLASSIFIED and are counted AS that class —
 * never bucketed into one of A, B or C, which would invent a judgement nobody
 * made (R6.4). They appear in the class split, the funnel, the ledger and the
 * never-moved count alike. The split used to omit them, so its percentages were
 * computed over a smaller population than every other figure on the page; see
 * the note above `measured` for what that broke and what replaced it.
 */
/**
 * Working days over a task's whole history, bounded by its last known state
 * change.
 *
 * Reuses `attentionDaysInWindow` with widened bounds rather than counting days a
 * second way — two implementations of "days in a working state" is how the
 * windowed and un-windowed figures come to disagree.
 *
 * **The upper bound is the last transition, and that is the whole point.**
 * `attentionDaysInWindow` runs an unterminated spell to `window.to`
 * (attention-days.ts:52), which is right for a task still being worked. It is
 * wrong here: a cancelled task whose changelog is missing its closing transition
 * — a bulk migration, a provider that did not record it — would accrue days from
 * its last working transition to the window end, fabricating a multi-hundred-day
 * figure in the one number the funnel presents as a finding. Bounding at the last
 * transition answers "how long do we have EVIDENCE this was worked", and reports
 * zero when there is none rather than inventing a number.
 */
function allTimeWorkingDays(
  transitions: FocusTransition[],
  workingStates: readonly string[],
): number {
  if (transitions.length === 0) return 0;

  const last = transitions.reduce((max, t) => (t.at > max ? t.at : max), transitions[0]!.at);
  return attentionDaysInWindow(transitions, workingStates, { from: new Date(0), to: last });
}

export function buildFocusSnapshot(input: FocusSnapshotInput): FocusSnapshot {
  const stageMap = input.stageMap ?? DEFAULT_STAGE_MAP;
  const cutoff = input.migrationCutoff ?? undefined;

  const byTask = new Map<string, FocusTransition[]>();
  for (const row of input.transitions) {
    const list = byTask.get(row.task_key) ?? [];
    list.push({ fromState: row.from_state, toState: row.to_state, at: new Date(row.at) });
    byTask.set(row.task_key, list);
  }

  // Reconcile the two systems BEFORE measuring. A team that migrated mid-window
  // has the same task in both, and counting it twice inflates every denominator
  // on the page — while the caveat block says "after de-duplication".
  const bySourceKey = new Map(input.tasks.map((t) => [t.task_key, t]));
  const { rows: merged, mergedPairs } = mergeTaskSets(
    input.tasks.filter((t) => t.provider === 'jira').map(toSourceTask),
    input.tasks.filter((t) => t.provider === 'ado').map(toSourceTask),
  );

  const tasks: FocusTaskView[] = merged.map((m) => {
    // A merged row keeps the Jira key, so its ADO twin's history has to be
    // gathered under the OTHER key or half the movement silently disappears —
    // and a task that moved would read as never having moved.
    //
    // KNOWN LIMITATION, and it is the cost of this concatenation. The two lists
    // are separate state machines; `attentionDaysInWindow` sorts the combined
    // list and treats every entry as ending the previous spell. For the
    // SEQUENTIAL case this view targets — a team that migrated mid-window, so
    // one tracker goes quiet as the other starts — that is correct. For a task
    // worked in BOTH trackers at once it is not: a transition in one truncates
    // a spell in the other, under-counting days, and the move counts sum across
    // two trackers, which can flip a task from `parked` to `moved` — the one
    // classification the parked rule exists to protect.
    //
    // Deliberately not "fixed" here: what attention days should MEAN for a task
    // worked in two trackers simultaneously is a product question, and encoding
    // a guess in a test would make the guess look settled. Recorded in
    // planning/STATE.md as outstanding.
    const transitions = [
      ...(m.jiraId ? (byTask.get(m.jiraId) ?? []) : []),
      ...(m.adoId ? (byTask.get(m.adoId) ?? []) : []),
    ];
    const source = bySourceKey.get(m.jiraId ?? m.adoId ?? m.id) ?? bySourceKey.get(m.id);
    const verdict = verdictFor(m, input.verdicts);

    return {
      // A merged twin keeps its JIRA key (`mergeTaskSets`), so the feature
      // rollup walks the Jira parent chain for it and its `parent_ado_id` is
      // never consulted. Correct while Jira is the authoritative hierarchy — and
      // stated here rather than in `merge-task-sets.ts`, because which chain the
      // rollup then walks is a fact about this consumer, not about merging.
      taskKey: m.id,
      provider: m.provider === 'ado' ? 'ado' : 'jira',
      title: m.title,
      state: m.state,
      stage: mapDeliveryStage(m.state, m.provider === 'ado' ? 'ado' : 'jira', stageMap),
      cls: verdict?.class ?? 'UNCLASSIFIED',
      reason: verdict?.reason ?? 'No classifier produced a verdict for this task.',
      epicKey: verdict?.epicKey ?? source?.epic_key ?? null,
      alsoInAdo: !!m.jiraId && !!m.adoId,
      owner: m.assignee,
      attentionDays: attentionDaysInWindow(transitions, input.workingStates, input.window),
      movesInWindow: countMovesInWindow(transitions, input.window, cutoff),
      // `transitions` is already FocusTransition[] — `byTask` converts the raw
      // rows on the way in. Re-mapping it as if it were raw reads `undefined`
      // for every state and silently answers false.
      everWorked: everEnteredWorkingState(transitions, input.workingStates),
      allTimeWorkingDays: allTimeWorkingDays(transitions, input.workingStates),
      onBoard: input.onBoardKeys
        ? // Either system's key being on the board means the task reached it: a
          // merged row can be on the board under only one of them.
          [m.jiraId, m.adoId]
            .filter((k): k is string => !!k)
            .some((k) => input.onBoardKeys!.has(k))
        : true,
    };
  });

  /**
   * Every task is measured, unclassified ones included (R6.4).
   *
   * There used to be a `classified` array here that filtered UNCLASSIFIED out
   * before the split, so the shares were computed over a smaller population than
   * every other figure on the page. UNCLASSIFIED is a class now, with a label, a
   * colour and a share.
   *
   * **The count below is deliberately NOT `tasks.length - measured.length`.**
   * That subtraction is what the filtered array made possible, and reusing the
   * shape after removing the filter would silently yield zero — which
   * `buildFocusCaveats` suppresses, so the chart would gain a bar while the
   * sentence explaining it vanished. It is counted directly instead, and
   * `focus-snapshot.test.ts` pins the chart and the caveat as a pair.
   */
  const measured = tasks.map((t) => ({
    cls: t.cls,
    attentionDays: t.attentionDays,
    movesInWindow: t.movesInWindow,
  }));
  const unclassifiedCount = tasks.filter((t) => t.cls === 'UNCLASSIFIED').length;
  const { moved, parked } = splitMovedParked(measured);

  // Roll every issue up to the root of its parent chain — `resolveEpicKey`,
  // reused rather than reimplemented: a second walker would be a second
  // definition of "which feature is this", which is the defect this grain
  // exists to fix. It also already handles the two cases that matter, an issue
  // with no parent and a cycle.
  const byFeature = new Map<string, { stage: FocusStage; everWorked: boolean }[]>();
  for (const t of tasks) {
    const root = resolveEpicKey(t.taskKey, input.parentOf);
    const list = byFeature.get(root) ?? [];
    list.push({ stage: t.stage, everWorked: t.everWorked });
    byFeature.set(root, list);
  }

  const featureCounts: Record<FocusStage, number> = {
    IN_PRODUCTION: 0,
    WAITING_TO_SHIP: 0,
    IN_DEVELOPMENT: 0,
    CANCELLED: 0,
    NOT_STARTED: 0,
  };
  const featureStage = new Map<string, FocusStage>();
  let featuresCancelledNeverWorked = 0;

  for (const [root, children] of byFeature) {
    const { stage, workedChildren } = rollUpStages(children);
    featureStage.set(root, stage);

    // The same exclusion as the per-issue rule, applied one level up: a feature
    // nobody ever worked was never work.
    if (stage === 'CANCELLED' && workedChildren === 0) {
      featuresCancelledNeverWorked += 1;
      continue;
    }
    featureCounts[stage] += 1;
  }

  // One place that can be wrong, rather than three. The same expression appeared
  // in the returned field and the caveat call, which is how two figures that
  // must agree come to disagree — `sumClasses` exists for the same reason.
  const featureTaskCount = byFeature.size - featuresCancelledNeverWorked;

  // Over the MERGED rows, not the raw ones — otherwise a twin is counted in two
  // stages and the funnel does not add up to the task total.
  const { counts: stageCounts, unmapped, cancelledNeverWorked } = tallyDeliveryStages(
    tasks.map((t) => ({ state: t.state, provider: t.provider, everWorked: t.everWorked })),
    stageMap,
  );

  // Summed unrounded and rounded ONCE, per `attentionSharesByClass`: rounding
  // each task first is what once made 133/241/405 read as 134/241/406.
  const wasted = tasks.filter((t) => t.stage === 'CANCELLED' && t.everWorked);
  const wastedAttentionDays = Math.round(
    wasted.reduce((n, t) => n + t.allTimeWorkingDays, 0),
  );

  // Split on the FEATURE's fate, not the issue's: the issue is cancelled either
  // way, and what differs is whether anything around it survived.
  //
  // The second half is the TOTAL MINUS the first, not an independent sum. That
  // makes the reconciliation arithmetic rather than a coincidence two rounding
  // paths have to keep agreeing on — the test asserts the sum, and this is what
  // guarantees it holds even at the rounding boundary.
  const abandonedRaw = wasted
    .filter((t) => featureStage.get(resolveEpicKey(t.taskKey, input.parentOf)) === 'CANCELLED')
    .reduce((n, t) => n + t.allTimeWorkingDays, 0);
  const wastedDaysAbandonedFeatures = Math.round(abandonedRaw);
  const wastedDaysInsideLiveFeatures = wastedAttentionDays - wastedDaysAbandonedFeatures;
  // **The cost of exact reconciliation, accepted deliberately.** Because the live
  // half is a subtraction, a board with (say) half a day of waste on each side
  // reports 1 and 0 — and the widget suppresses a zero line, so up to about a
  // day of genuine waste inside live features renders as nothing at all.
  //
  // The alternative is rounding each half independently, which reintroduces
  // exactly the coincidence the note above exists to remove: two rounding paths
  // that must keep agreeing with a total neither computes. A sub-day figure lost
  // at the boundary is the better trade for a number labelled "~N days", and it
  // is written here so the next person who notices a missing line reads a
  // decision rather than an oversight.

  const epics = (input.roadmapEpics ?? []).map((e) => {
    const count = tasks.filter((t) => t.epicKey === e.key).length;
    return { key: e.key, title: e.title, touched: count > 0, tasks: count };
  });

  // Clipped to the window here, because the transitions query deliberately is
  // not — `attentionDaysInWindow` needs the spell that opened before it. Left
  // unclipped, this would report what Approved meant across all history and
  // present it as a finding about this quarter.
  const approved = verifyApprovedIsNotDone(
    input.transitions
      .map((r) => ({ fromState: r.from_state, toState: r.to_state, at: new Date(r.at) }))
      .filter((t) => t.at >= input.window.from && t.at < input.window.to),
    input.workingStates,
  );

  const lateJoiners: { name: string; from: Date }[] = [];
  const people = buildPeople(tasks, input, lateJoiners);

  // Counted over the MERGED rows, so `sum(provenance) === tasks.length` holds
  // and no widget divides by a different population than another.
  const provenance = { HUMAN: 0, CAPEX: 0, RULE: 0, MODEL: 0, NONE: 0 };
  for (const m of merged) {
    provenance[verdictFor(m, input.verdicts)?.source ?? 'NONE'] += 1;
  }

  return {
    tasks,
    stageCounts,
    workedTaskCount: tasks.length - cancelledNeverWorked,
    cancelledNeverWorked,
    featureCounts,
    featureTaskCount,
    featuresCancelledNeverWorked,
    wastedAttentionDays,
    wastedDaysAbandonedFeatures,
    wastedDaysInsideLiveFeatures,
    unmappedStates: unmapped,
    attentionDays: attentionDaysByClass(moved),
    attentionShares: attentionSharesByClass(moved),
    neverMoved: tasks.filter((t) => t.movesInWindow === 0).length,
    parkedDays: Math.round(parked.reduce((n, t) => n + t.attentionDays, 0)),
    people,
    epics,
    offBoardTasks: tasks.filter((t) => !t.onBoard).length,
    provenance,
    sourcesLastSyncedAt: input.sourcesLastSyncedAt
      ? input.sourcesLastSyncedAt.toISOString().slice(0, 10)
      : null,
    caveats: buildFocusCaveats({
      window: input.window,
      sources: input.sources ?? [],
      cancelledNeverWorked,
      featureTaskCount,
      totalTasks: tasks.length,
      mergedPairs,
      migrationCutoff: input.migrationCutoff ?? null,
      lateJoiners,
      approved,
      unclassified: unclassifiedCount,
      unmappedStates: unmapped,
    }),
  };
}

function buildPeople(
  tasks: FocusTaskView[],
  input: FocusSnapshotInput,
  lateJoiners: { name: string; from: Date }[],
): FocusPerson[] {
  const names = [...new Set(tasks.map((t) => t.owner).filter((n): n is string => n !== null))];

  return names.sort().map((name) => {
    const own = tasks.filter((t) => t.owner === name);
    const first = input.firstActivity?.get(name) ?? null;
    const member = resolveMemberWindow(first, input.window);
    if (member.isLateJoiner && first) lateJoiners.push({ name, from: first });

    // Unclassified work included, matching the board-level split above (R6.4).
    // These two filters were separate, so removing only one left the headline
    // chart counting unclassified days while every person's row reported zero
    // for them — reconciling with nothing and erroring nowhere.
    const measured = own.map((t) => ({
      cls: t.cls,
      attentionDays: t.attentionDays,
      movesInWindow: t.movesInWindow,
    }));
    const { moved } = splitMovedParked(measured);

    return {
      name,
      tasks: own.length,
      neverMoved: own.filter((t) => t.movesInWindow === 0).length,
      inProduction: own.filter((t) => t.stage === 'IN_PRODUCTION').length,
      unshipped: own.filter((t) => t.stage === 'WAITING_TO_SHIP').length,
      attention: moved.length ? attentionDaysByClass(moved) : { ...EMPTY_CLASS },
      shares: moved.length ? attentionSharesByClass(moved) : { ...EMPTY_CLASS },
      workingDays: member.workingDays,
      isLateJoiner: member.isLateJoiner,
      firstActivity: first ? first.toISOString().slice(0, 10) : null,
    };
  });
}
