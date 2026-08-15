import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { verifyKeycloakJwt } from './keycloak-jwt.js';
import { UserService } from '../users/user.service.js';
import { hasAdminRole, hasAnalyticsRole } from './roles.js';

export interface KeycloakAuthOptions {
  onUserAuthenticated?: (userId: string) => Promise<void>;
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

    app.decorateRequest('isAdmin', false);
    app.decorateRequest('canViewAnalytics', false);

    if (process.env.DECKGAUGE_SINGLE_USER === 'true') {
      app.log.warn(
        'DECKGAUGE_SINGLE_USER=true — every API request is allowed without authentication. ' +
          'Do not use this on an instance anyone else can reach.',
      );
    }

    // Warn, never refuse to boot: an instance with no admin still serves boards
    // correctly, and refusing to start would be a worse failure than this one.
    // This can only see the DATABASE flag — a Keycloak realm role is invisible
    // until someone authenticates — so the copy says exactly that.
    //
    // Isolated in its own try/catch, same reasoning as bootstrapFirstAdmin
    // below: a DB blip on this COUNT query at boot must not crash the whole
    // API — that would be a strictly worse failure than the warning it exists
    // to produce.
    try {
      if ((await userService.countAdmins()) === 0) {
        app.log.warn(
          'No administrator configured in the database. Nobody can manage an org tree ' +
            'they do not already own, view or edit salary fields, manage timesheet status ' +
            'rules, or configure the advisor until one exists. ' +
            'Fix: pnpm --filter @deckgauge/db bootstrap:admin --email <you@example.com> ' +
            '(ignore this if an operator holds the cockpit-admin realm role in Keycloak).',
        );
      }
    } catch (countErr) {
      app.log.warn(
        { err: countErr instanceof Error ? countErr.message : String(countErr) },
        'countAdmins failed at boot — could not determine whether a database administrator exists',
      );
    }

    app.addHook('preHandler', async (request, _reply) => {
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
        const claims = await verifyKeycloakJwt(token);
        request.user = await userService.upsertFromKeycloak({
          keycloakId: claims.sub,
          email: claims.email,
          name: claims.name ?? claims.preferred_username,
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

        request.isAdmin = hasAdminRole(claims) || dbAdmin;
        request.canViewAnalytics = hasAnalyticsRole(claims) || dbAdmin;
        // Best-effort: link any unlinked BoardOwner labels that match this user's email
        await prisma.boardOwner.updateMany({
          where: { userId: null, name: { equals: request.user.email, mode: 'insensitive' } },
          data: { userId: request.user.id },
        });
        if (opts.onUserAuthenticated) {
          try {
            await opts.onUserAuthenticated(request.user.id);
          } catch (hookErr) {
            request.log.warn(
              { err: hookErr instanceof Error ? hookErr.message : String(hookErr) },
              'onUserAuthenticated hook failed — continuing',
            );
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
