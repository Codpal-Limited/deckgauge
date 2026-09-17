import { createHash } from "node:crypto";

/**
 * The symmetric key that seals every provider credential at rest.
 *
 * One key per deployment, held in the environment. Deliberately NOT a KMS or an
 * HSM: this product's first promise is that it runs entirely inside the
 * customer's network, and a hosted key service is the one dependency that would
 * contradict it. The security statement says so in those words, so it does not
 * over-claim.
 */
export const CREDENTIAL_KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY";

/** 32 bytes — AES-256. Expressed as 64 hex characters, which is what
 *  `scripts/init-env.sh`'s `generate 32` directive emits. */
const KEY_BYTES = 32;

export interface CredentialKey {
  /** The raw 32 bytes handed to AES-256-GCM. */
  readonly bytes: Buffer;
  /**
   * A short, non-secret fingerprint of the key, written into every envelope so a
   * row says which key sealed it. This is what makes rotation possible later
   * without a schema change: a second key can be introduced and rows re-sealed
   * while both remain readable.
   */
  readonly id: string;
}

const HOW_TO_FIX =
  `Generate one with ./scripts/init-env.sh (it writes .env and generates every secret), ` +
  `or check an existing file with ./scripts/init-env.sh --check.`;

/** Derive the non-secret key id. SHA-256 truncated to 8 hex characters: it must
 *  distinguish keys, not resist collision by an adversary who already has them. */
function fingerprint(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * Parse a hex key. Throws rather than returning a fallback — a credential store
 * that quietly falls back to "no encryption" is the defect this module exists to
 * remove.
 */
export function parseCredentialKey(hex: string): CredentialKey {
  // `.env` values pick up quotes and whitespace on their way through shells and
  // compose files; none of that is part of the key.
  const cleaned = hex.trim().replace(/^["']|["']$/g, "");

  if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length !== KEY_BYTES * 2) {
    throw new Error(
      `${CREDENTIAL_KEY_ENV} must be exactly ${KEY_BYTES * 2} hex characters ` +
        `(${KEY_BYTES} bytes); got ${cleaned.length} character(s). ${HOW_TO_FIX}`,
    );
  }

  const bytes = Buffer.from(cleaned, "hex");

  // An all-zero key is what a template placeholder or a truncated secret store
  // produces. It "works" — which is exactly why it has to be refused here.
  if (bytes.every((b) => b === 0)) {
    throw new Error(
      `${CREDENTIAL_KEY_ENV} is all zero bytes, which is a placeholder rather than a key. ${HOW_TO_FIX}`,
    );
  }

  return { bytes, id: fingerprint(bytes) };
}

/**
 * Read the key from an environment. Called once, at client construction, so a
 * misconfigured deployment fails at startup with the variable named rather than
 * on the first sync with a decryption error.
 */
export function loadCredentialKey(
  env: Record<string, string | undefined> = process.env,
): CredentialKey {
  const raw = env[CREDENTIAL_KEY_ENV];
  if (raw == null || raw.trim() === "") {
    throw new Error(
      `${CREDENTIAL_KEY_ENV} is not set. Provider credentials are encrypted at rest, ` +
        `so the api and worker cannot start without it. ${HOW_TO_FIX}`,
    );
  }
  return parseCredentialKey(raw);
}
