import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { verifyKeycloakJwt, type KeycloakTokenClaims } from './keycloak-jwt.js';
import { linkBoardOwnersToUser } from './link-board-owners.js';
import { notifyOrgMemberInvited } from '../notifications/triggers/org-member-invited.js';
import { UserService } from '../users/user.service.js';
import { hasAdminRole, hasAnalyticsRole } from './roles.js';
import { MembershipService } from '../organizations/membership.service.js';

export interface KeycloakAuthOptions {
  onUserAuthenticated?: (userId: string) => Promise<void>;
  /**
   * Optional edition hook that may reduce a resolved membership's effective role.
   * Absent in Community, so the free product has no such behaviour at all — see
   * enterprise-contract.ts.
   */
  restrictMembership?: (
    organizationId: string,
    role: 'ADMIN' | 'MEMBER' | 'VIEWER',
  ) => Promise<{ role: 'ADMIN' | 'MEMBER' | 'VIEWER'; reason: string } | null>;
}

// Returns a Fastify plugin factory that closes over the prisma client.
// Register this inside a scoped sub-app so the preHandler only applies
// to protected routes — public routes (e.g. /health) stay outside.
export function buildKeycloakAuthPlugin(
  prisma: PrismaClient,
  opts: KeycloakAuthOptions = {},
): FastifyPluginAsync {
  return fp(async (app: FastifyInstance) => {
    const userService = new UserService(prisma);
    const membershipService = new MembershipService(prisma);

    app.decorateRequest('isAdmin', false);
    app.decorateRequest('canViewAnalytics', false);
    app.decorateRequest('membership', null);
    app.decorateRequest('membershipRestriction', null);
    app.decorateRequest('unrestrictedRole', null);
    app.decorateRequest('claims', null);

    const singleUser = process.env.DECKGAUGE_SINGLE_USER === 'true';
    if (singleUser) {
      app.log.warn(
        'DECKGAUGE_SINGLE_USER=true — every API request is allowed without authentication. ' +
          'Do not use this on an instance anyone else can reach.',
      );
    }

    // Warn, never refuse to boot: an instance with no admin still serves boards
    // correctly, and refusing to start would be a worse failure than this one.
    // This can only see what is in the DATABASE — a Keycloak realm role is
    // invisible until someone authenticates — so the copy says exactly that.
    //
    // Both database-side admin sources are checked, not just `users.is_admin`:
    // an organization ADMIN membership is now equally a database administrator
    // (see the `request.isAdmin` union below), so warning on the flag alone
    // would fire on a correctly-bootstrapped tenant and repeat the false claim
    // 68702187 removed from this very message.
    //
    // Isolated in its own try/catch, same reasoning as bootstrapFirstAdmin
    // below: a DB blip on these queries at boot must not crash the whole
    // API — that would be a strictly worse failure than the warning it exists
    // to produce.
    try {
      const [flaggedAdmins, orgAdmins] = await Promise.all([
        userService.countAdmins(),
        membershipService.countActiveAdmins(),
      ]);
      if (flaggedAdmins === 0 && orgAdmins === 0) {
        app.log.warn(
          'No administrator configured in the database. Nobody can manage an org tree ' +
            'they do not already own, view or edit salary fields, manage timesheet status ' +
            'rules, or configure the advisor until one exists. ' +
            'Fix: bootstrap an organization on first login, or ' +
            'pnpm --filter @deckgauge/db bootstrap:admin --email <you@example.com> ' +
            '(ignore this if an operator holds the cockpit-admin realm role in Keycloak).',
        );
      }
    } catch (countErr) {
      app.log.warn(
        { err: countErr instanceof Error ? countErr.message : String(countErr) },
        'admin count failed at boot — could not determine whether a database administrator exists',
      );
    }

    /**
     * Single-user mode bypasses the policy layer wholesale (`evaluatePolicy`
     * returns ALLOW immediately), but creating any tenant root still needs an
     * `organizationId`. Without this fallback every board/connection/org-tree
     * create would fail on a missing required column — the bypass would take
     * the gate off the door and brick the writes behind it. Safe because the
     * mode is single-tenant by definition: there is at most one organization.
     */
    async function singleUserMembership(): Promise<{
      organizationId: string;
      role: 'ADMIN';
    } | null> {
      const org = await prisma.organization.findFirst({ select: { id: true } });
      return org ? { organizationId: org.id, role: 'ADMIN' } : null;
    }

    app.addHook('preHandler', async (request, reply) => {
      if (singleUser) {
        request.membership = await singleUserMembership();
        request.isAdmin = true;
        return;
      }

      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        // No bearer token: continue with `request.user` unset. This is NOT
        // "allowed through" — it is only this plugin declining to identify the
        // caller. `buildPolicyPlugin`'s preHandler runs next and denies any
        // non-public route with 401 when there is no user. Keeping the two
        // separate is what lets public routes work at all.
        return;
      }
      const token = authHeader.slice(7);
      try {
        const claims: KeycloakTokenClaims = await verifyKeycloakJwt(token);
        request.claims = claims;
        request.user = await userService.upsertFromKeycloak({
          keycloakId: claims.sub,
          email: claims.email,
          name: claims.name ?? claims.preferred_username,
          firstName: claims.given_name,
          lastName: claims.family_name,
        });

        // Fresh-install bootstrap. Runs HERE, not in the onUserAuthenticated
        // seam: that seam is wired only from the enterprise module
        // (server.ts), so it is undefined in Community builds — exactly the
        // edition this bootstrap exists for.
        //
        // Isolated in its own try/catch: `request.user` is already assigned
        // above, so a failure here (e.g. a statement timeout on the raw
        // UPDATE) must never fall into the outer catch below — that one is
        // written for JWT verification failures and would otherwise
        // silently strip a real, claim-based admin of both signals and skip
        // the BoardOwner backfill and onUserAuthenticated hook that follow.
        let justGranted = false;
        try {
          justGranted = await userService.bootstrapFirstAdmin(request.user.id);
        } catch (bootstrapErr) {
          request.log.warn(
            {
              err: bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr),
            },
            'bootstrapFirstAdmin failed — continuing without a bootstrap grant',
          );
        }

        // `request.user` was read before the grant, so OR the return value in
        // rather than re-querying.
        const dbAdmin = request.user.isAdmin || justGranted;

        const resolved = await membershipService.resolveForUser(
          request.user.id,
          request.user.email,
          // Already on the row this plugin just upserted, so the resolver does not
          // re-query it (tenancy §11 precondition 2). It is a PREFERENCE: the
          // resolver ignores it unless it still names a membership they hold.
          request.user.activeOrganizationId,
        );

        // Suspension is decided here, not by a policy: it is an administrative
        // block on the identity itself, so it must hold on every route rather
        // than only the ones that happen to declare an organization policy.
        // "No membership at all" is the opposite case and deliberately does NOT
        // deny — a first-run admin has none by definition, and the bootstrap
        // route is what creates one. The policy layer refuses everything else.
        if (resolved?.status === 'SUSPENDED') {
          return reply.code(403).send({ error: 'MEMBERSHIP_SUSPENDED' });
        }
        if (resolved?.justActivatedMembershipId) {
          // This request is what turned a workspace invite into a membership, so
          // it is the one moment there is somebody to tell. Fires before the
          // edition seam below narrows the role: the notification records what
          // they were invited AS, not what a hosted restriction reduces it to.
          await notifyOrgMemberInvited(prisma, request, {
            membershipId: resolved.justActivatedMembershipId,
          });
        }

        if (resolved?.status === 'ACTIVE') {
          // An edition module may reduce the effective role — the seam by which a
          // hosted deployment can make an organization read-only. Applied BEFORE
          // `isAdmin` is computed below, so a reduced role also drops the
          // membership-derived admin signal by construction, while the two
          // instance-level break-glass signals survive untouched.
          //
          // Isolated in its own try/catch on purpose: an exception here must not
          // fall into the JWT catch below, which would silently strip the
          // membership and make an edition-hook fault look like a bad token.
          let effectiveRole = resolved.role;
          if (opts.restrictMembership) {
            try {
              const restriction = await opts.restrictMembership(
                resolved.organizationId,
                resolved.role,
              );
              if (restriction) {
                effectiveRole = restriction.role;
                request.membershipRestriction = restriction.reason;
                // Kept for MESSAGING only, never for authorization — see the
                // fastify.d.ts note. Without it the reduction erases the very
                // person who can lift it: a clamped ADMIN reads as a VIEWER
                // everywhere downstream, so an edition writing "ask your
                // administrator" would be addressing the administrator.
                request.unrestrictedRole = resolved.role;
              }
            } catch (restrictErr) {
              request.log.warn(
                {
                  err: restrictErr instanceof Error ? restrictErr.message : String(restrictErr),
                  organizationId: resolved.organizationId,
                },
                'restrictMembership hook failed — continuing with the resolved role',
              );
            }
          }
          request.membership = { organizationId: resolved.organizationId, role: effectiveRole };
        }

        // `isAdmin` is the union of three sources, and the union is deliberate.
        //
        // The organization role is the normal path and the only one that is
        // tenant-scoped. The other two — the `users.is_admin` bootstrap flag and
        // the Keycloak realm role — are instance-level break-glass, and they
        // survive for the caller who has no organization membership at all: a
        // first-run admin, before `OrgMembership` has a row for them. For that
        // caller, `evaluatePolicy`'s `orgTree` branch (and its `hasOrgTreeRole`
        // read-path counterpart) still treats them as OWNER-equivalent on every
        // tree, so shipping an empty `OrgTreeAccess` table cannot lock an
        // operator out, and dropping the union here would re-open that lockout
        // and break the recovery path the `bootstrap:admin` CLI and the
        // administration guide both document.
        //
        // Once a membership exists, the org-role ceiling decides instead: an
        // operator with an ADMIN membership still reaches OWNER on every tree
        // in their organization, but an operator whose membership is MEMBER or
        // VIEWER no longer does — they need an explicit `OrgTreeAccess` grant,
        // same as anyone else. The break-glass signals no longer override that
        // once there's a tenant role to consult.
        //
        // What they must never do is manufacture a membership: `request.membership`
        // above comes from `OrgMembership` alone, so a break-glass admin still has
        // no organization to write into until one is bootstrapped. That keeps the
        // tenant boundary a property of the data, not of a role bit.
        //
        // Neither break-glass signal is tenant-scoped, so with several
        // organizations present either would confer admin inside all of them.
        // That is a precondition of `DECKGAUGE_MULTI_ORG=true`, recorded as such,
        // and inert under the enforced single-organization cap.
        request.isAdmin =
          request.membership?.role === 'ADMIN' || dbAdmin || hasAdminRole(claims);

        // `canViewAnalytics` has no organization-role equivalent: cross-cutting
        // people analytics carry no entity id for a row-based check to scope
        // against, so it stays a realm-role signal (plus the same DB bootstrap
        // flag, unchanged from main).
        request.canViewAnalytics = hasAnalyticsRole(claims) || dbAdmin;

        // Best-effort owner-label linking. Swallowed on failure: this is a
        // convenience pass, and a locked row must never fail authentication.
        try {
          await linkBoardOwnersToUser(prisma, {
            userId: request.user.id,
            email: request.user.email,
            name: request.user.name,
            organizationId: request.membership?.organizationId ?? null,
          });
        } catch (linkErr) {
          request.log.warn(
            { err: linkErr instanceof Error ? linkErr.message : String(linkErr) },
            'board owner linking failed — continuing',
          );
        }
        if (opts.onUserAuthenticated) {
          try {
            await opts.onUserAuthenticated(request.user.id);
          } catch (hookErr) {
            request.log.warn(
              { err: hookErr instanceof Error ? hookErr.message : String(hookErr) },
              'onUserAuthenticated hook failed — continuing',
            );
          }
          // The hook is allowed to provision a membership (the DEMO_MODE signup
          // path does exactly that). Re-resolve once so the very request that
          // triggered provisioning carries it; otherwise a newly self-registered
          // user is admitted with membership: null and fails every policy until
          // they reload.
          if (!request.membership) {
            const provisioned = await membershipService.resolveForUser(
              request.user.id,
              request.user.email,
            );
            if (provisioned?.status === 'ACTIVE') {
              request.membership = {
                organizationId: provisioned.organizationId,
                role: provisioned.role,
              };
              // OR, never assign: `request.isAdmin` was already computed from
              // the three-source union above, so a plain assignment here would
              // let a freshly provisioned MEMBER membership *demote* a
              // break-glass admin to false on the one request that provisioned
              // it.
              request.isAdmin = request.isAdmin || provisioned.role === 'ADMIN';
            }
          }
        }
      } catch (err) {
        // Token invalid/expired — continue without req.user. Write routes that
        // require authentication enforce it themselves and reject with 401.
        request.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'JWT verification failed — continuing unauthenticated',
        );
      }
    });
  });
}
