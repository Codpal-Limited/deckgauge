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
  rules?: FocusRule[];
  roadmapEpics: ReadonlySet<string>;
}

export interface ClassificationResult {
  byTaskKey: Map<string, ResolvedVerdict>;
  /** How many tasks each classifier decided — the provenance widget's numbers. */
  provenance: { HUMAN: number; CAPEX: number; RULE: number; MODEL: number; NONE: number };
  /** Tasks no classifier could reach. Stated, never defaulted to a class. */
  unclassified: number;
  /** How many tasks were actually sent to the model. */
  modelCalls: number;
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

/** The parent epic's classification, when the epic is itself a classified board row. */
function epicCapexFor(
  task: ClassifiableTask,
  capex: Map<string, 'CAPEX' | 'OPEX'>,
): { classification: 'CAPEX' | 'OPEX'; epicKey: string } | null {
  if (!task.epicKey) return null;
  const classification = capex.get(task.epicKey);
  return classification ? { classification, epicKey: task.epicKey } : null;
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
      ...new Set(tasks.flatMap((t) => (t.epicKey ? [t.taskKey, t.epicKey] : [t.taskKey]))),
    ]),
  ]);

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
    const epicCapex = epicCapexFor(task, capex);

    // Inheritance applies only when the task carries no classification of its
    // own. This condition MUST match the resolver's `!capex` guard: admitting a
    // task the resolver then declines to classify drops it out of the residue
    // and it never reaches the model — it silently returns UNCLASSIFIED.
    const inherits = !capexFlag && epicCapex?.classification === 'CAPEX';

    if (capexFlag === 'CAPEX' || inherits || ruleHit) {
      byTaskKey.set(task.taskKey, resolveVerdict({ capex: capexFlag, epicCapex, ruleHit }));
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

  // Pass two: the model, if there is one.
  let modelCalls = 0;
  if (deps.classifyWithModel && residue.length > 0) {
    const verdicts = await classifyResidue(residue, deps);
    modelCalls = residue.length;

    for (const task of residue) {
      const verdict = verdicts.get(task.taskKey) ?? null;
      byTaskKey.set(
        task.taskKey,
        resolveVerdict({
          capex: capex.get(task.taskKey) ?? null,
          epicCapex: epicCapexFor(task, capex),
          model: verdict,
        }),
      );
    }
  } else {
    for (const task of residue) {
      byTaskKey.set(
        task.taskKey,
        resolveVerdict({
          capex: capex.get(task.taskKey) ?? null,
          epicCapex: epicCapexFor(task, capex),
        }),
      );
    }
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

  return { byTaskKey, provenance, unclassified: provenance.NONE, modelCalls };
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
