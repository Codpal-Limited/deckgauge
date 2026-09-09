import type { PrismaClient } from '@deckgauge/db';
import { mergeStageMap } from '@deckgauge/shared';
import type { ChReadClient } from '../analytics/ch-read-scope.js';
import { getWidgetBoardScope, type WidgetBoardScope } from '../widgets/widget-board-scope.js';
import { adoScopeFilter } from '../widgets/unions.js';
import { castRows } from '../widgets/widget-helpers.js';
import {
  buildFocusBoardIssuesSql,
  buildFocusParentsSql,
  buildFocusTaskMeasuresSql,
  buildFocusTransitionsSql,
} from '../intelligence-query/builders/focus-task-measures.js';
import type { FocusPromptEpic, FocusPromptTask, ResolvedVerdict } from '@deckgauge/shared';
import { classifyTasks, type StoredVerdict } from './classification.service.js';
import {
  buildFocusSnapshot,
  type FocusBoardIssueRow,
  type FocusSnapshot,
  type FocusTaskRow,
  type FocusTransitionRow,
} from './focus-snapshot.js';

const DEFAULT_WORKING_STATES = [
  'In Progress',
  'Code Review',
  'Pull Request Doing',
  'Send Back to Dev',
];

export const EMPTY_SNAPSHOT_REASON = 'no_issue_source';

export interface FocusDataDeps {
  prisma: PrismaClient;
  clickhouse: ChReadClient;
  organizationId: string | null;
}

/**
 * Everything BOTH the snapshot and an advisor run need: the window's tasks, the
 * board rows that classify them, the roadmap epics they may be attributed to,
 * and the parent chain inheritance walks.
 *
 * Extracted rather than reimplemented on the run path. A second copy of the
 * scope resolution and the epic union would be a second definition of which
 * tasks are in the window, and this repository has already paid for that exact
 * class of drift — see the fourteen project-only scope sites in
 * `planning/STATE.md`. The classify route reads what the page reads, or the
 * button classifies a different population from the one it counted.
 *
 * Returns null for the same reason `getFocusSnapshot` does: no issue source.
 *
 * Note it loads `transitions` even though only the snapshot uses them. Keeping
 * one query list means the two paths cannot silently diverge, and the cost is one
 * ClickHouse read on a route that is about to spend money on an LLM.
 */
