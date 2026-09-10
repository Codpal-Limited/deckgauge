import {
  AGENT_TOOL_BATCH_DEFAULT,
  coerceModelVerdict,
  FOCUS_MODEL_BUDGET,
  FOCUS_VERDICT_REASON_MAX,
  type FocusModelVerdict,
  type FocusPromptEpic,
  type FocusPromptTask,
  type ListUnclassifiedTasksResultDto,
  type RejectedFocusVerdictDto,
  type ResolvedVerdict,
  type SetFocusVerdictsResultDto,
} from '@deckgauge/shared';
import { runFocusClassification, type FocusDataDeps } from './focus-data.service.js';
import { DEFAULT_DAYS } from '../intelligence-query/builders/focus-task-measures.js';
import { resolvePeriod } from '../intelligence-query/builders/period.js';
import { resolveDays } from '../widgets/widget-helpers.js';

/**
 * The API side of the local-agent-bridge's two MCP tools —
 * `list_unclassified_tasks` and `set_focus_verdicts`
 * (`packages/shared/src/focus/agent-tools.ts`, registered in
 * `apps/api/src/advisor/tools.ts`). This file owns `listResidue`, which hands
 * an operator's own local coding agent exactly the tasks the cheap tiers could
 * not answer — never every unclassified row — so the agent classifies genuine
 * residue instead of re-deriving, and potentially contradicting, what the
 * board's CAPEX flags and rules already decided; and `setVerdicts`, which
 * writes what the agent decided back to `focus_verdicts` — the first
 * `mutates: true` MCP tool in this repo that writes directly rather than
 * proposing (design spec `docs/superpowers/specs/
 * 2026-09-09-focus-classification-via-local-agent-bridge-design.md`, § 6).
 */

