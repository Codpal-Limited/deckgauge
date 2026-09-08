import type { PrismaClient } from '@deckgauge/db';
import type { JqlAllowLists } from './jira-jql-filter.js';

/**
 * Persists this run's resolved JQL key sets so the intelligence path can read
 * them. `resolveJqlAllowLists` computes them for promotion and would otherwise
 * discard them when the run ends.
 *
 * Three cases, matching the resolver's existing semantics exactly:
 *
 *   - source resolved            → rows replaced with the matched keys
 *   - source has no real filter  → rows deleted (no restriction: everything)
 *   - source's filter was REFUSED by Jira (`skipSourceIds`) → rows LEFT ALONE
 *
 * The third is the one that must not be got wrong. Clearing on refusal would
 * silently widen the board back to its whole project — the same failure
 * `jira-jql-filter.ts` refuses to make at promote time, and the failure this
 * whole path exists to prevent. The run is already recorded FAILED with the
 * error surfaced, so a stale restriction standing is both the smaller error and
 * the loud one.
 *
 * `resolvedSourceIds` bounds the write to the board sources this run actually
 * covered; a source on another connection or project key is never touched.
 *
 * WHAT THIS STORES IS A CURRENT SNAPSHOT, and every trend widget applies it to
 * all of history. An issue that has since left the board's filter drops out of
 * past weeks too; one that has just joined appears throughout. That is
 * intentional — the question a board answers is "the work this team owns,
 * tracked over time", and Jira does not expose historical component membership
 * cheaply — but it is a decision, not an accident, so do not "fix" it without
 * revisiting the design doc.
 */
export async function persistJqlAllowLists(
  db: PrismaClient,
  lists: JqlAllowLists,
  resolvedSourceIds: string[],
): Promise<void> {
  for (const sourceId of resolvedSourceIds) {
    if (lists.skipSourceIds.has(sourceId)) continue;

    const keys = lists.allowedKeysBySourceId.get(sourceId);
    const ops = [db.boardJiraSourceKey.deleteMany({ where: { boardJiraSourceId: sourceId } })];
    if (keys && keys.size > 0) {
      ops.push(
        db.boardJiraSourceKey.createMany({
          data: [...keys].map((issueKey) => ({ boardJiraSourceId: sourceId, issueKey })),
          skipDuplicates: true,
        }),
      );
    }
    await db.$transaction(ops);
  }
}
