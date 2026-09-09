import {
  DEFAULT_RULES,
  FocusModelVerdictSchema,
  coerceModelVerdict,
  matchRules,
  resolveVerdict,
  type ClassifierVerdict,
  type FocusModelVerdict,
  type FocusPromptTask,
  type FocusRule,
  type ResolvedVerdict,
} from '@deckgauge/shared';
import { taskFingerprint } from '@deckgauge/shared/focus/fingerprint.js';

export interface ClassifiableTask {
  taskKey: string;
  title: string;
  description: string | null;
  type: string;
  repo: string | null;
  epicKey: string | null;
}

export interface StoredVerdict extends ClassifierVerdict {
  source: 'HUMAN' | 'CAPEX' | 'RULE' | 'MODEL';
}

export interface ClassificationDeps {
  /** Cached verdicts by content fingerprint. */
  loadVerdicts(fingerprints: string[]): Promise<Map<string, StoredVerdict>>;
  /**
   * `Project.costClassification` for the given ISSUE KEYS, which include both
   * the tasks and their parent epics — an epic that is on the board is itself a
   * classified board row, and a task inherits from it.
   *
   * Named "issue keys" rather than "task keys" because the previous name was a
   * lie that only held by accident: the production implementation ignores its
   * argument and returns the whole board, so an implementation that honoured
   * the documented contract would have returned no epics and silently disabled
   * inheritance with every test still green.
   */
  loadCapex(issueKeys: string[]): Promise<Map<string, 'CAPEX' | 'OPEX'>>;
  /** Null when no advisor LLM is configured for this org. */
  classifyWithModel:
    | ((tasks: FocusPromptTask[]) => Promise<unknown[]>)
    | null;
  saveVerdicts(rows: { fingerprint: string; verdict: ResolvedVerdict }[]): Promise<void>;
  /**
   * How many residue tasks this run may send to the model. Unset means all of
   * them, which is the page-load path's behaviour and every existing caller's.
   *
   * The cap lives here rather than in the route because only this function knows
   * what the residue IS — the tasks no cached verdict, no board classification
   * and no rule could reach. A route capping the INPUT would spend the budget on
   * tasks the cheap tiers were about to answer for free.
   */
  modelBudget?: number;
  rules?: FocusRule[];
  roadmapEpics: ReadonlySet<string>;
  /**
   * Child issue key -> parent issue key, for every issue in the board's scope.
   *
   * What makes inheritance reach a SUB-TASK. Jira does not put an epic link on
   * one: `epic_key` comes from `customfield_10014`, which sub-tasks never
   * carry, so `epicKey` above is null for all 1,650 of them on the reference
   * instance and a one-hop classifier cannot reach a single one. Their epic is
   * the parent's parent.
   *
   * `parent_key` is a strict superset of `epic_key` there — 4,223 issues carry
   * both and the two are IDENTICAL in every case, and none has an `epic_key`
   * without a `parent_key` — so walking this map alone loses nothing that the
   * one-hop path used to find. `epicKey` is still consulted first all the same,
   * because it is the field the epic-link rule and the display fallback already
   * read, and having the two disagree about the first hop would be worse than
   * the redundancy.
   *
   * Optional, and an absent map degrades to exactly the previous one-hop
   * behaviour rather than to no inheritance at all.
   *
   * Scoped to the board, because `buildFocusParentsSql` is: an ancestor in a
   * Jira project the board does not include is not in here and ends the walk.
   */
  parentOf?: ReadonlyMap<string, string>;
}