/**
 * Lists the genuine residue for `boardId`: the tasks that no cached verdict, no
 * board CAPEX flag (own or inherited up the ancestor chain), and no keyword
 * rule could answer.
 *
 * **Deliberately not a direct query for "tasks with no verdict row".** Such a
 * query would hand the agent every unclassified task, including ones the rule
 * tier would have decided for free on the next render — inviting the agent to
 * reclassify, and possibly contradict, an answer that already exists. Instead
 * this drives `runFocusClassification` with a CAPTURING NO-OP classifier
 * passed through `classifierFor`: the whole cheap-tier pipeline runs exactly as
 * it does for a normal advisor press — capex inheritance, the ancestor walk,
 * rule hits, the verdict cache — and the only thing that differs is what
 * answers what is left. In place of a real model, `classifierFor` returns a
 * function that records every `FocusPromptTask[]` batch handed to it (one call
 * per `MODEL_BATCH`-sized batch, see `classification.service.ts`) and answers
 * `[]`, so nothing it is given is ever "classified" by it — what comes back is
 * only what could not be resolved a cheaper way.
 *
 * **Nothing new is persisted.** Because the capturing classifier always
 * returns `[]`, `classifyTasks` never produces a MODEL verdict for any of
 * these tasks — and RULE/CAPEX verdicts were never persisted to begin with:
 * `classification.service.ts`'s `CACHEABLE` set admits only HUMAN and MODEL,
 * because RULE and CAPEX are recomputed every run and a content-addressed
 * cache cannot notice when the board or the rules change. So this call writes
 * nothing at all. The `run` value below exists only to satisfy
 * `FocusClassificationRunOptions`'s type — it can never reach a stored row
 * through this path, since no MODEL verdict is ever produced to carry it.
 *
 * **What `classifyTasks` hands the classifier is NOT yet "genuine residue",
 * and treating it as such was Fix Round 1's bug.** Pass 1 there
 * (`classification.service.ts`) only fast-paths a task on a CAPEX flag,
 * inherited CAPEX, or a rule hit — an OPEX-flagged task (own or inherited),
 * with no rule hit, falls through to `residue.push(task)` exactly like a task
 * nothing can answer. It is pass 2's `resolveVerdict` (`resolve-verdict.ts`'s
 * `notRoadmap` branch) that later resolves it to a real answer: class B,
 * source `CAPEX`, no model involved, no verdict withheld. A first version of
 * this function captured every task handed to the classifier and called that
 * the residue — which handed the agent tasks the board had already answered,
 * and (proven by a limit smaller than that population) could starve the
 * genuinely-open tasks out of the page entirely, since slicing happened on the
 * PRE-resolution population.
 *
 * The fix: `onResolved` receives `classifyTasks`' own final `byTaskKey` — the
 * same map it builds for provenance — and `genuinelyOpen` filters the captured
 * tasks down to the ones whose resolved `source` is `null`. **That single
 * predicate defines both halves of the answer**: `tasks` is a slice of it,
 * and `remaining` is what the slice left behind. There is no second, looser
 * population used for one but not the other.
 *
 * `modelBudget` is deliberately UNSET here (unlike the real advisor route),
 * so the capturing classifier is handed the WHOLE pass-1 residue rather than a
 * budget-limited prefix of it. Capping the population the filter runs over
 * would reintroduce exactly this bug one level up: a budget cut against the
 * mixed pre-resolution population can still exclude genuinely-open tasks that
 * happen to sort after enough OPEX ones. Nothing here calls a real model, so
 * there is no spend to bound — only `limit`, applied below to the FILTERED
 * population, bounds what a single call hands back.
 *
 * `limit` is clamped to `FOCUS_MODEL_BUDGET` for the same reason the schema
 * enforces it: a direct call (this file's own tests, or a future caller that
 * bypasses `listUnclassifiedTasksInputSchema`) must not be able to ask this
 * function for more than the board-wide ceiling allows.
 *
 * Returns null when the board has no issue source, exactly as
 * `runFocusClassification` does — an empty `tasks` array would read as
 * "nothing left to classify", which is a different and false statement.
 *
 * **`window` reports the range this call actually scanned, and it is
 * transparency, not configurability.** The `{}` config handed to
 * `runFocusClassification` below means `buildFocusTaskMeasuresSql` always
 * falls back to `DEFAULT_DAYS` — this call has no access to the board's
 * on-screen period (the widget config `useWidgetConfigWithBoardPeriod`
 * builds), so on a board whose period is not the last `DEFAULT_DAYS` days,
 * the residue handed to the agent is a different population from what the
 * classify button would have worked over. Computed independently here via
 * the same `resolveDays`/`resolvePeriod` helpers `buildFocusTaskMeasuresSql`
 * calls internally, rather than threaded back out of it, because those
 * helpers are pure functions of the same `{}` config and `Date.now` — there
 * is no second source of truth to drift from. Known limitation, recorded in
 * `planning/STATE.md`; the follow-up is giving this tool an explicit window
 * rather than only stating the one it fell back to.
 */
export async function listResidue(
  deps: FocusDataDeps,
  boardId: string,
  limit: number = AGENT_TOOL_BATCH_DEFAULT,
): Promise<ListUnclassifiedTasksResultDto | null> {
  const captured: FocusPromptTask[] = [];
  // Populated by `classifierFor` below, which is handed the run's roadmap
  // epics before it ever calls the returned function — the same epics a real
  // model prompt would carry. Captured here because `runFocusClassification`'s
  // result does not expose them.
  let epics: readonly FocusPromptEpic[] = [];
  // Populated by `onResolved` once `classifyTasks` has finished pass 2 — see
  // the "genuine residue" paragraph above for why this, and not "was handed to
  // the classifier at all", is the predicate that decides membership.
  let resolvedByTaskKey: ReadonlyMap<string, ResolvedVerdict> = new Map();

  const result = await runFocusClassification(deps, boardId, {}, {
    classifierFor: (roadmapEpics) => {
      epics = roadmapEpics;
      return (batch) => {
        captured.push(...batch);
        return Promise.resolve([]);
      };
    },
    onResolved: ({ byTaskKey }) => {
      resolvedByTaskKey = byTaskKey;
    },
    run: { model: 'local-agent-bridge', promptVersion: 'n/a' },
  });

  if (!result) return null;

  const genuinelyOpen = captured.filter((task) => resolvedByTaskKey.get(task.id)?.source == null);
  const tasks = genuinelyOpen.slice(0, Math.min(limit, FOCUS_MODEL_BUDGET));

  const days = resolveDays(undefined, DEFAULT_DAYS);
  const { from, to } = resolvePeriod({}, Date.now, days);

  return {
    tasks,
    epics: [...epics],
    remaining: genuinelyOpen.length - tasks.length,
    window: { days, from: from.toISOString(), to: to.toISOString() },
  };
}

