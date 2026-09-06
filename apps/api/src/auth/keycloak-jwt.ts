import jwksRsa from 'jwks-rsa';
import jwt from 'jsonwebtoken';

export interface KeycloakTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  exp: number;
  realm_access?: { roles?: string[] };
}

/**
 * The key set could not be REACHED — this says nothing about the token.
 *
 * Callers must not treat it as a failed verification. `keycloak-auth.plugin`
 * answers 503 for it, where a token failure leaves the request unauthenticated
 * and lets the policy layer decide.
 */
export class IdentityProviderUnavailableError extends Error {
  override readonly name = 'IdentityProviderUnavailableError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Whether a signing-key lookup failed because the KEY SET could not be reached,
 * as opposed to because the token is not valid.
 *
 * `isEndpointUnavailable` is the discriminator, not the error class, because
 * jwks-rsa does not give every reachability failure a class. `getKeys()` does
 * `const error = errorMsg ? new JwksError(errorMsg) : err` — an HTTP non-2xx
 * becomes a `JwksError`, but a SOCKET failure (ECONNREFUSED, ENOTFOUND, a
 * timeout's ECONNRESET) is re-thrown untouched with `name === 'Error'`. Matching
 * on class names therefore misses Keycloak actually being down, which is the
 * literal case this function exists for. The flag is set on BOTH paths
 * (`JwksClient.js`), and is what jwks-rsa's own stale-cache fallback keys on.
 *
 * The `JwksError` arm catches the one reachability failure with no flag:
 * `getSigningKeys()` throws it after a successful fetch that contained no keys.
 *
 * Two failures are deliberately NOT here:
 *
 * - `SigningKeyNotFoundError` — an unknown `kid`. Produced by a forged token and
 *   equally by a genuinely stale one, which is what the incident on 2026-09-06
 *   actually was. It must stay a token failure so the web client's silent-refresh
 *   and re-login path still runs; `useAuthFetch` short-circuits on any non-401,
 *   so answering 503 here would remove the recovery from the very case that needs
 *   it.
 * - `JwksRateLimitError` — a LOCAL counter in this process. It says nothing about
 *   Keycloak's health, and its `kid` argument is attacker-controlled, so mapping
 *   it to "the identity provider is unavailable" would let anyone make the API
 *   report itself down by replaying tokens with unknown kids.
 */
function isKeySetUnreachable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; isEndpointUnavailable?: unknown };
  return e.isEndpointUnavailable === true || e.name === 'JwksError';
}

/**
 * Serve the last known good key for a while after the key set goes away.
 *
 * This is the actual protection against "Keycloak blinked and every signed-in
 * user was told they were signed out": jwks-rsa keeps the previous key and, on
 * an `isEndpointUnavailable` failure, serves it for up to
 * `cacheMaxAge + cacheMaxAgeFallback`. Verification keeps working through a
 * KEYCLOAK restart or a brief outage instead of failing at all, which beats any
 * choice about which status code to return when it fails.
 *
 * It is NOT cold-start protection for THIS process: the stale store lives in
 * memory alongside the client, so an API restart begins with nothing to fall
 * back on. Nothing here needs that — a cold cache is one fetch, and the
 * memoization noted below means a burst of parallel requests is still one fetch.
 *
 * `jwksRequestsPerMinute` is deliberately left at the library default. Raising it
 * was measured not to help: `cacheSigningKey` wraps `rateLimitSigningKey`, and
 * lru-memoizer coalesces concurrent loads of the same kid, so a burst of parallel
 * requests for one key produces ONE fetch. The only thing that drains the bucket
 * is a stream of DISTINCT unknown kids — which a higher ceiling merely lets hit
 * Keycloak harder.
 */
const JWKS_STALE_FALLBACK_MS = 10 * 60_000;

let _client: jwksRsa.JwksClient | null = null;

function getJwksClient(): jwksRsa.JwksClient {
  if (!_client) {
    const uri = process.env.KEYCLOAK_JWKS_URI;
    if (!uri) throw new Error('KEYCLOAK_JWKS_URI env var is required');
    _client = jwksRsa({
      jwksUri: uri,
      cache: true,
      rateLimit: true,
      cacheMaxAgeFallback: JWKS_STALE_FALLBACK_MS,
    });
  }
  return _client;
}

function getSigningKey(client: jwksRsa.JwksClient, kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (err, key) => {
      if (err) {
        // Re-raise reachability failures under a type the caller can act on.
        // The original message is carried through so the log still names the
        // real fault (ECONNREFUSED, a 5xx body, "did not contain any keys")
        // rather than replacing it with a generic one.
        if (isKeySetUnreachable(err)) {
          return reject(
            new IdentityProviderUnavailableError(
              `Keycloak key set unreachable: ${err.message}`,
              { cause: err },
            ),
          );
        }
        return reject(err);
      }
      resolve(key!.getPublicKey());
    });
  });
}

export async function verifyKeycloakJwt(token: string): Promise<KeycloakTokenClaims> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new Error('Invalid JWT structure');
  }
  const client = getJwksClient();
  const signingKey = await getSigningKey(client, decoded.header.kid);
  const payload = jwt.verify(token, signingKey, {
    algorithms: ['RS256'],
    issuer: process.env.KEYCLOAK_ISSUER,
  }) as KeycloakTokenClaims;
  return payload;
}
