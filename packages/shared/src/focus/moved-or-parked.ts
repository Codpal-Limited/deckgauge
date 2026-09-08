import type { FocusTransition, FocusWindow } from './attention-days.js';

/**
 * A = roadmap / CAPEX, B = opex / BAU, C = internal technical.
 *
 * UNCLASSIFIED = nothing classified it and no rule matched. It is a member of
 * this union rather than a value beside it, so it has a label, a colour, a
 * ledger filter and a share of the attention charts. R6.4.
 *
 * **The vocabulary is the board's own.** `costClassification` is two-valued:
 * CAPEX means A and OPEX means B. OPEX still only rules roadmap OUT — it cannot
 * separate a defect from internal technical work — so a rule or the model may
 * refine B into C, which asserts strictly more.
 *
 * **"Someone marked this non-roadmap" stays distinguishable from "nobody has
 * looked at this", and `source` is what carries it** — board-OPEX work is B with
 * source `CAPEX`, the residue is UNCLASSIFIED with source `null`, and the
 * provenance widget renders the difference. An earlier fourth class D carried
 * that distinction on `class` instead. It was never storable: `FocusClass` in
 * Prisma has only A, B, C and UNCLASSIFIED, so a hand-set or model-set D could
 * not persist, and `toStoredClass` existed solely to drop it before the upsert.
 * Moving the distinction onto `source` made this union equal to the stored enum
 * and deleted that function.
 *
 * Both `FocusRuleSchema` and `FocusModelVerdictSchema` pin `z.enum(['A','B','C'])`,
 * so this union is wider than what a rule may be saved with or what the model is
 * allowed to answer. UNCLASSIFIED is produced by `resolveVerdict` alone.
 */
export type FocusClassKey = 'A' | 'B' | 'C' | 'UNCLASSIFIED';

export interface FocusMeasuredTask {
  cls: FocusClassKey;
  attentionDays: number;
  /** Real state changes inside the window — migration artifacts excluded. */
  movesInWindow: number;
}

export interface MovedParkedSplit<T> {
  moved: T[];
  parked: T[];
}

export type ByClass = Record<FocusClassKey, number>;

// Deriving `zeroByClass` and `mapByClass` from this one list is what keeps a
// class from being half-added — see the note above `zeroByClass`.
const CLASSES: readonly FocusClassKey[] = ['A', 'B', 'C', 'UNCLASSIFIED'];

/**
 * State changes that actually happened inside the window.
 *
 * `migrationCutoff` exists because a bulk migration writes a burst of changelog
 * entries at the same instants, attributed to whoever ran the import. Counting
 * those as movement makes a task that has sat untouched for a year look active,
 * which would quietly move it from `parked` into `moved` and inflate the
 * headline attention split.
 */
export function countMovesInWindow(
  transitions: FocusTransition[],
  window: FocusWindow,
  migrationCutoff?: Date,
): number {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const cutoff = migrationCutoff?.getTime();

  return transitions.filter((t) => {
    const at = t.at.getTime();
    if (at < from || at >= to) return false;
    if (cutoff !== undefined && at <= cutoff) return false;
    return true;
  }).length;
}

/**
 * Separate work that happened from work that merely sat somewhere.
 *
 * A task in a working state accrues attention days whether or not anyone touched
 * it, so "days in In Progress" alone cannot tell the two apart. A task is PARKED
 * when it holds days but recorded no state change in the window.
 *
 * This is not a rounding detail. On the reference window the parked tasks are
 * 89 days on two of the lead's Restrictions tickets, and including them moves
 * the published 17/31/52 split to 20/37/44 — flattering the roadmap share with
 * days during which nothing happened.
 *
 * A task with neither days nor moves is in neither bucket: it is inert, and
 * counting it as parked would overstate how much is quietly stuck.
 */
export function splitMovedParked<T extends FocusMeasuredTask>(tasks: T[]): MovedParkedSplit<T> {
  const moved: T[] = [];
  const parked: T[] = [];

  for (const t of tasks) {
    if (t.movesInWindow > 0) moved.push(t);
    else if (t.attentionDays > 0) parked.push(t);
  }

  return { moved, parked };
}

/** Attention days per class, summed then rounded ONCE. */
export function attentionDaysByClass(tasks: FocusMeasuredTask[]): ByClass {
  const raw = zeroByClass();
  for (const t of tasks) raw[t.cls] += t.attentionDays;

  return mapByClass(raw, Math.round);
}

/**
 * Percentage of attention per class.
 *
 * Shares come from the UNROUNDED day totals; rounding each class first and then
 * dividing reintroduces the off-by-one that made 133/241/405 read as
 * 134/241/406.
 */
export function attentionSharesByClass(tasks: FocusMeasuredTask[]): ByClass {
  const raw = zeroByClass();
  for (const t of tasks) raw[t.cls] += t.attentionDays;

  const total = CLASSES.reduce((n, c) => n + raw[c], 0);
  if (total === 0) return zeroByClass();

  return mapByClass(raw, (n) => Math.round((n / total) * 100));
}

/**
 * Built from `CLASSES` rather than written out as a literal.
 *
 * Adding D broke both aggregators precisely because they each carried their own
 * `{ A: 0, B: 0, C: 0 }`: the new key was absent, `raw[t.cls] += …` wrote
 * `undefined + n`, and every share came back NaN. Deriving the record from the
 * one list means the next class cannot be half-added.
 */
function zeroByClass(): ByClass {
  return Object.fromEntries(CLASSES.map((c) => [c, 0])) as ByClass;
}

function mapByClass(source: ByClass, f: (n: number) => number): ByClass {
  return Object.fromEntries(CLASSES.map((c) => [c, f(source[c])])) as ByClass;
}