/**
 * Runs the real classification pipeline ONCE and captures both of the things
 * `setVerdicts` needs from it: the fingerprint every task key in the board's
 * current window would have its verdict keyed under, and the roadmap epic
 * keys `coerceModelVerdict` treats as valid attribution.
 *
 * **A single call, not two — fix round 1 on task 3-5 caught that it used to
 * be two.** An earlier version ran `runFocusClassification` once inside a
 * since-folded-away `resolveFingerprints` helper for the fingerprint map and
 * once more inside a `loadRoadmapEpicKeys` for the epic set — paying for capex
 * inheritance, the ancestor walk, the rule pass and a ClickHouse read TWICE
 * for one `set_focus_verdicts` call. That helper's own `classifierFor` already
 * received the epics and discarded them (`() => (batch) => …`, ignoring the
 * factory's own argument); this is that same run, with nothing thrown away.
 *
 * **Task 3-10 folded `resolveFingerprints` into `setVerdicts` rather than
 * reinstating it as a caller of this function.** By the time the write tool
 * was registered, `resolveFingerprints` had zero production callers:
 * `setVerdicts` already did the equivalent per-key lookup inline against this
 * function's own result, for both the fingerprint AND the epic set in one
 * run. A standalone `resolveFingerprints(deps, boardId, taskKeys)` returns
 * only fingerprints, so making `setVerdicts` call it would have forced a
 * SECOND, separate call to this function for the epic set — recreating the
 * exact double-run bug this paragraph describes, one caller later. See
 * `setVerdicts`'s own header for where that lookup — and the security
 * guarantee it carries — now lives.
 *
 * Drives the same capturing, no-op classifier `listResidue` does, for the same
 * reason: this must run the real pipeline rather than a shortcut, because both
 * the fingerprint map and the epic set have to be the SAME ones a real advisor
 * run would have produced — not a lookalike computed a different way.
 * `fingerprintByTaskKey` is built early in `classifyTasks`, over every task in
 * the window, before any tier runs, so capturing it costs nothing extra;
 * `classifierFor` hands this the epics before it ever calls the returned
 * function. The no-op classifier and the placeholder `run` value are exactly
 * as inert here as `listResidue`'s comment explains — nothing is persisted by
 * this call. It must never be confused with `setVerdicts`' own write, which
 * writes a real `prompt_version` — always `null`, never this placeholder
 * string. See `verdictWriteRow`'s header.
 *
 * Returns null when the board has no issue source, exactly as
 * `runFocusClassification` does.
 */
async function captureFingerprintsAndEpics(
  deps: FocusDataDeps,
  boardId: string,
): Promise<{
  fingerprintByTaskKey: ReadonlyMap<string, string>;
  epics: readonly FocusPromptEpic[];
} | null> {
  let epics: readonly FocusPromptEpic[] = [];
  let fingerprintByTaskKey: ReadonlyMap<string, string> = new Map();

  const result = await runFocusClassification(deps, boardId, {}, {
    classifierFor: (roadmapEpics) => {
      epics = roadmapEpics;
      return (batch) => {
        void batch;
        return Promise.resolve([]);
      };
    },
    onResolved: ({ fingerprintByTaskKey: byFingerprint }) => {
      fingerprintByTaskKey = byFingerprint;
    },
    run: { model: 'local-agent-bridge', promptVersion: 'n/a' },
  });

  if (!result) return null;
  return { fingerprintByTaskKey, epics };
}

