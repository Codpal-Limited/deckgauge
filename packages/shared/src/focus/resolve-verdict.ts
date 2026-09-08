import type { FocusClassKey } from './moved-or-parked.js';

export type FocusVerdictSourceValue = 'HUMAN' | 'CAPEX' | 'RULE' | 'MODEL';

export interface ClassifierVerdict {
  class: FocusClassKey;
  epicKey: string | null;
  reason: string;
}

export interface RuleVerdict extends ClassifierVerdict {
  ruleId: string;
}

export interface VerdictInputs {
  human?: ClassifierVerdict | null;
  /** `Project.costClassification` for this task, when the board row carries one. */
  capex?: 'CAPEX' | 'OPEX' | null;
  /**
   * The classification on this task's PARENT EPIC, when the epic is on the
   * board and classified.
   *
   * A roadmap lives at epic level: people classify the epic, not the forty
   * tasks under it. Without inheritance a board with every epic marked CAPEX
   * still reported almost everything unclassified — on the board that surfaced
   * this, 27 classified epics covered 482 tasks while only 19 were being
   * matched, because only the epics themselves were.
   */
  epicCapex?: { classification: 'CAPEX' | 'OPEX'; epicKey: string } | null;
  ruleHit?: RuleVerdict | null;
  model?: ClassifierVerdict | null;
}

export interface ResolvedVerdict {
  class: FocusClassKey;
  epicKey: string | null;
  reason: string;
  source: FocusVerdictSourceValue | null;
  ruleId: string | null;
}

/**
 * Apply `human > capex > rule > model` and say which one decided.
 *
 * The order is not arbitrary. A human override is a person taking
 * responsibility for a call. CAPEX is a finance-audited field someone already
 * maintains. A rule is deterministic and cheap. The model is the fallback for
 * everything nothing else could reach.
 *
 * Two subtleties the tests pin down:
 *
 * - **OPEX decides only that it is NOT roadmap — and on that one question it
 *   BEATS the rule and model tiers.** It cannot separate a customer-visible
 *   defect from a refactor, so it defers to them to refine B into C and settles
 *   for B if both decline; but it discards an A verdict from either, because
 *   promoting OPEX work to roadmap contradicts the flag rather than refining it.
 *   That gate lives above the rule branch, not in the OPEX branch, since the
 *   rule branch would otherwise return first. The proof that OPEX still decided
 *   something is `source`, not `class` — see the branch itself.
 * - **CAPEX decides the class but not the epic.** Only a rule or the model knows
 *   which epic a task advances, so the attribution is carried through even when
 *   CAPEX set the class — otherwise the task silently drops out of roadmap
 *   coverage.
 */
