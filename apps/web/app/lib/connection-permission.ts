/**
 * User-facing copy for the connection-mutation refusals a non-admin can still
 * reach.
 *
 * Every connection mutation — create, edit, delete, test, reconnect, and the
 * Azure DevOps production-deploy config — is gated on the organization ADMIN
 * role. The affordances are hidden from members, but a stale tab or a direct
 * link can still land on one, and `Request failed: 403` tells the person
 * nothing they can act on.
 *
 * A 403 has three distinct causes on these routes and only one of them is about
 * the admin role, so the body's error code decides the copy:
 *
 * - `MEMBERSHIP_SUSPENDED` — sent by the auth plugin, before any policy runs.
 * - `NO_ORGANIZATION` — sent by the policy gate when there is no active
 *   membership to read a role from.
 * - anything else (`Forbidden`) — the caller is in the organization but is not
 *   an ADMIN, which is the case this whole screen-gating exists for.
 */

/**
 * Kept for the routes that are still administrator-only — the Azure DevOps
 * production-deploy configuration is the remaining one. Managing a CONNECTION is
 * member-level as of the connection-ownership phase, so this is no longer the copy
 * for that screen.
 */
export const ORG_ADMIN_REQUIRED =
  'You need to be an organization administrator to manage connections.';

/**
 * A VIEWER is the one role that still cannot add a connection, matching
 * orgRole('MEMBER') on the routes. The copy names the role rather than the rank,
 * because "you need to be a member" reads as though they are not in the
 * organization at all — which they are.
 */
export const VIEWER_CANNOT_ADD_CONNECTIONS =
  'Your role is Viewer, so you cannot add or manage connections.';

export const MEMBERSHIP_SUSPENDED_MESSAGE =
  'Your organization membership is suspended. Ask an organization administrator to restore it.';

export const NO_ORGANIZATION_MESSAGE =
  'You are not a member of an organization, so there are no connections to manage.';

/**
 * Maps a refused response to copy that names the missing permission.
 *
 * Returns `null` for every status other than 403 so callers keep their own
 * handling for network, validation and server errors — this function only
 * claims to explain a refusal.
 */
export function forbiddenMessage(status: number, errorCode?: string): string | null {
  if (status !== 403) return null;
  if (errorCode === 'MEMBERSHIP_SUSPENDED') return MEMBERSHIP_SUSPENDED_MESSAGE;
  if (errorCode === 'NO_ORGANIZATION') return NO_ORGANIZATION_MESSAGE;
  return ORG_ADMIN_REQUIRED;
}

/**
 * Shown in place of the paste-a-new-token box on a board's Sources tab.
 *
 * `POST /:provider/instances/:id/refresh-token` is orgRole(ADMIN), so a member
 * could see a broken connection but not fix it. The health badge stays either
 * way — knowing the connection is expired is what tells them whom to ask.
 */
export const ORG_ADMIN_REQUIRED_TO_RECONNECT =
  'This connection needs a new token. Ask an organization administrator to reconnect it.';
