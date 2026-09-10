import { z } from 'zod/v4';
import { STATUS_BUCKETS } from './status-bucket.js';

/**
 * The five buckets at a request/response boundary.
 *
 * DERIVED from `STATUS_BUCKETS` rather than restated, and a test asserts that
 * by reading this file's source — because a value-level check cannot tell a
 * derived enum from a hand-written one that happens to agree today. A second
 * list of the five names here would be the drift `bucketToFocusStage` exists to
 * prevent, reappearing one layer out at the point where the endpoint decides
 * what it will accept.
 *
 * The spread is what makes `z.enum` happy with a readonly tuple while keeping
 * `STATUS_BUCKETS` the only place the names are written.
 */
export const StatusBucketSchema = z.enum([...STATUS_BUCKETS]);

/**
 * The trackers the timesheet actually reads. `fetchTransitions` unions Jira and
 * ADO only, so `github` is here because the SOURCE model has repos and a bucket
 * row may exist for one — not because GitHub time reaches the grid today. It
 * does not; that is a known gap recorded against the timesheet, not something
 * this schema should imply is solved.
 *
 * A github row is therefore SET explicitly and never SEEDED: `SeedBucketInput`
 * takes `FocusProvider` (jira | ado), so `seedBucket` cannot be handed one, and
 * `DEFAULT_STAGE_MAP` has no github key to look up if anyone routed around the
 * type. TypeScript is the guard, deliberately.
 */
export const StatusBucketProviderSchema = z.enum(['jira', 'ado', 'github']);

/**
 * One stored decision: for this source, this status name means this bucket.
 *
 * `status` is trimmed of surrounding whitespace but otherwise VERBATIM — no
 * case folding, no punctuation collapse. That is load-bearing rather than
 * incidental: `DEFAULT_STAGE_MAP` is keyed in the tracker's own casing and
 * `seedBucket`'s abandonment rule is an exact-key lookup, so normalising here
 * would file `Cancelled` as an ordinary status and let a customer's category
 * overwrite the one fact no category can express. That exact confusion cost a
 * review round on slice 2a, in the opposite direction.
 *
 * Empty and whitespace-only names are refused. A tracker sends a blank when a
 * field is unset, `source-statuses.service.ts` already drops blanks on the read
 * side, and a bucket decision about "" would sit in the table forever matching
 * nothing.
 */
export const SourceStatusBucketSchema = z.object({
  provider: StatusBucketProviderSchema,
  sourceId: z.string().min(1),
  status: z.string().trim().min(1),
  bucket: StatusBucketSchema,
});

export type StatusBucketProvider = z.infer<typeof StatusBucketProviderSchema>;
export type SourceStatusBucket = z.infer<typeof SourceStatusBucketSchema>;
