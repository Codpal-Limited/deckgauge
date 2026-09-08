/**
 * Did the API refuse the credential we sent, as opposed to answering "no" or
 * failing?
 *
 * One rule, shared by every place that has to tell a dead session apart from
 * ordinary emptiness, so the two cannot drift apart — which is the whole defect
 * this exists to prevent.
 *
 * 401 ONLY.
 *  - 403 was accepted and answered no. On this app that is a suspended
 *    membership (`MEMBERSHIP_SUSPENDED`), which `OrgGate` already renders its own
 *    screen for; bouncing that caller through Keycloak would loop to no effect.
 *  - 503 is what the API deliberately answers when Keycloak itself is
 *    unreachable (see `keycloak-auth.plugin.ts`), so treating 5xx as a
 *    credential problem would tell every signed-in user they were signed out —
 *    the exact defect the 2026-09-06 `fix/jwks-unavailable` branch removed.
 */
export function isCredentialRefused(status: number): boolean {
  return status === 401;
}
