import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { resolveApiReadIdentityUser } from '@deckgauge/db/dist/ch-provisioning.js';
import {
  chScopedReaderFor,
  chUnroledReaderFor,
  type ChScopedReader,
} from './ch-read-scope.js';

/**
 * The ClickHouse identity the API *reads* through, and the factory that scopes
 * each read to one organization.
 *
 * Why a second identity at all: the shared `clickhouse` singleton in
 * `packages/db` is the INGEST identity, and it holds `ingest_all … USING 1` on
 * every object. Permissive row policies OR together, so if that identity ever did
 * activate an organization's role it would still see every tenant. Splitting the
 * identities is what makes the per-query role mean anything (tenancy §11
 * precondition 8).
 *
 * **What that argument does NOT say — and this file used to act as though it did —
 * is that asking the ingest identity for a role is harmless.** It is not.
 * `ch-provisioning.ts` grants organization roles to the READ identity only, and
 * ClickHouse 24.8 refuses a non-granted role with `Code 512 SET_NON_GRANTED_ROLE`
 * (or `Code 511 UNKNOWN_ROLE` when it does not exist) — verified against staging.
 * A permissive policy defeats an ACTIVATED role's predicate; it does not make the
 * activation succeed. The not-split branch below therefore uses
 * `chUnroledReaderFor` and sends no role at all.
 *
 * That was a LIVE outage, not a latent one: `CLICKHOUSE_READ_URL` is empty in both
 * `.env.example` and `docker-compose.yml`, so every fresh install and the whole
 * OSS edition had each `request.chRead` query throwing 511/512 instead of serving
 * data. Staging worked only because its `.env` sets the variable.
 *
 * **There is deliberately no default read identity.** `packages/db`'s
 * `resolveApiReadIdentityUser` says so and provisioning behaves that way:
 * unset means this deployment has not split its read path yet, and reads fall
 * back to the ingest identity exactly as they did before. Inventing a user name
 * here would turn every existing deployment into a hard failure at boot.
 */
export interface ChReadIdentity {
  /**
   * A reader scoped to one organization. Pass the organization resolved from the
   * SESSION — never a value from a body, query string or header.
   */
  readerFor(organizationId: string): ChScopedReader;
  /**
   * True when a separate read login is configured. False means reads run through
   * the ingest identity **with no role activated**, whose permissive policy admits
   * every tenant — correct only while the deployment is single-organization, and
   * exactly `main`'s pre-split behaviour.
   */
  readonly isSplit: boolean;
  /** The read login in use, for diagnostics. `undefined` when not split. */
  readonly user: string | undefined;
}

export interface ChReadIdentityDeps {
  /** The ingest client, used only as the not-split fallback. */
  readonly ingestClient: ClickHouseClient;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: { warn: (msg: string) => void; info: (msg: string) => void };
  /** Test seam: build a client from a URL without reaching the network. */
  readonly makeClient?: (url: string) => ClickHouseClient;
}

/**
 * Resolves the read identity once, at wiring time.
 *
 * Deliberately NOT lazy per request: whether the read path is split is a
 * deployment fact, and discovering it 30 frames into a widget query — or
 * differently on two requests — is worse than discovering it at boot. The
 * per-request part is only which organization's role to activate.
 */
export function buildChReadIdentity(deps: ChReadIdentityDeps): ChReadIdentity {
  const env = deps.env ?? process.env;
  const user = resolveApiReadIdentityUser(env);
  const url = env.CLICKHOUSE_READ_URL?.trim();

  // Both halves are required to be split. A user with no URL cannot be connected
  // to, and a URL with no resolvable user is not an identity we can name in the
  // role grants provisioning writes — so either alone is a misconfiguration, and
  // it is reported rather than half-applied.
  if (!user || !url) {
    if (user || url) {
      deps.log?.warn(
        'ClickHouse read identity is half-configured: ' +
          `${user ? 'CLICKHOUSE_READ_USER is set' : 'CLICKHOUSE_READ_USER is unset'} but ` +
          `${url ? 'CLICKHOUSE_READ_URL is set' : 'CLICKHOUSE_READ_URL is unset'}. ` +
          'Reads will run through the INGEST identity with NO organization role activated, ' +
          'so there is no tenant boundary on the read path at all. Set both, or neither.',
      );
    }
    return {
      isSplit: false,
      user: undefined,
      // `chUnroledReaderFor`, NOT `chScopedReaderFor`. The organization binding and
      // the "no organization id" guard still fire; the role is not requested,
      // because the ingest identity was never granted one and ClickHouse answers
      // `role=` on a non-granted user with Code 512 rather than ignoring it. This
      // is the whole reason the not-split path could not serve a single read on a
      // default install.
      //
      // There is NO tenant boundary on this path — the permissive ingest policy
      // admits every tenant — which is why `isSplit` is surfaced rather than hidden
      // and why the plugin warns on it. Unlike the worker, the API has no second
      // layer to fall back on: its query builders carry no organization_id.
      readerFor: (organizationId: string) =>
        chUnroledReaderFor(deps.ingestClient, organizationId),
    };
  }

  const client = (deps.makeClient ?? ((u: string) => createClient({ url: u })))(url);
  deps.log?.info(`ClickHouse reads scoped through the read identity '${user}'.`);
  return {
    isSplit: true,
    user,
    readerFor: (organizationId: string) => chScopedReaderFor(client, organizationId),
  };
}
