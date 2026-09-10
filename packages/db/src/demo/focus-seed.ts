/**
 * The Team Focus substrate the demo needs, as pure functions.
 *
 * Separate from `write-postgres.ts` because these are decisions with reasons
 * worth testing on their own — which statuses count as "being worked", and
 * which of them the shipped stage map cannot place. The writer just persists
 * what they return.
 */
import { matchRules, DEFAULT_RULES } from '@deckgauge/shared';
// By its own subpath, never the barrel: this module imports node:crypto and
// `server-only-boundary.test.ts` fails the build if it reaches the barrel's
// import graph, because apps/web pulls the barrel into client components.
import { taskFingerprint } from '@deckgauge/shared/focus/fingerprint.js';
import { STATUS_FLOW } from './generate.js';

/**
 * Which demo statuses count as "being worked", for attention days.
 *
 * DERIVED from `STATUS_FLOW` rather than written out, and that is the point.
 * `DEFAULT_WORKING_STATES` in `apps/api/src/focus/focus-data.service.ts` is
 * `In Progress`, `Code Review`, `Pull Request Doing`, `Send Back to Dev` —
 * states from a real board that is not this one. Against the demo's
 * Backlog/Selected/In Progress/In Review/Done only `In Progress` overlapped, so
 * FOCUS_ATTENTION_SPLIT and FOCUS_SCORECARD counted one status in five and
 * every day spent in review vanished.
 *
 * A literal would fix that once. Deriving it means renaming a status in
 * `STATUS_FLOW` cannot re-break it silently.
 */
export function demoWorkingStates(): string[] {
  return STATUS_FLOW.filter((s) => s.category === 'In Progress').map((s) => s.status);
}

/**
 * The demo's delivery-stage override — PARTIAL, and it must stay that way.
 *
 * `DEFAULT_STAGE_MAP.jira` (`@deckgauge/shared`, `focus/delivery-stage.ts`)
 * places `Done` (IN_PRODUCTION) and `In Progress` (IN_DEVELOPMENT). It has no
 * entry for `Backlog`, `Selected` or `In Review`, so three of the demo's five
 * statuses surfaced through `unmappedStates` as a caveat instead of a stage.
 *
 * Only those three appear here. `mergeStageMap` spreads an override OVER the
 * defaults, and `stage-map-config.ts` records what happens when an override is
 * treated as total instead: it replaced every default, and `Done` and
 * `In Progress` fell through to NOT_STARTED — indistinguishable from the
 * unmapped-state problem the override exists to fix. Restating them here would
 * be that mistake written down.
 *
 * `In Review` is WAITING_TO_SHIP rather than IN_DEVELOPMENT deliberately: it is
 * the last state before `Done` in `STATUS_FLOW`, so the work is built and
 * waiting on a person. That is the boundary `FocusConfig.stageMap` exists to
 * let a board argue with, and the demo takes a position rather than leaving it
 * unmapped.
 */
export const DEMO_STAGE_MAP_OVERRIDE: { jira: Record<string, string> } = {
  jira: {
    Backlog: 'NOT_STARTED',
    Selected: 'NOT_STARTED',
    'In Review': 'WAITING_TO_SHIP',
  },
};

/** One seeded verdict, keyed by content the way `focus_verdicts` is. */
export interface DemoFocusVerdict {
  fingerprint: string;
  class: 'B' | 'C';
  reason: string;
  ruleId: null;
}

export interface ResidueInput {
  /** The generated `jira_issues` rows, which are what the runtime reads. */
  issues: readonly {
    key: string;
    summary: string;
    description: string;
    issue_type: string;
    epic_key: string | null;
  }[];
  /** `Project.costClassification` by issue key — the CAPEX tier's input. */
  capexByKey: ReadonlyMap<string, 'CAPEX' | 'OPEX'>;
  /** The board's curated roadmap epics, as the epic-link rule understands them. */
  roadmapEpicKeys: ReadonlySet<string>;
}

