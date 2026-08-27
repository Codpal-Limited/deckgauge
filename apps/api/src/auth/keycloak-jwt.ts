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

let _client: jwksRsa.JwksClient | null = null;

function getJwksClient(): jwksRsa.JwksClient {
  if (!_client) {
    const uri = process.env.KEYCLOAK_JWKS_URI;
    if (!uri) throw new Error('KEYCLOAK_JWKS_URI env var is required');
    _client = jwksRsa({ jwksUri: uri, cache: true, rateLimit: true });
  }
  return _client;
}

function getSigningKey(client: jwksRsa.JwksClient, kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.getSigningKey(kid, (err, key) => {
      if (err) return reject(err);
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
