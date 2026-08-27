import type { FastifyInstance } from 'fastify';
import type { ChStatementExecutor, PrismaClient } from '@deckgauge/db';
import {
  BootstrapOrganizationSchema,
  InviteMemberSchema,
  UpdateMemberRoleSchema,
  UpdateMemberStatusSchema,
  sanitiseEditionNotices,
  type OrganizationDto,
  SwitchOrganizationSchema,
} from '@deckgauge/shared';
import { OrganizationService, OrganizationExistsError } from './organization.service.js';
import {
  MembershipService,
  MemberAlreadyInvitedError,
  MemberNotFoundError,
  PendingMemberError,
  LastAdminError,
} from './membership.service.js';
import { ADMIN, AUTHENTICATED, ORG_ADMIN, PUBLIC, orgRole } from '../auth/policy.js';
import { requireOrganizationId } from './request-organization.js';
import type { FeatureFlag } from '../enterprise-contract.js';

/** Prisma's serialization-failure codes, raised by the Serializable guards. */
function isSerializationFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err.code === 'P2034' || err.code === 'P2028')
  );
}

/**
 * The guarded member writes run at Serializable, so Postgres may legitimately
 * abort one of two concurrent admins. Retry exactly once: a second failure means
 * real contention the caller should see as 409, not an indefinite loop.
 */
async function withSerializationRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isSerializationFailure(err)) throw err;
    return fn();
  }
}

/**
 * `chExec` is threaded from server.ts rather than built here, and the real
 * ClickHouse client is never imported into this module. That is deliberate:
 * `clickhouse.ts` builds its client at import time with a hard-coded fallback of
 * localhost:8123 — the STAGING server — so a route test that registered this
 * plugin would have applied provisioning DDL to real data. Omitted, provisioning
 * is reported as not done and nothing is contacted.
 */
/**
 * Optional edition hook: messages to show this caller in the app chrome.
 *
 * Generic by design — the core never learns what an edition has to say, only that
 * it may have something. Absent in Community, where the response is byte-identical
 * to what it was before this hook existed.
 */
export type EditionNoticesHook = (
  organizationId: string,
  role: 'ADMIN' | 'MEMBER' | 'VIEWER',
) => Promise<unknown>;