export function resolveVerdict(inputs: VerdictInputs): ResolvedVerdict {
  const { human, capex, epicCapex, ruleHit, model } = inputs;

  if (human) {
    return {
      class: human.class,
      epicKey: human.epicKey,
      reason: human.reason,
      source: 'HUMAN',
      ruleId: null,
    };
  }

  if (capex === 'CAPEX') {
    return {
      class: 'A',
      epicKey: ruleHit?.epicKey ?? model?.epicKey ?? null,
      reason: ruleHit?.reason ?? model?.reason ?? 'Marked CAPEX on the board row.',
      source: 'CAPEX',
      ruleId: ruleHit?.ruleId ?? null,
    };
  }

  // Inherited from the parent epic. Ranks BELOW the task's own classification
  // (a task explicitly marked OPEX under a CAPEX epic is a deliberate
  // exception, and must win) and ABOVE a keyword rule, because someone
  // classifying an epic is a decision and a regex is a guess.
  //
  // The reason names the epic, so an inherited call reads as inherited and a
  // wrong epic classification stays contestable rather than looking
  // first-hand.
  if (!capex && epicCapex?.classification === 'CAPEX') {
    return {
      class: 'A',
      epicKey: epicCapex.epicKey,
      reason: `Roadmap: parent epic ${epicCapex.epicKey} is marked CAPEX on the board.`,
      source: 'CAPEX',
      // Carried through for the same reason the own-CAPEX branch above carries
      // it: the board decided the CLASS, but if a rule also matched it is still
      // the thing that would have to be corrected, and dropping its id loses
      // the only trace of which rule fired.
      ruleId: ruleHit?.ruleId ?? null,
    };
  }

  /**
   * OPEX, own or inherited, RULES ROADMAP OUT — and that outranks the rule and
   * model tiers, per R6.5 (`human > costClassification > rule > model`).
   *
   * Computed here rather than at the branch below, because it has to gate the two
   * tiers that would otherwise return first.
   *
   * **The defect this closes, and why it was invisible.** The default
   * `epic-link` rule (`rules.ts:47`) returns class A for any task whose
   * `epicKey` is in `roadmapEpics`. A task marked OPEX on the board, hanging off
   * a CAPEX epic, therefore came back class A / source RULE — reported as
   * roadmap, contradicting the flag someone set deliberately and the invariant
   * this file's own header states. It was unreachable while `roadmapEpics` came
   * from the writer-less `FocusEpic` table, because that set was always empty;
   * deriving it from the board's CAPEX epics (R6.10) is what turned the rule on.
   *
   * What OPEX still defers to is REFINEMENT — B into C asserts strictly more
   * about the same non-roadmap work. Promotion to A asserts the opposite, so an
   * A verdict from a rule or the model is discarded here and the work stays B.
   * A HUMAN override is unaffected: it returned at the top of this function.
   */
  /**
   * "This verdict claims the work IS roadmap."
   *
   * Named rather than written twice as `x.class === 'A'`, because those coincide
   * only while A is the sole roadmap class. `CLASSES` in `moved-or-parked.ts` and
   * `CLASS_KEYS` in `focus-ui.tsx` exist for the same reason: a class must not be
   * half-added.
   */
  const claimsRoadmap = (cls: FocusClassKey): boolean => cls === 'A';

  const ownOpex = capex === 'OPEX';
  const epicOpex = !capex && epicCapex?.classification === 'OPEX' ? epicCapex.epicKey : null;
  const notRoadmap = ownOpex || epicOpex !== null;

  if (ruleHit && !(notRoadmap && claimsRoadmap(ruleHit.class))) {
    return {
      class: ruleHit.class,
      epicKey: ruleHit.epicKey,
      reason: ruleHit.reason,
      source: 'RULE',
      ruleId: ruleHit.ruleId,
    };
  }

  if (model && !(notRoadmap && claimsRoadmap(model.class))) {
    return {
      class: model.class,
      epicKey: model.epicKey,
      reason: model.reason,
      source: 'MODEL',
      ruleId: null,
    };
  }

  // OPEX, last. It is a real classification someone made, so it must not read
  // as "unclassified" — and OPEX is the board's own word for operational / BAU
  // work, so it resolves to B (R6.4). It still only rules roadmap OUT and cannot
  // say whether the work is a customer-visible defect or internal technical (C),
  // which is why it is placed last: a rule or the model knows strictly more and
  // refines B into C. Not because it is weak evidence.
  //
  // **What keeps "someone marked this non-roadmap" distinguishable from "nobody
  // has looked at this" is `source`, not `class`.** This branch returns source
  // `CAPEX`; the UNCLASSIFIED return below has source `null`. The provenance
  // widget renders that difference, and `resolve-verdict.test.ts` asserts the
  // pair. An earlier version carried the distinction on a fourth class D — which
  // `FocusClass` in Prisma cannot store, so no D verdict could ever persist.
  //
  // Own OPEX and an inherited OPEX epic are the same statement about the same
  // work, so they are one branch.
  //
  // `epicKey` is null because this verdict asserts nothing about which epic the
  // work ADVANCES — it only says the work is not roadmap. Note what this does
  // NOT do: `buildFocusSnapshot` falls back to the task's own `epic_key` for
  // display, so the link is still shown. What bounds roadmap-epic coverage is
  // that it iterates the board's CAPEX-marked epics, not this field.
  if (notRoadmap) {
    return {
      class: 'B',
      epicKey: null,
      reason: epicOpex
        ? `Not roadmap: parent epic ${epicOpex} is marked OPEX on the board.`
        : 'Not roadmap: marked OPEX on the board row.',
      source: 'CAPEX',
      // Carried, for the same reason the two CAPEX branches above carry it: the
      // BOARD decided the class, but if a rule also matched it is still the
      // thing that would have to be corrected, and dropping its id loses the
      // only trace of which rule fired.
      //
      // This was `ruleId: null`, on the stated grounds that "the rule branch
      // above already returned, so by here there is provably no rule to credit
      // — the compiler said so". Both halves stopped being true the moment the
      // roadmap gate landed: this branch is now reachable WITH a non-null
      // `ruleHit`, which is the entire point of the gate, and the compiler
      // asserts nothing of the kind. A discarded class-A rule verdict is
      // precisely the case where someone needs to know which rule fired.
      ruleId: ruleHit?.ruleId ?? null,
    };
  }

  return {
    class: 'UNCLASSIFIED',
    epicKey: null,
    reason: 'No classifier produced a verdict for this task.',
    source: null,
    ruleId: null,
  };
}
