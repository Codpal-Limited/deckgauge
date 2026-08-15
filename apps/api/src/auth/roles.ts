export const ADMIN_ROLE = process.env.COCKPIT_ADMIN_ROLE ?? 'cockpit-admin';
export const ANALYTICS_ROLE = process.env.COCKPIT_ANALYTICS_ROLE ?? 'cockpit-analytics';

type Claims = { realm_access?: { roles?: string[] } };

export function hasAdminRole(claims: Claims, roleName: string = ADMIN_ROLE): boolean {
  return claims.realm_access?.roles?.includes(roleName) ?? false;
}

/**
 * Cross-cutting people-analytics access. An admin implies analytics so that
 * upgrading instances — where nobody holds the new role yet — do not lose every
 * intelligence and timesheet page on deploy. The reverse does not hold.
 */
export function hasAnalyticsRole(
  claims: Claims,
  roleName: string = ANALYTICS_ROLE,
): boolean {
  return (claims.realm_access?.roles?.includes(roleName) ?? false) || hasAdminRole(claims);
}