export async function organizationRoutes(
  app: FastifyInstance,
  {
    prisma,
    chExec,
    notices,
    entitledFeatures,
  }: {
    prisma: PrismaClient;
    chExec?: ChStatementExecutor;
    notices?: EditionNoticesHook;
    /**
     * Passed in for the same reason as `chExec`: the service must read the
     * entitlement without this file importing the loader, so a route test can state
     * one with no module on disk. Absent means none, which refuses multi-org.
     */
    entitledFeatures?: () => readonly FeatureFlag[];
  },
) {
  const service = new OrganizationService({ prisma, chExec, entitledFeatures });
  // `app.log` so the offboarding revoke's audit line lands in the API log.
  const members = new MembershipService(prisma, app.log);

  /**
   * The one route in the application that must NOT require a membership.
   *
   * Every other route touching a tenant root declares an `orgRole` policy, and
   * giving this one the same treatment would make a fresh install
   * unbootstrappable: a first-run admin has no membership by definition, and
   * this route is what creates one. The bootstrapping deadlock is the reason
   * `orgRole` was never applied here, not an oversight — there is a test that
   * pins it.
   *
   * `ADMIN` is the right gate instead. It reads `request.isAdmin`, which is the
   * union of the organization role and the two instance-level break-glass
   * signals (`users.is_admin`, the Keycloak realm role). On an empty install the
   * organization half is necessarily absent, so what actually authorises this
   * call is a break-glass signal — which is exactly the intent: only an operator
   * of the deployment may create its first tenant.
   */
  app.post('/organizations/bootstrap', { config: { policy: ADMIN } }, async (req, reply) => {
    const parsed = BootstrapOrganizationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      const result = await service.bootstrap(parsed.data, req.user.id);
      const org = result.organization;
      if (!result.analyticsProvisioned) {
        // Deliberately not an error response: the organization exists and is
        // usable, and it has no analytics rows yet. Logged so the operator can
        // re-run provisionAnalytics() once ClickHouse is reachable.
        app.log.warn(
          { organizationId: org.id, reason: result.analyticsError },
          'organization created without ClickHouse row policies',
        );
      }
      return reply.code(201).send({ id: org.id, name: org.name, slug: org.slug });
    } catch (err) {
      if (err instanceof OrganizationExistsError) {
        return reply.code(409).send({ error: 'ORGANIZATION_EXISTS' });
      }
      // §11 precondition 5: a slug collision raises P2002 and would otherwise
      // return a raw 500. Unreachable under the one-org cap (create only fires
      // against an empty table), but this sits in a first-run path and a 500 on
      // the first screen a new operator sees is not worth keeping.
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
        return reply.code(409).send({ error: 'SLUG_TAKEN' });
      }
      throw err;
    }
  });

  /**
   * The caller's own organization. Gated on `orgRole('VIEWER')` rather than
   * `AUTHENTICATED` so a member-less caller gets `NO_ORGANIZATION` (which the web
   * app routes to `/no-organization`) instead of a confusing empty answer — and
   * so a break-glass admin cannot read an organization they do not belong to,
   * since `isAdmin` is not tenant-scoped.
   */
  app.get('/organization', { config: { policy: orgRole('VIEWER') } }, async (req, reply) => {
    const organizationId = requireOrganizationId(req);
    const org = await service.getById(organizationId);
    if (!org) return reply.code(404).send({ error: 'NOT_FOUND' });

    const dto: OrganizationDto = {
      id: org.id,
      name: org.name,
      slug: org.slug,
      // Non-null behind the `orgRole` policy above — same guarantee
      // `requireOrganizationId` relies on.
      role: req.membership!.role,
    };
    return reply.send(dto);
  });

  /**
   * Which door is this caller at? The web layout redirects on this.
   *
   * `NEEDS_BOOTSTRAP` is safe to expose: a deployment with no organization has
   * nothing to protect, and it is the only state in which /welcome is reachable,
   * so the screen cannot be used to create a second organization.
   *
   * Deliberately keyed on `req.membership`, NOT `req.isAdmin`: the latter is
   * instance-level break-glass and not tenant-scoped, so letting it report
   * MEMBER would hand a flag-holder read access to every organization.
   */
  app.get(
    '/organization/bootstrap-state',
    { config: { policy: AUTHENTICATED } },
    async (req, reply) => {
      const membership = req.membership;
      if (membership) {
        const org = await service.getById(membership.organizationId);
        if (org) {
          // Consulted only for a caller who HAS a membership: there is otherwise no
          // tenant to report about, and passing a guessed organization would put one
          // tenant's message on a stranger's screen.
          //
          // The result is sanitised, not trusted, and a throw degrades to "no
          // notices". This endpoint decides which door the whole app renders, so an
          // edition fault must never turn it into a blank page.
          let editionNotices: ReturnType<typeof sanitiseEditionNotices> = [];
          if (notices) {
            try {
              editionNotices = sanitiseEditionNotices(
                // The caller's role before any edition reduction, falling back to
                // the effective one when nothing was reduced. A notice explaining a
                // restriction has to be addressed to whoever can lift it, and the
                // reduction has already made that person look like a VIEWER.
                await notices(
                  membership.organizationId,
                  req.unrestrictedRole ?? membership.role,
                ),
              );
            } catch (err) {
              req.log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'edition notices hook failed — continuing without them',
              );
            }
          }
          return reply.send({
            state: 'MEMBER',
            organization: {
              id: org.id,
              name: org.name,
              slug: org.slug,
              role: membership.role,
            },
            // Omitted when empty rather than sent as [], so the Community payload
            // does not change shape for a feature the free product does not have.
            ...(editionNotices.length > 0 ? { notices: editionNotices } : {}),
          });
        }
      }

      const existing = await service.getFirst();
      if (!existing) return reply.send({ state: 'NEEDS_BOOTSTRAP' });
      return reply.send({ state: 'NO_MEMBERSHIP', organizationName: existing.name });
    },
  );

  /**
   * Public on purpose: /invite is reachable by someone with no account yet, and
   * it must render the REAL organization name rather than the ?org= query
   * parameter — rendering attacker-supplied text there would turn any invite
   * link into a phishing template (spec D4).
   *
   * Name and slug only. This is world-readable on any host that exposes the API.
   */
  /**
   * The organizations the caller may act in, and which one they are in now.
   *
   * `AUTHENTICATED`, not `orgRole(...)`: a person with two memberships needs this
   * list to switch BETWEEN them, so gating it on the organization they currently
   * resolve to would be circular. It reveals only organizations they already
   * hold a membership in.
   */
  app.get('/organization/switchable', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
    const options = await members.listSwitchableFor(
      req.user.id,
      req.membership?.organizationId ?? null,
    );
    return reply.send({ organizations: options });
  });

  /**
   * Records which organization the caller is acting in.
   *
   * This is the ONE endpoint in this codebase that deliberately takes a tenant id
   * from request input, so it is also the one that has to validate it: the service
   * refuses a membership the caller does not hold rather than writing a value
   * `resolveForUser` would later ignore. Both are safe; only refusing is honest,
   * because a switch that silently does nothing is indistinguishable from a bug.
   */
  app.post('/organization/switch', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
    const parsed = SwitchOrganizationSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const ok = await members.setActiveOrganization(req.user.id, parsed.data.organizationId);
    if (!ok) {
      // 404, not 403 — the caller holds no membership there, and per tenancy D7
      // (and slice 6b) an organization out of reach must be indistinguishable
      // from one that does not exist.
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.status(204).send();
  });

  app.get('/organization/public-summary', { config: { policy: PUBLIC } }, async (_req, reply) => {
    const org = await service.getFirst();
    if (!org) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send({ name: org.name, slug: org.slug });
  });

  app.get('/organization/members', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
    return reply.send(await members.listMembers(requireOrganizationId(req)));
  });

  app.post('/organization/members', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
    const parsed = InviteMemberSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const created = await members.invite(
        requireOrganizationId(req),
        parsed.data,
        req.user.id,
      );
      return reply.code(201).send({ id: created.id });
    } catch (err) {
      if (err instanceof MemberAlreadyInvitedError) {
        return reply.code(409).send({ error: 'MEMBER_ALREADY_INVITED' });
      }
      throw err;
    }
  });

  app.patch<{ Params: { membershipId: string } }>(
    '/organization/members/:membershipId',
    { config: { policy: ORG_ADMIN } },
    async (req, reply) => {
      // Both schemas are .strict(), so a body carrying role AND status fails
      // both and lands in the 400 below rather than having either schema strip
      // the other's key and report a partial success.
      const role = UpdateMemberRoleSchema.safeParse(req.body);
      const status = UpdateMemberStatusSchema.safeParse(req.body);
      if (!role.success && !status.success) {
        return reply.code(400).send({ error: 'role or status is required' });
      }
      const organizationId = requireOrganizationId(req);
      try {
        if (role.success) {
          await withSerializationRetry(() =>
            members.updateRole(organizationId, req.params.membershipId, role.data.role),
          );
        } else if (status.success) {
          await withSerializationRetry(() =>
            members.updateStatus(organizationId, req.params.membershipId, status.data.status),
          );
        }
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof MemberNotFoundError) return reply.code(404).send({ error: 'NOT_FOUND' });
        if (err instanceof LastAdminError) return reply.code(409).send({ error: 'LAST_ADMIN' });
        if (err instanceof PendingMemberError) {
          return reply.code(409).send({ error: 'PENDING_MEMBER' });
        }
        if (isSerializationFailure(err)) {
          return reply.code(409).send({ error: 'CONCURRENT_UPDATE' });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { membershipId: string } }>(
    '/organization/members/:membershipId',
    { config: { policy: ORG_ADMIN } },
    async (req, reply) => {
      try {
        await withSerializationRetry(() =>
          members.remove(requireOrganizationId(req), req.params.membershipId),
        );
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof MemberNotFoundError) return reply.code(404).send({ error: 'NOT_FOUND' });
        if (err instanceof LastAdminError) return reply.code(409).send({ error: 'LAST_ADMIN' });
        if (isSerializationFailure(err)) {
          return reply.code(409).send({ error: 'CONCURRENT_UPDATE' });
        }
        throw err;
      }
    },
  );
}
