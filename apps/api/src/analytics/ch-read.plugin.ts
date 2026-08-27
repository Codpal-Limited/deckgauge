import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ChReadIdentity } from './ch-read-client.js';
import type { ChScopedReader } from './ch-read-scope.js';

/**
 * Decorates every request with `request.chRead` — a ClickHouse reader already
 * scoped to the caller's organization.
 *
 * This is the read chokepoint tenancy §11 precondition 8 asks for. Handlers that
 * read analytics take `request.chRead` instead of reaching for the `clickhouse`
 * singleton, and there is then exactly one place where "which tenant" is decided:
 * here, from `request.membership`, which the auth plugin resolved from the
 * session.
 *
 * `ChScopedReader` satisfies the narrow `ChQueryClient` shape the read services
 * already accept, so a service needs no internal change to be scoped — only its
 * construction moves from boot (one shared client) to the handler (one reader per
 * request).
 *
 * **Null when the request has no membership.** Not a throwing decorator and not
 * a silent fallback to the ingest identity: a handler that needs analytics for a
 * caller with no organization has nothing to scope to, and the honest answer at
 * that call site is to refuse. Making it `null` forces each handler to say what
 * it does about that case instead of inheriting a decision made here.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Scoped to `request.membership.organizationId`; null when there is none. */
    chRead: ChScopedReader | null;
  }
}

export interface ChReadPluginDeps {
  readonly identity: ChReadIdentity;
  /**
   * Logged once at registration so a deployment that has NOT split its read
   * identity says so in its boot log, rather than looking scoped while every
   * read still crosses tenants through `ingest_all … USING 1`.
   */
  readonly warnIfNotSplit?: boolean;
}

export function buildChReadPlugin(deps: ChReadPluginDeps): FastifyPluginAsync {
  return fp(async (app: FastifyInstance) => {
    if (!app.hasRequestDecorator('chRead')) {
      app.decorateRequest('chRead', null);
    }

    if (deps.warnIfNotSplit !== false && !deps.identity.isSplit) {
      app.log.warn(
        'ClickHouse reads are running through the INGEST identity: no CLICKHOUSE_READ_USER / ' +
          'CLICKHOUSE_READ_URL is configured. The ingest identity holds a permissive ' +
          'ingest_all policy, so per-organization row policies cannot narrow a read. This is ' +
          'correct only while the deployment has exactly one organization — it MUST be split ' +
          'before DECKGAUGE_MULTI_ORG is enabled.',
      );
    }

    // `preHandler`, NOT `onRequest` — and the phase is the whole point, not the
    // registration order.
    //
    // `keycloak-auth.plugin` resolves `request.membership` in a preHandler, and
    // Fastify runs EVERY onRequest hook before ANY preHandler hook. An onRequest
    // hook here therefore ran before membership existed and set `chRead` to null
    // on every request in every deployment, however carefully this plugin was
    // registered after the auth one. Handlers with a `?? clickhouse` fallback
    // then silently read through the cross-tenant ingest identity — the exact
    // thing this chokepoint exists to prevent — and handlers without one refused
    // outright with NO_ORGANIZATION.
    //
    // Being a preHandler registered after the auth AND policy plugins also gets
    // what the original comment wanted: a request that is going to be refused
    // never builds a reader, because the policy plugin's preHandler has already
    // replied.
    app.addHook('preHandler', async (request) => {
      const organizationId = request.membership?.organizationId;
      request.chRead = organizationId ? deps.identity.readerFor(organizationId) : null;
    });
  });
}
