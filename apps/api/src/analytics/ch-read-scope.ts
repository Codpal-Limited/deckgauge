/**
 * The API's name for the shared ClickHouse read boundary.
 *
 * **The implementation moved to `packages/db/src/ch-read-scope.ts`** so that the
 * API and the worker enforce the tenant boundary with the same code rather than
 * two copies of it. The worker's `chClientFor(organizationId).queryRows` ignored
 * its argument and read through the ingest singleton; giving it a second,
 * worker-local reader would have created exactly the drift this boundary cannot
 * survive — the two implementations diverge, and the divergence is invisible
 * until one tenant reads another's rows.
 *
 * This file stays as the API's import path because ~20 modules name it, and
 * because the deep-import form below is a footgun worth keeping in one place:
 * importing from the `@deckgauge/db` BARREL pulls `clickhouse.ts`, which builds a
 * ClickHouseClient eagerly at module import against a `localhost:8123` fallback —
 * the staging server, and the INGEST identity, which reads every tenant when no
 * role is activated and REFUSES the query (`Code 512 SET_NON_GRANTED_ROLE`) when
 * one is, since provisioning grants organization roles only to the read identity.
 *
 * See `packages/db/src/ch-read-scope.ts` for the design notes: why `role` is a
 * request-level parameter, why a caller-supplied role is refused rather than
 * overwritten, and why a blank organization id throws instead of widening.
 */
export {
  chReadRoleFor,
  chScopedReaderFor,
  chUnroledReaderFor,
  type ChReadClient,
  type ChScopedQueryParams,
  type ChScopedReader,
} from '@deckgauge/db/dist/ch-read-scope.js';