/**
 * Reason text for a task key `set_focus_verdicts` received that resolved to
 * no fingerprint at all. This is structural rather than a lookup that could
 * be retried — see `setVerdicts`'s own header for why the per-verdict
 * fingerprint lookup is the tool's scope guarantee: the key is not one of the
 * board's current window, so there is nothing to write a verdict under.
 * Named as its own constant, distinct from `REJECTED_HUMAN_VERDICT_REASON`,
 * precisely because the two are different situations for the agent — one
 * says "you sent a key I don't have", the other "a person already decided
 * this" — and collapsing them into one opaque string would erase that
 * difference.
 */
const REJECTED_UNKNOWN_TASK_KEY_REASON =
  "unknown task key: not in the board's current window";

/**
 * Reason text for a fingerprint whose stored verdict already has source
 * HUMAN — the write this function refuses, per its own header. Kept
 * separate from `REJECTED_UNKNOWN_TASK_KEY_REASON` for the same reason: an
 * agent that reads this back knows a retry can never succeed for this key,
 * unlike the unknown-key case which may simply mean it asked too early or
 * too late relative to the board's window.
 */
const REJECTED_HUMAN_VERDICT_REASON =
  'a human has already decided this task; the stored verdict was not changed';

/**
 * The columns one `set_focus_verdicts` write sets, identical on create and
 * update — the same shape `setHumanVerdict` in `focus-verdict.service.ts`
 * establishes for a HUMAN write, adapted for a MODEL one.
 *
 * `promptVersion` is always `null`, never `FOCUS_PROMPT_VERSION` or any other
 * string. This is the one place that matters most in this file: the agent
 * never calls `buildFocusPrompt`, so writing a version here would assert a
 * prompt lineage that does not exist. Contrast `focus-data.service.ts`'s
 * `verdictRow`, which stamps a real one for a real prompt run — that function
 * is NOT reused here for exactly this reason, since its `FocusModelRun.
 * promptVersion` is a required `string` and cannot express this call's null.
 *
 * `model` is a parameter, not a literal — this same write path is registered
 * on both the MCP surface (a local agent is the author) and the
 * conversational advisor surface a later task wires up (a configured
 * server-side provider is the author), so the label has to come from the
 * caller rather than being asserted here.
 */
function verdictWriteRow(verdict: FocusModelVerdict, callerId: string, model: string, decidedAt: Date) {
  return {
    class: verdict.class,
    epicKey: verdict.epicKey,
    reason: verdict.reason.slice(0, FOCUS_VERDICT_REASON_MAX),
    source: 'MODEL' as const,
    ruleId: null,
    model,
    promptVersion: null,
    decidedBy: callerId,
    decidedAt,
  };
}

