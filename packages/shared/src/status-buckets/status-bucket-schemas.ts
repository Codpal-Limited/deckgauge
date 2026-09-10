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

/**
 * One row of the status picker: a status the tree's people have been in, and
 * what it currently means.
 *
 * Lives here rather than being declared in `apps/api` and again in `apps/web`,
 * per CLAUDE.md § Conventions — and because the plan named this exact case:
 * without a shared schema the boundary hand-writes a second list of the five
 * bucket names, "which is the drift `bucketToFocusStage` exists to prevent,
 * reintroduced one layer out". `bucket` reuses `StatusBucketSchema`, so there
 * is still exactly one list.
 *
 * The provider is deliberately absent. The panel shows one row per status NAME;
 * business users do not know which tracker a status came from and should not
 * have to. Provider stays server-side.
 */
export const PooledStatusSchema = z.object({
  /**
   * Trimmed, and for the same reason as `SourceStatusBucketSchema.status`: this
   * schema is BOTH the read shape and — inside
   * `PutOrgTreeStatusBucketsSchema` — the write shape, and the service stores
   * `status` verbatim while the pool looks it up exactly. A padded name would
   * become a row that matches nothing forever. On the read side it is a no-op:
   * the API builds these from the tracker's own strings.
   */
  status: z.string().trim().min(1),
  bucket: StatusBucketSchema,
});

export type PooledStatus = z.infer<typeof PooledStatusSchema>;

/**
 * `PUT /org-trees/:id/timesheet-status-buckets`.
 *
 * One decision per status NAME, and deliberately no provider: business users do
 * not know which tracker a status came from, so the fan-out to the sources that
 * report it is the server's job (`OrgTreeStatusBucketService.resolveSources`).
 * A provider here would push that knowledge back into the UI, which is the one
 * thing the design settled it must never do.
 *
 * `PooledStatusSchema.array()` rather than a fresh object, so the request the
 * panel sends is literally the shape it was given — and so the five bucket
 * names are still written down exactly once, in `STATUS_BUCKETS`.
 *
 * An EMPTY list is valid: it is an explicit "count nothing", the same rule
 * `PutOrgTreeTimesheetConfigSchema` already applies to `activeStatuses`. The
 * key itself is REQUIRED and not defaulted, because a missing key ("you
 * forgot") and an empty list ("count nothing") must not collapse into one.
 *
 * Capped, unlike `activeStatuses`, because each element costs more here: every
 * name goes into a ClickHouse `IN` list and then fans out to one upsert per
 * SOURCE reporting it, so the write is quadratic in a way the older endpoint's
 * plain string array is not. 2000 is far above any real workflow — the largest
 * pool observed is in the low hundreds — and exists to bound the fan-out, not
 * to express a product limit.
 */
export const PutOrgTreeStatusBucketsSchema = z.object({
  decisions: PooledStatusSchema.array().max(2000),
});

export type PutOrgTreeStatusBuckets = z.infer<typeof PutOrgTreeStatusBucketsSchema>;

/**
 * What the save answers with: the statuses that now count as work.
 *
 * DERIVED server-side from the `IN_PROGRESS` bucket, so the client renders the
 * same list the timesheet will read on its next request rather than recomputing
 * it from the decisions a second way. That is the point of returning it at all
 * — one definition of "in progress", which is the constraint the whole feature
 * is built around.
 *
 * A schema rather than a cast on the web side, because a cast is exactly how
 * slice 2b-ii let a stale test go on asserting a shape the API had stopped
 * producing.
 */
export const OrgTreeStatusBucketsResultSchema = z.object({
  activeStatuses: z.string().array(),
});

export type OrgTreeStatusBucketsResult = z.infer<typeof OrgTreeStatusBucketsResultSchema>;