export interface ClassificationResult {
  byTaskKey: Map<string, ResolvedVerdict>;
  /** How many tasks each classifier decided — the provenance widget's numbers. */
  provenance: { HUMAN: number; CAPEX: number; RULE: number; MODEL: number; NONE: number };
  /** Tasks no classifier could reach. Stated, never defaulted to a class. */
  unclassified: number;
  /** How many tasks were actually sent to the model. */
  modelCalls: number;
  /**
   * How many tasks THIS run got a MODEL verdict for — cache hits excluded.
   *
   * Distinct from `provenance.MODEL`, which is cumulative: it counts every task
   * carrying a model class, including ones a previous run paid for and this one
   * merely replayed. Reporting that as a run's output makes a second press read
   * "classified 340" beside "modelCalls: 140" — a claim of work that did not
   * happen, and a false efficiency figure against the per-call cost.
   *
   * `remaining` had the same defect in the other direction and is now derived
   * from `unclassified`; this is the same correction one field over.
   */
  newlyClassified: number;
  /**
   * How many tasks the cheap tiers could not answer, WHETHER OR NOT the budget
   * let them reach the model.
   *
   * **Do NOT compute a remainder as `residueTotal - modelCalls`.** That treats a
   * SENT task as finished, which is false whenever the model did not answer for
   * it — a provider failure or a malformed verdict leaves the task `source:
   * null`, uncacheable, and re-sent on the next press. `unclassified` above is
   * the honest remainder, because it counts what still has no class after the
   * run rather than what was paid for. An earlier version of this comment
   * recommended the subtraction and was wrong.
   */
  residueTotal: number;
  /**
   * The fingerprint each task was keyed under — the primary key of the
   * `focus_verdicts` row that decides it, alongside the organization.
   *
   * Returned rather than kept private because anything that WRITES a verdict has
   * to name one, and the ledger's class picker is exactly that. The alternative
   * — a second caller computing `taskFingerprint` for itself — is a second
   * definition of the storage key, and the failure mode is silent: the override
   * is written, the request succeeds, and the row is never read again because it
   * is filed under a hash nothing looks up.
   *
   * Keyed by task key rather than returned as a list because the consumer starts
   * from a rendered row, not from a hash.
   */
  fingerprintByTaskKey: Map<string, string>;
}

const MODEL_BATCH = 40;

function fromStored(stored: StoredVerdict): ResolvedVerdict {
  return {
    class: stored.class,
    epicKey: stored.epicKey,
    reason: stored.reason,
    source: stored.source,
    ruleId: null,
  };
}

/**
 * Walk up from a task to the NEAREST ancestor that is a classified board row.
 *
 * Nearest, not highest: the closest decision is the most specific one. A CAPEX
 * initiative sitting above an OPEX epic must not reach through it and re-promote
 * work somebody deliberately marked operational — the same precedence that makes
 * a task's own flag beat its epic's, one level up.
 *
 * The first hop is `epicKey` when the task has one, so a task whose epic link is
 * set behaves exactly as it did before this walk existed; every hop after that
 * is `parentOf`. An epic that is itself unclassified does NOT end the walk (10
 * epics on the reference instance hang off an Initiative), which is the only
 * behaviour change for tasks that already had an epic link.
 *
 * Returns the ancestor's own key, so `resolveVerdict` names the row somebody
 * actually classified. Naming the intermediate parent would attribute the call
 * to a row that decided nothing and cannot be argued with.
 *
 * **`ancestorKey` is not necessarily an epic, and `epicKey` is the only field
 * that claims to be one.** `loadCapex` returns every classified board row with
 * no type filter — `focus-data.service.ts` states that on a real board most
 * CAPEX rows are tasks — so the walk routinely stops on a Story, a Task or an
 * Initiative. `roadmapEpics` is the board's CAPEX-marked EPICS, which is exactly
 * the licence to attribute one; without it the key is still worth NAMING in the
 * reason but must not reach the roadmap-coverage join. Before the walk existed
 * this distinction did not: the key came from the `epic_key` column and was an
 * epic by construction.
 */
function classifiedAncestorFor(
  task: ClassifiableTask,
  capex: Map<string, 'CAPEX' | 'OPEX'>,
  roadmapEpics: ReadonlySet<string>,
  parentOf?: ReadonlyMap<string, string>,
): { ancestorKey: string; classification: 'CAPEX' | 'OPEX'; epicKey: string | null } | null {
  for (const key of ancestorsOf(task, parentOf)) {
    const classification = capex.get(key);
    if (classification) {
      return {
        ancestorKey: key,
        classification,
        epicKey: roadmapEpics.has(key) ? key : null,
      };
    }
  }
  return null;
}

/**
 * Every ancestor of a task, nearest first.
 *
 * `seen` is the ONLY thing that terminates this walk, and it is enough: each
 * iteration adds one key to it and the walk stops the moment a key repeats, so
 * the worst case is one hop per distinct issue in `parentOf` and a chain that
 * loops ends on the hop that closes it. A second, arbitrary hop-count ceiling
 * was here and has been removed — it terminated every cycle before `seen` ever
 * saw one, which left no test able to tell whether `seen` worked, and two
 * mechanisms for one job is how you end up not knowing which is load-bearing.
 *
 * A loop matters because nothing prevents one: Jira permits it and the sync
 * does not validate it. Every Focus widget shares this one call, so an
 * unterminated walk is the whole page hanging, not one task degrading.
 */