/**
 * Writes an agent's own classification for `boardId`'s tasks — the write half
 * of the two MCP tools this file backs. See this file's header for why this is
 * the first directly-writing `mutates: true` tool in the repo.
 *
 * Each entry is a `FocusModelVerdict` — validated upstream against
 * `FocusModelVerdictSchema` by the tool layer, the same schema
 * `classification.service.ts:432` applies to raw model output, so the agent's
 * output is checked exactly the way a real model's would be. It then passes
 * through `coerceModelVerdict(parsed, roadmapEpics)` — that same line's call —
 * so an invented epic key is nulled rather than stored, identically to the
 * button. `fingerprintByTaskKey` and `roadmapEpics` both come from ONE call to
 * `captureFingerprintsAndEpics` — see that function's header for why a second,
 * separate pipeline run for the epic set was fixed here rather than left in.
 *
 * **The per-verdict fingerprint lookup below (`captured.fingerprintByTaskKey.
 * get(verdict.id)`) IS the tool's scope guarantee, not a validation rule
 * sitting in front of one.** The agent supplies `FocusModelVerdict.id` — the
 * task key a person reads on the board — and never a fingerprint; it cannot,
 * because it never saw one. The only fingerprints that exist to resolve TO are
 * the ones `captureFingerprintsAndEpics` computed for the board's CURRENT
 * window, so a key that is not one of those keys has, structurally, no
 * fingerprint to write a verdict under. There is no fallback that derives one
 * another way, which is what makes "absent from the window" the same thing as
 * "cannot be written" rather than a check that could later be loosened. The
 * lookup is a plain `Map#get` and nothing more — no trim, no case fold, no
 * fuzzy match added on top of it — so `proj-1016` or `"PROJ-1016 "` misses
 * exactly as a wholly foreign key would, and a future edit that adds
 * normalisation "for friendliness" would silently reopen the hazard this
 * guarantee exists to close off: a close-but-wrong key retargeting the task it
 * merely resembles.
 *
 * **This lookup used to be a separate exported function, `resolveFingerprints`,
 * and task 3-10 folded it back in here.** By the time the write tool was
 * registered, `resolveFingerprints` had zero production callers — this
 * function already needed both the fingerprint AND the epic half of ONE
 * `captureFingerprintsAndEpics` run, and a standalone `resolveFingerprints`
 * returning only fingerprints would have forced a second, separate call for
 * the epics, recreating the exact double-run bug `captureFingerprintsAndEpics`'s
 * own header describes. So the guarantee lives inline here now, rather than
 * behind a name nothing calls.
 *
 * **Refuses to overwrite a HUMAN verdict (task 3-6).** `resolveVerdict`'s
 * precedence (`packages/shared/src/focus/resolve-verdict.ts`) already makes a
 * `HUMAN` row outrank a `MODEL` one at READ time, so a person's decision is
 * already what the board displays even without this check. This is a second,
 * independent guarantee at the WRITE boundary instead: a stored `HUMAN` row
 * must never even be touched, so that a later change to that precedence
 * cannot quietly make agent output overwrite a person's judgement. It does
 * NOT duplicate or weaken `resolveVerdict` — that function's precedence is
 * untouched — it just proves the same rule a second way, at the point where a
 * silent overwrite would otherwise be possible.
 *
 * **Per-row rejection is data, not a throw (task 3-7).** A verdict this call
 * cannot write — a task key absent from the board's current window, or a
 * fingerprint whose stored verdict already has source HUMAN — is reported in
 * the returned `rejected[]`, named by the task key the agent supplied, with a
 * reason string distinguishing the two: the scope-guarantee paragraph above
 * explains why the first is structural, this function's own header above
 * explains why the second is a deliberate refusal. Follows
 * `propose_board_changes`'s convention (`advisor/tools.ts:186`): a rejection
 * the agent can read, understand, and correct is a normal outcome, not an
 * error condition, so nothing here throws for either cause. A batch where
 * EVERY entry is rejected still resolves — `written: 0` with a populated
 * `rejected` — because nothing about "cannot write any of these" is
 * exceptional; it is exactly as normal as "cannot write one of these".
 *
 * **`written` counts distinct rows actually affected, not upserts
 * attempted.** A prior reviewer found that two verdicts resolving to the
 * same fingerprint — most commonly because the agent sent the same task `id`
 * twice in one batch, but equally possible for two different keys whose
 * title and description happen to be identical — each built their own
 * `upsert` call, so the naive count reported 2 for a single stored row.
 * Below, candidates are collected into a `Map` keyed by fingerprint rather
 * than an array, so a repeat fingerprint OVERWRITES its earlier entry
 * instead of adding a second one — the same "last value wins" a sequential
 * upsert-per-verdict against the same row would have produced, just without
 * ever building the wasted duplicate write. `written` is then `rows.length`
 * over that de-duplicated set, which is honest by construction: one entry
 * per fingerprint that will actually be upserted, one written per row
 * Postgres actually holds afterward. The earlier, overwritten verdict for a
 * repeated key is not separately reported in `rejected` — it is not a
 * refusal, it is superseded within the same call, exactly as a second
 * `set_focus_verdicts` call for the same key later would be.
 */
