import type { PrismaClient } from '@deckgauge/db';

/**
 * The shipped vocabulary, used when nothing else answers.
 *
 * States from a REAL board, which is worth knowing before reusing it: it
 * overlaps the demo's five statuses by exactly one, and
 * `packages/db/src/demo/focus-seed.ts` records what that cost —
 * "FOCUS_ATTENTION_SPLIT and FOCUS_SCORECARD counted one status in five and
 * every day spent in review vanished".
 */
export const DEFAULT_WORKING_STATES = [
  'In Progress',
  'Code Review',
  'Pull Request Doing',
  'Send Back to Dev',
] as const;

/** `{}` is the schema default for the legacy column, so this usually returns null. */
function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((v): v is string => typeof v === 'string');
  return strings.length > 0 ? strings : null;
}

/**
 * Which source states count as "being worked", for attention days.
 *
 * A PRIORITY CHAIN, and the order is the whole content of slice 3:
 *
 * 1. **The organization's `IN_PROGRESS` bucket decisions.** An operator who
 *    moved `QA` into In progress in the Time rules drawer has said what they
 *    mean; Focus reads the same answer rather than needing to be told again.
 *    This is what removes the live opportunity for the timesheet and the funnel
 *    to disagree about one fact.
 * 2. **The legacy per-board `FocusConfig.workingStates`.** No editor has ever
 *    written it — `focus-config.routes.ts` only accepts `stageMap` — so for
 *    every real board it is `{}` and never speaks. Its one writer is the demo
 *    seeder, and the demo needs it: `DEFAULT_WORKING_STATES` overlaps the demo's
 *    statuses by one. Retiring the column outright is blocked on the demo
 *    seeding `SourceStatusBucket` rows instead, which is its own change.
 * 3. **`DEFAULT_WORKING_STATES`.**
 *
 * EMPTY is not ABSENT. Buckets configured with none of them `IN_PROGRESS`
 * answers `[]` and stops there — the operator decided that nothing counts as
 * being worked, and both `everEnteredWorkingState` and `attentionDaysInWindow`
 * already read an empty vocabulary as "no answer" rather than "everything
 * counts", which is the right reading for a figure the widget presents as waste.
 * Falling through to a default there would overrule a decision.
 */
export async function loadOrgBucketRows(
  prisma: PrismaClient,
  organizationId: string | null,
): Promise<Array<{ provider: string; status: string; bucket: string }>> {
  // No tenant, no scoped query. An unscoped read would return every
  // organization's decisions: `SourceStatusBucket.sourceId` has no foreign key,
  // so `organizationId` is the only thing scoping that table
  // (TENANCY-PROGRAMME §5a).
  if (organizationId === null) return [];
  return prisma.sourceStatusBucket.findMany({
    where: { organizationId },
    select: { provider: true, status: true, bucket: true },
  });
}

/**
 * Which source states count as "being worked", from rows already loaded.
 *
 * A PRIORITY CHAIN, and the order is the content of slice 3:
 *
 * 1. **The organization's `IN_PROGRESS` bucket decisions.** An operator who
 *    moved `QA` into In progress in the Time rules drawer has said what they
 *    mean; Focus reads the same answer rather than needing to be told again.
 * 2. **The legacy per-board `FocusConfig.workingStates`.** No editor has ever
 *    written it — `focus-config.routes.ts` only accepts `stageMap` — so for
 *    every real board it is `{}` and never speaks. Its one writer is the demo
 *    seeder, and the demo needs it: `DEFAULT_WORKING_STATES` overlaps the demo's
 *    statuses by one.
 * 3. **`DEFAULT_WORKING_STATES`.**
 *
 * EMPTY is not ABSENT. Buckets configured with none of them `IN_PROGRESS`
 * answers `[]` and stops there — the operator decided that nothing counts as
 * being worked, and `everEnteredWorkingState`, `attentionDaysInWindow` and
 * `verifyApprovedIsNotDone` all read an empty vocabulary as "no answer" rather
 * than "everything counts". Falling through to a default would overrule a
 * decision.
 *
 * Takes ROWS rather than fetching, so the stage-map layer can share one read —
 * two consumers of the same decisions, and a second query would be a second
 * chance for them to disagree.
 */
export function workingStatesFrom(
  rows: readonly { status: string; bucket: string }[],
  legacyBoardWorkingStates: unknown,
): readonly string[] {
  const legacy = readStringArray(legacyBoardWorkingStates);
  if (rows.length === 0) return legacy ?? DEFAULT_WORKING_STATES;
  // Deduplicated: decisions are stored per SOURCE, so one status name is many
  // rows. Focus wants the vocabulary, not the row count. Sorted with
  // `localeCompare` so the answer does not depend on row order and a mixed-case
  // vocabulary is not grouped by case.
  return [...new Set(rows.filter((r) => r.bucket === 'IN_PROGRESS').map((r) => r.status))].sort(
    (a, b) => a.localeCompare(b),
  );
}