function* ancestorsOf(
  task: ClassifiableTask,
  parentOf?: ReadonlyMap<string, string>,
): Generator<string> {
  let current = task.epicKey ?? parentOf?.get(task.taskKey) ?? null;
  const seen = new Set<string>([task.taskKey]);

  while (current) {
    if (seen.has(current)) return;
    seen.add(current);
    yield current;
    current = parentOf?.get(current) ?? null;
  }
}

/**
 * Classify a window's tasks, cheapest classifier first.
 *
 * The order of work is the point. Cached verdicts are loaded once and never
 * recomputed — a task whose title and description have not changed keeps the
 * judgement already made about it, which is what bounds model spend to genuinely
 * new work and what makes a human override permanent.
 *
 * Only the residue — no cached verdict, no CAPEX flag, no rule hit — is batched
 * to the model. With no model configured that residue is returned as
 * UNCLASSIFIED and counted. It is never defaulted to a class: guessing C would
 * silently inflate the least flattering number on the page, and guessing A the
 * most flattering.
 */
export async function classifyTasks(
  tasks: ClassifiableTask[],
  deps: ClassificationDeps,
): Promise<ClassificationResult> {
  const rules = deps.rules ?? DEFAULT_RULES;

  const fingerprints = new Map<string, string>();
  for (const t of tasks) fingerprints.set(t.taskKey, taskFingerprint(t.title, t.description));

  const [cached, capex] = await Promise.all([
    deps.loadVerdicts([...new Set(fingerprints.values())]),
    deps.loadCapex([
      // The task and EVERY ancestor the walk may consult. The production
      // implementation ignores this argument and returns the whole board, so
      // this is the documented contract rather than a live constraint — which is
      // exactly why it has to be right: an implementation that honoured it while
      // this listed only the first hop would silently stop inheritance one level
      // below where it now reaches, with every other test still green.
      ...new Set(tasks.flatMap((t) => [t.taskKey, ...ancestorsOf(t, deps.parentOf)])),
    ]),
  ]);

  /**
   * One walk per task, reused by all three `resolveVerdict` sites below.
   *
   * The walk was previously re-run at each of them. Harmless at real Jira depth
   * — three hops — but it made the cost of a deep chain quietly cubic in the
   * number of places someone adds a call, and there is no reason for the answer
   * to be recomputed when neither `capex` nor `parentOf` changes within a run.
   */
  const ancestorOf = new Map(
    tasks.map((t) => [
      t.taskKey,
      classifiedAncestorFor(t, capex, deps.roadmapEpics, deps.parentOf),
    ]),
  );

  // Pass one: everything that can be decided without the model.
  const byTaskKey = new Map<string, ResolvedVerdict>();
  const residue: ClassifiableTask[] = [];
  /**
   * Tasks answered FROM the cache, which is not the same as tasks present in
   * it. A legacy RULE or CAPEX row is present but never honoured; using
   * presence to mean "already stored" left the replacement MODEL verdict
   * permanently unsaved, so the model was re-invoked on every render and its
   * answer thrown away — defeating the only reason MODEL is cached.
   */
  const servedFromCache = new Set<string>();

  for (const task of tasks) {
    const fingerprint = fingerprints.get(task.taskKey)!;
    const stored = cached.get(fingerprint);

    // A HUMAN verdict is final and is consulted before anything else.
    if (stored?.source === 'HUMAN') {
      byTaskKey.set(task.taskKey, fromStored(stored));
      servedFromCache.add(task.taskKey);
      continue;
    }

    // Then the classifiers that are CHEAP AND CURRENT: the board row, its epic,
    // and the rules. They run every time, so a classification made after the
    // last render is picked up rather than frozen out by a stale cached answer.
    const ruleHit = matchRules(task, rules, deps.roadmapEpics);
    const capexFlag = capex.get(task.taskKey) ?? null;
    const ancestorCapex = ancestorOf.get(task.taskKey) ?? null;

    // Inheritance applies only when the task carries no classification of its
    // own. This condition MUST match the resolver's `!capex` guard: admitting a
    // task the resolver then declines to classify drops it out of the residue
    // and it never reaches the model — it silently returns UNCLASSIFIED.
    const inherits = !capexFlag && ancestorCapex?.classification === 'CAPEX';

    if (capexFlag === 'CAPEX' || inherits || ruleHit) {
      byTaskKey.set(task.taskKey, resolveVerdict({ capex: capexFlag, ancestorCapex, ruleHit }));
      continue;
    }

    // Only now the cache, and only for MODEL. It sits BELOW the board and the
    // rules on purpose: R6.5 puts costClassification above the model, and a
    // cached model verdict consulted first would freeze a task at its old class
    // when its epic is classified later — the same defect that made RULE
    // uncacheable, and the complaint that prompted inheritance.
    //
    // A fingerprint is normalised title + description, so a stored verdict
    // replays onto ANY task with the same words. Sound for MODEL, which is a
    // judgement about those words, and for HUMAN, which is a decision someone
    // made. NOT sound for CAPEX, a fact about the BOARD: two tasks both titled
    // "Revert" under a CAPEX epic and an OPEX epic share a fingerprint, and
    // caching the first reported the second as roadmap. Observed in real data.
    if (stored?.source === 'MODEL') {
      byTaskKey.set(task.taskKey, fromStored(stored));
      servedFromCache.add(task.taskKey);
      continue;
    }

    residue.push(task);
  }

  // Pass two: the model, if there is one and the budget allows.
  //
  // `sent` and `held` partition the residue rather than filtering it: every task
  // still gets a `byTaskKey` entry below, because dropping the ones the budget
  // could not afford would shrink the population every widget divides by — the
  // page would silently report on whatever the run paid for.
  let modelCalls = 0;
  let newlyClassified = 0;
  const budget = deps.modelBudget ?? residue.length;
  const sent = residue.slice(0, budget);
  const held = residue.slice(budget);

  if (deps.classifyWithModel && sent.length > 0) {
    const verdicts = await classifyResidue(sent, deps);
    modelCalls = sent.length;

    for (const task of sent) {
      const verdict = verdicts.get(task.taskKey) ?? null;
      const resolved = resolveVerdict({
        capex: capex.get(task.taskKey) ?? null,
        ancestorCapex: ancestorOf.get(task.taskKey) ?? null,
        model: verdict,
      });
      // Counted over `sent` only, which is what makes it per-run: a cache hit
      // never reaches this loop.
      if (resolved.source === 'MODEL') newlyClassified += 1;
      byTaskKey.set(task.taskKey, resolved);
    }
  }

  // Everything the model did not answer: the whole residue when there is no
  // model, and the over-budget tail when there is. Resolved through the same
  // path, so an unsent task is indistinguishable from an unanswerable one —
  // UNCLASSIFIED, counted, never guessed at.
  const unsent = deps.classifyWithModel ? held : residue;
  for (const task of unsent) {
    byTaskKey.set(
      task.taskKey,
      resolveVerdict({
        capex: capex.get(task.taskKey) ?? null,
        ancestorCapex: ancestorOf.get(task.taskKey) ?? null,
      }),
    );
  }

  // Persist only what is expensive to recompute or deliberate: a MODEL call
  // costs money, and a HUMAN override is a decision. RULE and CAPEX are
  // recomputed every run — cheap, and both change when the board or the rules
  // do, which a content-addressed cache cannot notice.
  const CACHEABLE = new Set(['HUMAN', 'MODEL']);
  const fresh = tasks
    .filter((t) => !servedFromCache.has(t.taskKey))
    .map((t) => ({ fingerprint: fingerprints.get(t.taskKey)!, verdict: byTaskKey.get(t.taskKey)! }))
    .filter((r) => r.verdict.source !== null && CACHEABLE.has(r.verdict.source));

  if (fresh.length > 0) await deps.saveVerdicts(fresh);

  const provenance = { HUMAN: 0, CAPEX: 0, RULE: 0, MODEL: 0, NONE: 0 };
  for (const v of byTaskKey.values()) provenance[v.source ?? 'NONE'] += 1;

  return {
    byTaskKey,
    provenance,
    unclassified: provenance.NONE,
    modelCalls,
    newlyClassified,
    residueTotal: residue.length,
    fingerprintByTaskKey: fingerprints,
  };
}

async function classifyResidue(
  residue: ClassifiableTask[],
  deps: ClassificationDeps,
): Promise<Map<string, FocusModelVerdict>> {
  const out = new Map<string, FocusModelVerdict>();

  for (let i = 0; i < residue.length; i += MODEL_BATCH) {
    const batch = residue.slice(i, i + MODEL_BATCH);
    const raw = await deps.classifyWithModel!(
      batch.map((t) => ({
        id: t.taskKey,
        title: t.title,
        description: t.description,
        type: t.type,
        repo: t.repo,
      })),
    );

    for (const item of raw) {
      // A malformed verdict is dropped, not coerced into a class. The task falls
      // through to UNCLASSIFIED and is counted, which is visible; inventing a
      // class for it would not be.
      const parsed = FocusModelVerdictSchema.safeParse(item);
      if (!parsed.success) continue;
      out.set(parsed.data.id, coerceModelVerdict(parsed.data, deps.roadmapEpics));
    }
  }

  return out;
}