/**
 * Verdicts for the tasks NOTHING ELSE CAN REACH — and only those.
 *
 * `classifyTasks` applies `human > capex > rule > model`. The demo already
 * satisfies the CAPEX tier for ~94% of its tasks, because the seeder writes
 * `Project.costClassification` (Bug -> OPEX, else CAPEX, null on every 17th) and
 * `loadCapex` is `() => board.capex`. Writing a verdict over one of those would
 * replace a real provenance — `source: 'CAPEX'`, "Marked CAPEX on the board
 * row" — with a fabricated one, making FOCUS_PROVENANCE a worse demonstration
 * rather than a better one.
 *
 * What is left is the residue: `costClassification` null, no rule hit. With no
 * advisor provider it reaches the model tier and comes back UNCLASSIFIED, which
 * renders `FocusClassifyNotice` — an advisor run a demo visitor holds only
 * VIEWER for, and an OSS install may have no provider for at all.
 *
 * The residue is selected with the REAL rule engine (`matchRules`,
 * `DEFAULT_RULES`) rather than a reimplementation of it, so this set cannot
 * drift from what the runtime computes: it IS what the runtime computes.
 *
 * `source` is HUMAN at the call site, not here — see `write-postgres.ts` for
 * why that is the only honest tier.
 *
 * ## A fingerprint an already-decided task carries is NEVER seeded
 *
 * Selecting the residue per TASK is not enough, because `focus_verdicts` is
 * keyed by CONTENT and a HUMAN verdict is consulted ABOVE the CAPEX tier
 * (`classification.service.ts`: "A HUMAN verdict is final and is consulted
 * before anything else"). So one verdict reaches every task whose normalised
 * title and description match — and `normaliseTitle` strips issue keys.
 *
 * Measured on the dataset before the generator wrote per-item descriptions:
 * 240 issues shared **26** fingerprints, the 10 residue tasks collapsed to 8 of
 * them, and those 8 were also carried by **65 already-CAPEX tasks**. Seeding
 * them would have turned 65 `class: 'A', source: 'CAPEX'` verdicts into
 * `class: 'B'|'C', source: 'HUMAN'` — the exact fabricated provenance this
 * whole function exists to avoid, at 28% of the board.
 *
 * The generator now gives every issue its own fingerprint, so today this
 * excludes nothing (`focus-seed.test.ts` asserts both halves: every issue
 * distinct, and no residue task left uncovered). It stays because the
 * invariant must be structural rather than a property of the current title
 * format: if the two ever collapse again, the demo loses a couple of
 * classifications and the test says so, instead of silently rewriting the
 * provenance of a quarter of the dataset.
 *
 * ## What that guard does NOT cover: the ANCESTOR path
 *
 * The section above is structural for FINGERPRINT collisions, and for nothing
 * else. The runtime has a SECOND way to decide a task and this selector does
 * not model it: `classifiedAncestorFor`
 * (`apps/api/src/focus/classification.service.ts`) walks `epicKey` and then the
 * `parentOf` chain and decides a task from its NEAREST CLASSIFIED ANCESTOR,
 * CAPEX or OPEX. The `input.capexByKey.has(issue.key)` test below asks only
 * about the task's OWN key, so a residue candidate that INHERITS a
 * classification is invisible here — and the HUMAN verdict this function would
 * emit for it is consulted above every other tier, so it would pre-empt that
 * inheritance exactly as a colliding fingerprint would.
 *
 * It is unreachable on today's data, and only because of a property of the
 * GENERATOR rather than anything in this file. `classificationFor` returns OPEX
 * only for `jiraType === 'Bug'` and `epicOr` never turns a Bug into an Epic, so
 * a demo epic is CAPEX or null and NEVER OPEX; `roadmapEpicKeys` is exactly the
 * CAPEX epics; therefore "has a classified epic ancestor" and "hits the
 * epic-link rule" are the SAME SET here, and the `ruleHit` below already
 * excludes them. The chain's other hop cannot fire either: every generated
 * issue writes `parent_key: null`, so the walk is one epic link deep.
 *
 * `apps/api/src/focus/demo-focus-residue.test.ts` cannot catch a regression
 * here, which is why this is written down rather than left to the suite. A
 * verdict that pre-empts an inheritable-CAPEX task still leaves no
 * UNCLASSIFIED task and still leaves `provenance.HUMAN` equal to the number
 * seeded, so both of its assertions stay green while the provenance is wrong.
 *
 * So anyone who changes `classificationFor` (an OPEX epic, or an unclassified
 * epic some other classified row can be reached through), gives demo issues a
 * real `parent_key`, or changes how `roadmapEpicKeys` is derived MUST revisit
 * this selector. It is deliberately NOT fixed in code: an ancestor-aware
 * predicate could not be exercised by any data the generator produces, and
 * untestable code closing an unreachable hole is worse than a note saying
 * precisely where the hole is.
 */
export function focusResidueVerdicts(input: ResidueInput): DemoFocusVerdict[] {
  // Pass one: split the population, and remember what the DECIDED half's
  // content hashes to. Both values, in this order, exactly as
  // classification.service.ts computes them from the columns unions.ts projects
  // (`summary AS title`, `description AS description`). A mismatch here
  // attaches every verdict to nothing and every row-counting test still passes.
  const decided = new Set<string>();
  const residue: { fingerprint: string; issueType: string }[] = [];

  for (const issue of input.issues) {
    const fingerprint = taskFingerprint(issue.summary, issue.description);

    const ruleHit = matchRules(
      { title: issue.summary, description: issue.description, epicKey: issue.epic_key },
      DEFAULT_RULES,
      input.roadmapEpicKeys,
    );

    if (input.capexByKey.has(issue.key) || ruleHit) {
      decided.add(fingerprint);
      continue;
    }

    residue.push({ fingerprint, issueType: issue.issue_type });
  }

  // Pass two: one verdict per fingerprint — `focus_verdicts` is unique on
  // (organizationId, fingerprint), so a repeat would collide on insert — and
  // none for a fingerprint some decided task also carries (see the header).
  const out: DemoFocusVerdict[] = [];
  const seen = new Set<string>();

  for (const { fingerprint, issueType } of residue) {
    if (decided.has(fingerprint) || seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    // Not A. An unclassified, unlinked, non-CAPEX task is not roadmap work, and
    // promoting it would inflate the most flattering number on the page.
    const isDefect = issueType === 'Bug';
    out.push({
      fingerprint,
      class: isDefect ? 'B' : 'C',
      reason: isDefect
        ? 'Defect work, classified by hand for the demo dataset.'
        : 'Internal technical work, classified by hand for the demo dataset.',
      ruleId: null,
    });
  }

  return out;
}
