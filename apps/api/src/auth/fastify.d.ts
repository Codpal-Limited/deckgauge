import type { User } from '@deckgauge/db';
import type { OrgRoleValue } from '@deckgauge/shared';

export interface RequestMembership {
  organizationId: string;
  role: OrgRoleValue;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
    /**
     * True for an organization ADMIN **or** either instance-level break-glass
     * signal (`users.is_admin`, the Keycloak realm role) — see the auth plugin
     * for why all three are unioned. Because it is not tenant-scoped, it must
     * never be used to answer "is this caller an admin of THIS organization":
     * declare an `orgRole('ADMIN')` policy for that.
     */
    isAdmin: boolean;
    /** Realm-role signal plus the DB bootstrap flag — see the auth plugin for why. */
    canViewAnalytics: boolean;
    /**
     * Null when the caller has no organization yet (a first-run admin heading
     * for bootstrap), or in single-user mode before any organization exists.
     */
    /**
     * Opaque reason code set when an edition module reduced this request's
     * effective role. Null otherwise. The core never interprets it; it only hands
     * it back to the module's restrictDenial hook.
     */
    membershipRestriction: string | null;
    /**
     * The role this caller held BEFORE an edition module reduced it, set only when
     * a reduction actually happened. Null otherwise.
     *
     * **Never use this for authorization.** `membership.role` is the effective role
     * and the only one any gate may read — reading this instead would hand back
     * exactly the access the reduction was imposed to remove. It exists so that a
     * message ABOUT the reduction can be addressed to the right person: a tenant
     * clamped to read-only still needs its real administrator to be offered the way
     * out, and they no longer look like an administrator to anything downstream.
     */
    unrestrictedRole: RequestMembership['role'] | null;
    membership: RequestMembership | null;
    /** Verified Keycloak claims. Used only by the one-time bootstrap check. */
    claims: import('./keycloak-jwt.js').KeycloakTokenClaims | null;
  }
}
