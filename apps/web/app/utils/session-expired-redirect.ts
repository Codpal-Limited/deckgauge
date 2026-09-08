/**
 * Where a server render sends a caller whose credential the API refused.
 *
 * One constant so the page that redirects and the login page that explains why
 * cannot drift — the `reason` is the only thing separating "your session ended"
 * from an unexplained bounce to a sign-in screen.
 */
export const SESSION_EXPIRED_REASON = 'session-expired';

export const SESSION_EXPIRED_REDIRECT = `/login?reason=${SESSION_EXPIRED_REASON}`;
