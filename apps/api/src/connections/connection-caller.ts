import type { OrgRoleValue } from '@deckgauge/shared';
import { requireOrganizationId } from '../organizations/request-organization.js';
import type { ConnectionCaller } from './connection-visibility.js';

/**
 * The caller, as the connection services need to see them.
 *
 * The ONE place `membership.role` becomes "is an organization admin". Keeping it
 * here means a route cannot accidentally reach for `request.isAdmin`, which
 * unions the Keycloak realm role and `users.is_admin` and is not tenant-scoped —
 * honouring it would make one break-glass account an administrator of every
 * organization at once.
 *
 * Throws through `requireOrganizationId` when the request carries no membership,
 * which can only happen if the route forgot its `orgRole` policy. Deliberately a
 * 500 rather than a denial: a plausible-looking 403 would hide the
 * misconfiguration.
 */
export function connectionCaller(request: {
  user?: { id: string } | null;
  membership?: { organizationId: string; role: OrgRoleValue } | null;
  url: string;
}): ConnectionCaller {
  return {
    userId: request.user?.id,
    organizationId: requireOrganizationId(request),
    isOrgAdmin: request.membership?.role === 'ADMIN',
  };
}

/**
 * A caller for paths where the connection is BOARD-owned, not caller-owned.
 *
 * Once a connection is attached to a board, that board owns the setup and every
 * member of the board may use it — including when the underlying connection is
 * personal to somebody else (design §3, §6.6). The board-source health probes are
 * such a path: they test the connection behind an attached source, and filtering
 * them by ownership would make a shared board's health column read differently
 * depending on who is looking at it.
 *
 * So ownership does not filter here — but the TENANT boundary still does, which is
 * the whole reason this returns a caller rather than letting the call site pass a
 * bare organization id. Named rather than inlined as `isOrgAdmin: true` so the
 * intent is greppable and nobody reads it as an escalation.
 */
export function boardOwnedConnectionCaller(organizationId: string): ConnectionCaller {
  return { userId: undefined, organizationId, isOrgAdmin: true };
}
