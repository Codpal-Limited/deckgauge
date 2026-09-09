import { z } from 'zod';

/**
 * `focus_verdicts.reason` is `VARCHAR(400)`. Named rather than written as a
 * literal in the schema, because the two must agree and only one of them is
 * checked by the database.
 */
export const FOCUS_VERDICT_REASON_MAX = 400;

/**
 * A person setting the class on one task, from the ledger.
 *
 * `UNCLASSIFIED` is a legitimate choice, not a way of clearing the override —
 * it means "somebody looked at this and it genuinely cannot be classified",
 * which is a different statement from "nobody has looked". Clearing is DELETE.
 *
 * The reason is optional because a one-click correction must not require a
 * sentence; the service fills in who set it and when. It may not be blank,
 * though: an empty string is not "no reason", it is a reason column containing
 * nothing, and the ledger prints that column so a call can be challenged.
 */
export const FocusVerdictOverrideSchema = z.object({
  class: z.enum(['A', 'B', 'C', 'UNCLASSIFIED']),
  reason: z.string().trim().min(1).max(FOCUS_VERDICT_REASON_MAX).optional(),
});

export type FocusVerdictOverride = z.infer<typeof FocusVerdictOverrideSchema>;
