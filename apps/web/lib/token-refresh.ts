/**
 * Should the Keycloak access token be refreshed before it is used?
 *
 * Pure so `auth.ts`'s jwt callback — which is otherwise untestable, being wired
 * straight into NextAuth — has its one decision under test.
 *
 * It fails SAFE: an expiry that is missing or not a number means refresh. The
 * gate this replaces led with `typeof token.expiresAt === 'number'`, so an
 * absent expiry meant "never refresh" and the token was trusted for the whole
 * 30-day NextAuth session. Refreshing when we cannot tell costs one token
 * request; trusting when we cannot tell costs the caller their session with no
 * error anywhere.
 *
 * @param expiresAt Unix SECONDS, as stored on the NextAuth token. Unknown type
 *   on purpose — it arrives from a decoded JWT, not from our own code.
 * @param nowSeconds Current time in Unix seconds; injected so tests need no clock.
 */
export function needsRefresh(expiresAt: unknown, nowSeconds: number): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return true;
  // 60s of skew, so a token is replaced before it expires mid-flight rather
  // than after a request has already been refused.
  return nowSeconds > expiresAt - 60;
}