async function loadClassificationInputs(
  deps: FocusDataDeps,
  boardId: string,
  config: Record<string, unknown>,
) {
  const scope = await getWidgetBoardScope(deps.prisma, boardId, deps.organizationId);

  const measures = buildFocusTaskMeasuresSql({ config, scope });
  if (!measures) return null;

  const focusConfig = await deps.prisma.focusConfig.findUnique({ where: { boardId } });

  const workingStates = readStringArray(focusConfig?.workingStates) ?? DEFAULT_WORKING_STATES;
  const stageMap = mergeStageMap(focusConfig?.stageMap);

  const tasks = castRows<FocusTaskRow>(
    await (
      await deps.clickhouse.query({
        query: measures.sql,
        query_params: measures.params,
        format: 'JSONEachRow',
      })
    ).json(),
  );

  // Both unwindowed, and both genuinely concurrent — the comment here previously
  // claimed "both go at once" over three sequential awaits, which is the kind of
  // claim this branch has been corrected for twice.
  //
  // Unwindowed for related reasons: a spell that opened before the window still
  // counts, and a parent untouched in the window is still the parent. Rooting
  // its children at themselves would split one feature into several.
  const parentsSql = buildFocusParentsSql({ config, scope });
  const transitionSql = buildFocusTransitionsSql({ config, scope });
  // The board's whole issue set, for the feature rollup. Unwindowed for the
  // reason the two above are, and stated on the builder: a feature's stage is a
  // property of the feature, so it cannot be read off whichever children moved
  // inside the window.
  const boardIssuesSql = buildFocusBoardIssuesSql({ config, scope });

  const readRows = async <T>(built: { sql: string; params: Record<string, unknown> } | null) =>
    built
      ? castRows<T>(
          await (
            await deps.clickhouse.query({
              query: built.sql,
              query_params: built.params,
              format: 'JSONEachRow',
            })
          ).json(),
        )
      : [];

  const [parentRows, transitions, boardIssues] = await Promise.all([
    readRows<{ task_key: string; parent_key: string }>(parentsSql),
    readRows<FocusTransitionRow>(transitionSql),
    readRows<FocusBoardIssueRow>(boardIssuesSql),
  ]);

  const parentOf = new Map<string, string>();
  for (const r of parentRows) {
    if (r.task_key && r.parent_key) parentOf.set(r.task_key, r.parent_key);
  }

  // Which of these tasks exist as a row on THIS board, what finance called each
  // one, and which of them are the board's CAPEX-marked epics.
  //
  // Without `onBoard` the flag defaults true, `offBoardTasks` is always zero,
  // and the finding the view was built to surface — work that never reached the
  // board — never renders.
  //
  // Already awaited before the classifier, because `board.capex` feeds
  // `loadCapex`; `roadmapEpics` now rides along on the same read rather than
  // coming from a table of its own, and `matchRules` needs it to decide whether
  // a task's epic link is a roadmap link (R6.10).
  const board = await loadBoardRows(deps, boardId);

  // The ADO half of the same denominator. Separate because `Project` carries
  // `jiraType` but no ADO work-item type, so the type has to come from
  // ClickHouse — see `loadAdoRoadmapEpics`.
  const adoEpics = await loadAdoRoadmapEpics(deps, scope, board.adoCapexCandidates);
  // Sorted, because nothing downstream sorts: `buildFocusSnapshot` maps in input
  // order and both coverage widgets render in that order. The `FocusEpic` read
  // this replaced had `orderBy: { position: 'asc' }`; without a sort here the
  // chip list is in unspecified Postgres row order and can reshuffle between
  // renders of the same unchanged board.
  const allRoadmapEpics = [...board.roadmapEpics, ...adoEpics].sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  const roadmapEpics = new Set(allRoadmapEpics.map((e) => e.key));

  // `firstActivity` is deliberately NOT computed here. It is derived from the
  // transitions and only the snapshot needs it — a classification run does not
  // care when anybody joined — so it stays in `getFocusSnapshot`.

  // Only needed to explain an empty result, so it is fetched unconditionally but
  // costs one indexed row.
  // Not `organizationId ?? undefined`: that DROPS the predicate instead of
  // matching nothing, so a null-org caller would read the newest completed run
  // across every tenant. `SyncRun.errorMessage` is provider text that names
  // hosts and repositories, and the schema comment on this table records a
  // prior incident of exactly that shape.
  //
  // Not wrapped in `.catch(() => null)` either: null means "never synced", and
  // the empty state says so in as many words. Turning a permission error or a
  // dropped connection into that sentence would make a fault into a confident
  // false statement about someone's tooling — which is the whole class of bug
  // this view exists to avoid.
  const lastSync = deps.organizationId
    ? await deps.prisma.syncRun.findFirst({
        where: { organizationId: deps.organizationId, status: 'COMPLETED' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      })
    : null;

  return {
    measures,
    workingStates,
    stageMap,
    focusConfig,
    tasks,
    transitions,
    parentOf,
    // Loaded here rather than in `getFocusSnapshot` for the reason the header
    // gives: one query list, so the page and the classify route cannot diverge
    // on which rows they read. Only the snapshot consumes it — a classification
    // run does not roll features up — which puts it alongside `transitions`.
    boardIssues,
    board,
    allRoadmapEpics,
    roadmapEpics,
    lastSync,
    scope,
    classifiable: tasks.map((t) => ({
      taskKey: t.task_key,
      title: t.title,
      description: t.description,
      type: t.provider === 'jira' ? ('Issue' as const) : ('Work Item' as const),
      repo: null,
      epicKey: t.epic_key,
    })),
  };
}

export interface FocusClassificationRunOptions {
  /**
   * Builds the adapter, given the roadmap epics the model may attribute work to.
   *
   * A FACTORY rather than a ready-made classifier, because the two things it
   * needs are known in different places: the route resolves the organization's
   * provider, and only this function loads the board's roadmap epics. Handing the
   * route a finished classifier would mean passing it an empty epic list — the
   * prompt would offer the model nothing to attribute to, and `coerceModelVerdict`
   * would null every key it invented anyway, so roadmap coverage would come back
   * empty from a run that looked successful.
   */
  classifierFor: (
    epics: readonly FocusPromptEpic[],
    /**
     * Handed IN rather than owned by the caller, so the failure lands on the
     * result this function returns.
     *
     * The route used to keep its own closure and merge the field itself, which
     * left `providerError` below declared and never written — and made the
     * route's own test pass by spreading the value its mock had returned, with
     * the real chain uncovered. One owner, one path.
     */
    onProviderError: (err: unknown) => void,
  ) => (tasks: FocusPromptTask[]) => Promise<unknown[]>;
  /** How many residue tasks this run may pay for. Unset means all of them. */
  modelBudget?: number;
  run: FocusModelRun;
}

export interface FocusClassificationRunResult {
  /**
   * Tasks THIS run gave a model class to. Cache hits excluded — see
   * `ClassificationResult.newlyClassified`.
   */
  classified: number;
  /** Tasks actually sent to the model, which is what the run cost. */
  modelCalls: number;
  /**
   * Set when the PROVIDER failed — a timeout, a 429, a rejected key.
   *
   * The run still completes and still saves what it earned; this is how the
   * reason reaches the person who pressed the button, instead of a broken key
   * reading as "the model classified nothing".
   */
  providerError?: string;
  /**
   * Tasks the cheap tiers could not answer and this run did not reach.
   *
   * The honest number for the button: a capped run that reported only what it
   * classified would look complete. Non-zero means "press it again".
   */
  remaining: number;
}

/**
 * Classify this board's window with the advisor, and say what it did.
 *
 * Deliberately separate from `getFocusSnapshot`, which keeps
 * `classifyWithModel: null`. Page loads stay free and read only what a run has
 * already paid for; the LLM stays off the render path and out from behind a lock
 * it shares with the conversational advisor.
 *
 * Returns null when there is no issue source, exactly as the snapshot does.
 */
export async function runFocusClassification(
  deps: FocusDataDeps,
  boardId: string,
  config: Record<string, unknown>,
  opts: FocusClassificationRunOptions,
): Promise<FocusClassificationRunResult | null> {
  const input = await loadClassificationInputs(deps, boardId, config);
  if (!input) return null;

  // First failure only: a run that loses every batch to the same expired key
  // would otherwise report the same sentence five times, and the first is the
  // diagnosis.
  let providerError: string | undefined;

  const classification = await classifyTasks(input.classifiable, {
    loadVerdicts: (fingerprints) => loadVerdicts(deps, fingerprints),
    loadCapex: async () => input.board.capex,
    parentOf: input.parentOf,
    classifyWithModel: opts.classifierFor(input.allRoadmapEpics, (err) => {
      providerError ??= err instanceof Error ? err.message : String(err);
    }),
    modelBudget: opts.modelBudget,
    // The run context reaches the row here and nowhere else — a page load passes
    // none, so it cannot invent a provenance it did not produce.
    saveVerdicts: (rows) => saveVerdicts(deps, rows, opts.run),
    roadmapEpics: input.roadmapEpics,
  });

  return {
    classified: classification.newlyClassified,
    modelCalls: classification.modelCalls,
    /**
     * Tasks still carrying no class AFTER this run — not `residueTotal -
     * modelCalls`.
     *
     * That subtraction counted a SENT task as finished, which is false whenever
     * the model did not answer for it: a provider failure or a malformed verdict
     * leaves the task `source: null`, uncacheable, and re-sent on the next press.
     * The old formula rendered "Classified 0. 140 still unclassified" on a board
     * of 340 whose key had expired — two halves of one sentence contradicting
     * each other.
     */
    remaining: classification.unclassified,
    ...(providerError ? { providerError } : {}),
  };
}

/**
 * Everything the Focus widgets need, for one board and one window.
 *
 * Fetches rows, classifies, and hands both to `buildFocusSnapshot`, which owns
 * every rule about what the numbers mean. Nothing here decides anything — that
 * separation is what lets the meaning be tested against the reference report
 * without a database.
 *
 * **This path never calls the model.** `classifyWithModel` is null here by
 * design, so opening a board is free and reads only what a run already paid for
 * — and the LLM stays off the render path and out from behind the lock it shares
 * with the conversational advisor. The residue comes back UNCLASSIFIED with a
 * count, which the caveats state plainly. `runFocusClassification` is what
 * spends money, and only when someone presses the button.
 */
export async function getFocusSnapshot(
  deps: FocusDataDeps,
  boardId: string,
  config: Record<string, unknown>,
): Promise<FocusSnapshot | null> {
  const input = await loadClassificationInputs(deps, boardId, config);
  if (!input) return null;

  const {
    measures,
    workingStates,
    stageMap,
    focusConfig,
    tasks,
    transitions,
    parentOf,
    boardIssues,
    board,
    allRoadmapEpics,
    roadmapEpics,
    lastSync,
    scope,
    classifiable,
  } = input;
  const firstActivity = await loadFirstActivity(deps, transitions);

  // `classification.provenance` is deliberately unused: it counts pre-merge
  // tasks, and buildFocusSnapshot recomputes it over the merged rows so every
  // widget on the page divides by the same population.
  const classification = await classifyTasks(classifiable, {
    loadVerdicts: (fingerprints) => loadVerdicts(deps, fingerprints),
    loadCapex: async () => board.capex,
    // The SAME map the feature rollup uses, and the reason inheritance can
    // reach a sub-task at all: Jira puts no epic link on one, so `epic_key`
    // above is null for every sub-task and the chain is the only route to its
    // epic. It was already loaded and already in memory here — it was simply
    // never handed to the classifier, which is why 391 issues sat
    // UNCLASSIFIED under epics somebody had classified.
    parentOf,
    // Null on purpose, and no longer a to-do: `runFocusClassification` is the
    // advisor path, reached only by an explicit POST. See this function's header.
    classifyWithModel: null,
    saveVerdicts: (rows) => saveVerdicts(deps, rows),
    roadmapEpics,
  });

  return buildFocusSnapshot({
    tasks,
    transitions,
    verdicts: classification.byTaskKey,
    // From the same call that produced the verdicts, so the two cannot describe
    // different tasks. See `ClassificationResult.fingerprintByTaskKey`.
    fingerprintByTaskKey: classification.fingerprintByTaskKey,
    window: {
      from: new Date(String(measures.params.from).replace(' ', 'T') + 'Z'),
      to: new Date(String(measures.params.to).replace(' ', 'T') + 'Z'),
    },
    workingStates,
    stageMap,
    parentOf,
    boardIssues,
    migrationCutoff: focusConfig?.migrationCutoff ?? null,
    firstActivity,
    onBoardKeys: board.onBoard,
    roadmapEpics: allRoadmapEpics,
    sources: describeSources(scope),
    sourcesLastSyncedAt: lastSync?.finishedAt ?? null,
  });
}

function describeSources(scope: { jiraProjectKeys: string[]; adoProjects: string[] }): string[] {
  const out: string[] = [];
  if (scope.jiraProjectKeys.length) out.push('Jira');
  if (scope.adoProjects.length) out.push('Azure DevOps');
  return out;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((v): v is string => typeof v === 'string');
  return strings.length > 0 ? strings : null;
}

async function loadVerdicts(
  deps: FocusDataDeps,
  fingerprints: string[],
): Promise<Map<string, StoredVerdict>> {
  if (fingerprints.length === 0 || !deps.organizationId) return new Map();

  const rows = await deps.prisma.focusVerdict.findMany({
    where: { organizationId: deps.organizationId, fingerprint: { in: fingerprints } },
  });

  return new Map(
    rows
      /**
       * Dropped by SOURCE, not by class.
       *
       * A stored UNCLASSIFIED row from any classifier is stale by construction —
       * nothing in the pipeline can write one (a resolved unclassified verdict
       * has `source: null`, which both `saveVerdicts` and the classifier's
       * CACHEABLE set refuse), so such a row is a leftover from the retired
       * class D and honouring it would freeze a task the rules can now reach.
       *
       * A HUMAN one is the opposite: somebody looked at the task and concluded
       * it cannot be classified. That is a decision, and it is the only way
       * UNCLASSIFIED ever reaches this table on purpose. Filtering it out was
       * silent — the write succeeded and only the read discarded it.
       */
      .filter((r) => r.source === 'HUMAN' || r.class !== 'UNCLASSIFIED')
      .map((r) => [
        r.fingerprint,
        {
          // No cast. `StoredVerdict.class` is `FocusClassKey` through
          // `ClassifierVerdict`, so narrowing it to 'A' | 'B' | 'C' here was
          // asserting something the row can now contradict.
          class: r.class,
          epicKey: r.epicKey,
          reason: r.reason,
          source: r.source as StoredVerdict['source'],
        },
      ]),
  );
}

/**
 * What produced the verdicts in this write, when a model did.
 *
 * Run-level rather than per-verdict: one run has one model and one prompt, so
 * widening `ResolvedVerdict` with two fields every other caller passes as null
 * would put the fact in the wrong place.
 */
export interface FocusModelRun {
  model: string;
  promptVersion: string;
}

/**
 * The columns a verdict write sets, identical on create and update.
 *
 * `model` and `promptVersion` are populated only for a MODEL verdict produced by
 * an actual run. They are what makes a stored verdict auditable — a verdict from
 * an older prompt is identifiable and can be re-run rather than silently trusted,
 * which is the whole reason `FOCUS_PROMPT_VERSION` exists. Both had existed on
 * the table since it was created and had never been written.
 *
 * **BOTH halves of the guard are unreachable in production, not just one.**
 *
 * `source === 'MODEL'`: during a run this can only ever receive MODEL rows —
 * `CACHEABLE` admits only HUMAN and MODEL, RULE and CAPEX are recomputed rather
 * than stored, and a stored HUMAN verdict short-circuits into `servedFromCache`
 * so it is never rewritten.
 *
 * `run !== undefined`: `saveVerdicts` is only ever *called* from
 * `runFocusClassification`, which always passes one. The page-load path wires
 * `saveVerdicts` too, but `fresh` is empty by construction there for the reason
 * above, so it never fires.
 *
 * Two tests were written for these and deleted, because on the production paths
 * they could not fail — they iterated an array that is always empty. This
 * function is therefore EXPORTED and unit-tested directly. Testing an
 * unreachable guard through a caller that cannot reach it is worse than not
 * testing it: it reads as coverage.
 *
 * What the guard protects is a future change to `CACHEABLE`, or a second caller
 * of `saveVerdicts`, crediting a model for a decision it did not make — which is
 * the thing the ledger prints provenance to prevent.
 */
export function verdictRow(
  row: { fingerprint: string; verdict: ResolvedVerdict },
  run: FocusModelRun | undefined,
) {
  const fromModel = row.verdict.source === 'MODEL' && run !== undefined;
  return {
    class: row.verdict.class,
    epicKey: row.verdict.epicKey,
    reason: row.verdict.reason.slice(0, 400),
    source: row.verdict.source!,
    ruleId: row.verdict.ruleId ?? null,
    model: fromModel ? run.model : null,
    promptVersion: fromModel ? run.promptVersion : null,
  };
}

async function saveVerdicts(
  deps: FocusDataDeps,
  rows: { fingerprint: string; verdict: ResolvedVerdict }[],
  run?: FocusModelRun,
): Promise<void> {
  if (!deps.organizationId) return;

  // Batched rather than a sequential upsert per task: this runs inside a page
  // load, and one round trip per task is the difference between a fast view and
  // a visibly slow one on a real backlog.
  //
  // **Every class is storable now, so nothing is narrowed here.** `FocusClassKey`
  // and Prisma's `FocusClass` are both `A | B | C | UNCLASSIFIED` (R6.4), so
  // `verdict.class` is assignable as it stands. This used to route through a
  // `toStoredClass` helper that mapped the old class D to null and dropped the
  // row, because D had no `FocusClass` member and would have raised a Prisma enum
  // error inside a page load. That helper also documented a real hazard worth
  // keeping in mind: it once took a `string` parameter and cast the result, and a
  // cast like that launders any value — so the behavioural guard was the only
  // protection and nothing said so. The reason it can go is not that the hazard
  // stopped mattering; it is that the two unions are now equal and the compiler
  // checks the assignment itself.
  //
  // The source filter is a SEPARATE guard and still required: a verdict no
  // classifier produced must not be written as though one had.
  const writable = rows.filter((r) => r.verdict.source !== null);

  await deps.prisma.$transaction(
    writable.map((row) =>
      deps.prisma.focusVerdict.upsert({
        where: {
          organizationId_fingerprint: {
            organizationId: deps.organizationId!,
            fingerprint: row.fingerprint,
          },
        },
        // Only a HUMAN verdict is permanent. Freezing every source meant that
        // editing a rule left every previously-classified task on its old class
        // forever, with no invalidation path — so a rule or model verdict is
        // refreshed and a hand-made one is not. `loadVerdicts` never returns a
        // HUMAN row to be overwritten here: the classifier short-circuits on it
        // before this is reached.
        update: verdictRow(row, run),
        create: {
          organizationId: deps.organizationId!,
          fingerprint: row.fingerprint,
          ...verdictRow(row, run),
        },
      })
    )
  );
}

/**
 * The board's own rows: which tasks are on it, and what finance called them.
 *
 * Read from Postgres, which is where `Project.costClassification` is actually
 * maintained. It was previously read from `board_item_classification` in
 * ClickHouse — a DERIVED MIRROR written only by live edits made since that
 * feature shipped, plus a manual backfill script with no caller. On a real
 * deployment that mirror held 12 rows against 111 classified projects, so 89%
 * of the classifications never reached the classifier and almost nothing was
 * ever marked roadmap.
 *
 * The same mirror was standing in for "is this task on the board", which is
 * worse: it only ever contained CLASSIFIED items, so an unclassified board row
 * counted as off-board and the "never reached this board" figure was inflated
 * by everything nobody had got round to classifying.
 *
 * Reading the source of truth removes both defects, and removes the staleness
 * class itself rather than asking someone to remember a backfill.
 *
 * CAPEX remains a HIGH-PRECISION SIGNAL ON A MINORITY, not a backbone: measured
 * in Postgres it covers ~0.3% of projects, and it exists only for tasks someone
 * curated onto a board, while this view deliberately counts everything synced.
 * The classifier must work without it and the provenance widget reports how
 * thin it is.
 */
async function loadBoardRows(
  deps: FocusDataDeps,
  boardId: string,
): Promise<{
  onBoard: Set<string>;
  capex: Map<string, 'CAPEX' | 'OPEX'>;
  /** Jira CAPEX epics, resolvable from Postgres alone. */
  roadmapEpics: { key: string; title: string }[];
  /**
   * CAPEX ADO rows whose TYPE is still unknown.
   *
   * `Project` has no ADO work-item-type column, so these cannot be filtered to
   * epics here. `loadAdoRoadmapEpics` resolves the type from ClickHouse and
   * keeps the ones that are epics.
   */
  adoCapexCandidates: { adoId: number; title: string }[];
}> {
  const rows = await deps.prisma.project.findMany({
    // The organization predicate is belt to the braces of `getWidgetBoardScope`,
    // which already fails closed on a foreign board — a null scope returns
    // before this runs. It is restated here because the read it replaced went
    // through a per-org ClickHouse role with row policies, and dropping to
    // Prisma silently gave up that second, independent check. `Project` has no
    // organizationId of its own, so it is expressed through the board.
    where: {
      boardId,
      ...(deps.organizationId ? { board: { organizationId: deps.organizationId } } : {}),
    },
    select: {
      jiraKey: true,
      adoWorkItemId: true,
      costClassification: true,
      // For the roadmap-epic denominator (R6.10). `jiraType` is how this repo
      // already identifies an epic (`jira-promote.service.ts`).
      jiraType: true,
      // The board row's label. `name`, not `title`: `Project` has no `title`
      // column, and naming one makes Prisma reject this whole query — which
      // takes every Focus widget down together, since they share one snapshot.
      name: true,
    },
  });

  const onBoard = new Set<string>();
  const capex = new Map<string, 'CAPEX' | 'OPEX'>();
  const roadmapEpics: { key: string; title: string }[] = [];
  const adoCapexCandidates: { adoId: number; title: string }[] = [];

  for (const row of rows) {
    // The keys the focus union emits: the Jira key as-is, and ADO work items as
    // `ADO-<id>`. Matching those directly means there is no second spelling to
    // keep in step — which is the whole reason `board_item_key` existed, and
    // the reason CAPEX silently missed every ADO task until it was fixed.
    const keys = [
      row.jiraKey,
      row.adoWorkItemId != null ? `ADO-${row.adoWorkItemId}` : null,
    ].filter((k): k is string => !!k);

    for (const key of keys) {
      onBoard.add(key);
      if (row.costClassification) capex.set(key, row.costClassification);
    }

    /**
     * The roadmap-epic denominator (R6.10): CAPEX-marked board rows that are
     * epics.
     *
     * **Both halves of that predicate matter.** Without the CAPEX half an OPEX
     * or unclassified epic joins a set whose whole meaning is "the roadmap".
     * Without the epic half, a TASK someone marked CAPEX directly appears in a
     * count of epics — and on a real board most CAPEX rows are tasks, so the
     * denominator would be dominated by things that are not epics at all.
     *
     * Deliberately NOT derived from what the window's tasks reference, even
     * though `parentOf` and `epic_key` are already loaded and would need no type
     * lookup. An epic nothing points at would vanish — deleting the one figure
     * these widgets exist to report, "N received nothing at all". The
     * denominator has to be independent of whether work happened.
     *
     * Keyed by `jiraKey` alone: `jiraType` is a Jira field, so an ADO row cannot
     * satisfy this branch. The ADO leg needs `work_item_type` from ClickHouse
     * and is a separate read.
     */
    if (row.costClassification === 'CAPEX' && row.jiraType === 'Epic' && row.jiraKey) {
      roadmapEpics.push({ key: row.jiraKey, title: row.name });
    }

    if (row.costClassification === 'CAPEX' && row.adoWorkItemId != null) {
      adoCapexCandidates.push({ adoId: row.adoWorkItemId, title: row.name });
    }
  }

  return { onBoard, capex, roadmapEpics, adoCapexCandidates };
}

/**
 * Keep the CAPEX ADO rows that are actually epics, by reading their type.
 *
 * `Project` carries `jiraType` but nothing equivalent for ADO, so this is the
 * one place the epic predicate needs ClickHouse. The asymmetry with the Jira leg
 * is in the schema, not here.
 *
 * Scoped with `adoScopeFilter` rather than a bare `project IN`: ADO project
 * names are unique only WITHIN an organisation, and `ado_work_items` carries
 * `org_url`, so a looser read could admit another org's rows and put a foreign
 * epic in this board's denominator.
 *
 * Type is matched as `Epic` only. **Accepted limitation:** ADO's Agile and Scrum
 * templates also place `Feature` above `Story`, so a board treating Features as
 * its roadmap level derives nothing here. Admitting both makes the coverage
 * denominator ambiguous whenever a CAPEX Epic contains CAPEX Features — one
 * roadmap item counted twice — so the unambiguous version ships and a board that
 * needs the other can say so.
 */
async function loadAdoRoadmapEpics(
  deps: FocusDataDeps,
  scope: WidgetBoardScope,
  candidates: { adoId: number; title: string }[],
): Promise<{ key: string; title: string }[]> {
  // No candidates means no query. An empty `IN ()` is a wasted round trip and a
  // ClickHouse syntax hazard, and a board with no ADO sources is the common case.
  if (candidates.length === 0 || scope.adoProjects.length === 0) return [];

  const params: Record<string, unknown> = {
    adoEpicIds: candidates.map((c) => c.adoId),
  };
  const sql = `
    SELECT ado_id AS ado_id, work_item_type AS ado_type
    FROM cockpit.ado_work_items FINAL
    WHERE ${adoScopeFilter(scope, params)}
      AND ado_id IN {adoEpicIds:Array(UInt32)}
  `;

  const rows = castRows<{ ado_id: number; ado_type: string }>(
    await (
      await deps.clickhouse.query({ query: sql, query_params: params, format: 'JSONEachRow' })
    ).json(),
  );

  const epicIds = new Set(
    rows.filter((r) => r.ado_type === 'Epic').map((r) => Number(r.ado_id)),
  );

  // Keyed `ADO-<id>`, the spelling the focus union emits everywhere else in this
  // path. A raw numeric key would match no `task_key`, so the epic could never be
  // marked touched — the same silent miss that made CAPEX skip every ADO task.
  return candidates
    .filter((c) => epicIds.has(c.adoId))
    .map((c) => ({ key: `ADO-${c.adoId}`, title: c.title }));
}

/**
 * Each assignee's earliest TICKET MOVEMENT, used as a floor for their own window.
 *
 * Read the direction of the error carefully, because it is the opposite of what
 * it first looks like. A person's real start is at or BEFORE their first ticket
 * movement — they may have been committing for weeks first — so this date is
 * later than the truth. A later start means a SHORTER window, which INFLATES
 * their activity rate and can label someone long-tenured a late joiner.
 *
 * That is the safer direction for the specific harm this floor exists to
 * prevent (a start date read as idleness), but it is not free, and it is not
 * what R6.11 specifies: that asks for first activity across commits, work items
 * AND transitions. Until the commit leg is added this measures one of the three,
 * which is why the caveat and the scorecard both say "first recorded ticket
 * movement" rather than "first recorded activity".
 */
async function loadFirstActivity(
  deps: FocusDataDeps,
  transitions: FocusTransitionRow[],
): Promise<Map<string, Date>> {
  void deps;
  const out = new Map<string, Date>();
  for (const row of transitions) {
    const who = row.changed_by;
    if (!who) continue;
    const at = new Date(row.at);
    const seen = out.get(who);
    if (!seen || at < seen) out.set(who, at);
  }
  return out;
}