export async function setVerdicts(
  deps: FocusDataDeps,
  boardId: string,
  verdicts: readonly FocusModelVerdict[],
  callerId: string,
  model: string,
): Promise<SetFocusVerdictsResultDto> {
  // Mirrors `saveVerdicts`' own guard: no organization, nothing to scope the
  // write to, nothing written. No window exists to resolve against here
  // either, so there is no per-row detail to report — this is a whole-call
  // guard, not a per-row rejection.
  if (!deps.organizationId) return { written: 0, rejected: [] };
  const organizationId = deps.organizationId;

  const captured = await captureFingerprintsAndEpics(deps, boardId);
  if (!captured) return { written: 0, rejected: [] };
  const roadmapEpics = new Set(captured.epics.map((e) => e.key));

  const decidedAt = new Date();
  const rejected: RejectedFocusVerdictDto[] = [];

  // Keyed by fingerprint, not pushed into an array — see this function's
  // header for why a repeat fingerprint must overwrite rather than
  // duplicate. Iterating `verdicts` in order means the LAST verdict for a
  // repeated key is the one left standing, matching what a sequential
  // upsert-per-verdict would have persisted.
  const byFingerprint = new Map<string, { id: string; coerced: FocusModelVerdict }>();
  for (const verdict of verdicts) {
    const fingerprint = captured.fingerprintByTaskKey.get(verdict.id);
    // Absent from the board's current window: structurally nothing to write
    // under. See this function's own header for why this is the tool's
    // scope guarantee rather than a check that could later be loosened.
    if (fingerprint === undefined) {
      rejected.push({ id: verdict.id, reason: REJECTED_UNKNOWN_TASK_KEY_REASON });
      continue;
    }
    byFingerprint.set(fingerprint, { id: verdict.id, coerced: coerceModelVerdict(verdict, roadmapEpics) });
  }

  const candidates = [...byFingerprint.entries()].map(([fingerprint, entry]) => ({
    fingerprint,
    ...entry,
  }));

  // The read this task's header describes: a fingerprint already holding a
  // HUMAN verdict is excluded below before any write is built for it. Read
  // rather than assumed from the incoming batch, because the only source of
  // truth for "is this already a human decision" is the stored row itself.
  // Skipped entirely when every key was already unknown — an empty `in`
  // list has nothing to match and is not worth a round trip.
  const existingHuman = candidates.length
    ? await deps.prisma.focusVerdict.findMany({
        where: {
          organizationId,
          fingerprint: { in: candidates.map((c) => c.fingerprint) },
          source: 'HUMAN',
        },
        select: { fingerprint: true },
      })
    : [];
  const humanFingerprints = new Set(existingHuman.map((row) => row.fingerprint));
  const rows = candidates.filter(({ fingerprint, id }) => {
    if (humanFingerprints.has(fingerprint)) {
      rejected.push({ id, reason: REJECTED_HUMAN_VERDICT_REASON });
      return false;
    }
    return true;
  });

  // Batched rather than a sequential upsert per verdict, the same reasoning
  // `saveVerdicts` gives: one round trip for the whole call.
  await deps.prisma.$transaction(
    rows.map(({ fingerprint, coerced }) =>
      deps.prisma.focusVerdict.upsert({
        where: { organizationId_fingerprint: { organizationId, fingerprint } },
        update: verdictWriteRow(coerced, callerId, model, decidedAt),
        create: {
          organizationId,
          fingerprint,
          ...verdictWriteRow(coerced, callerId, model, decidedAt),
        },
      }),
    ),
  );

  return { written: rows.length, rejected };
}
