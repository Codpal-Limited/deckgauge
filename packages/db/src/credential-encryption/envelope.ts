import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialKey } from "./key.js";

/**
 * The on-disk form of an encrypted credential.
 *
 *     dgc.v1.<keyId>.<iv_b64>.<tag_b64>.<ciphertext_b64>
 *
 * Stored in the same `TEXT` column the plaintext used to occupy, which is why
 * this change needs no database migration at all.
 *
 * The prefix is the whole plaintext-detection mechanism, so it has to be a shape
 * no provider token can take. Checked against real formats: GitHub (`ghp_`,
 * `github_pat_`), GitLab (`glpat-`), Atlassian (`ATATT`), Azure DevOps (base64),
 * Anthropic (`sk-ant-`). None contains a dot, let alone this one.
 *
 * `v1` is in the prefix rather than only in the key id so that a future format
 * change — a different cipher, a different envelope layout — is distinguishable
 * from a key rotation, which the key id already covers on its own.
 */
export const ENVELOPE_PREFIX = "dgc.v1.";

/** 12 bytes is the GCM-standard nonce length; randomly generated per encryption
 *  and never reused, which is the property GCM's security actually rests on. */
const IV_BYTES = 12;

const ENVELOPE_PARTS = 6;

/**
 * Is this value already sealed?
 *
 * The read path is gated on this, and that is what makes a generic walk safe
 * across the schema's ~20 `Json` columns: a JSON payload that happens to carry a
 * key called `apiKey` holds a value that is not an envelope, so it is left
 * untouched.
 */
export function isEnvelope(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Seal a credential.
 *
 * `field` is bound into the ciphertext as GCM additional authenticated data, so
 * a value moved into a differently-named column fails to decrypt rather than
 * silently working. It is the field NAME, not `model.field`: the read path is a
 * generic recursive walk that knows the key it is looking at but not always the
 * model it belongs to (nested includes), and an AAD the reader cannot reconstruct
 * is an AAD that breaks legitimate reads. The residual gap — three models share
 * the name `accessToken`, so a ciphertext could be moved between them — is
 * recorded in the design doc: exploiting it needs write access to the database,
 * at which point the attacker has strictly better options.
 */
export function encryptCredential(
  plaintext: string,
  field: string,
  key: CredentialKey,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
  cipher.setAAD(Buffer.from(field, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "dgc",
    "v1",
    key.id,
    iv.toString("base64"),
    tag.toString("base64"),
    body.toString("base64"),
  ].join(".");
}

/**
 * Open a sealed credential.
 *
 * Every failure here throws. There is no lenient path that returns the raw
 * envelope or an empty string: a caller that receives one of those sends it to
 * the provider as a bearer token, and the resulting 401 points at the provider
 * rather than at this module.
 */
export function decryptCredential(
  envelope: string,
  field: string,
  key: CredentialKey,
): string {
  const parts = envelope.split(".");
  if (!isEnvelope(envelope) || parts.length !== ENVELOPE_PARTS) {
    throw new Error(
      `Not a ${ENVELOPE_PREFIX}* credential envelope (field "${field}"). ` +
        `The value in the database is malformed or truncated.`,
    );
  }

  const [, , keyId, ivB64, tagB64, bodyB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  // Checked before attempting the cipher so the common operational mistake —
  // rotating or losing the key — reports itself rather than surfacing as a bare
  // "unable to authenticate data".
  if (keyId !== key.id) {
    throw new Error(
      `Credential for field "${field}" was sealed with key ${keyId}, but ${key.id} is ` +
        `configured. The wrong CREDENTIAL_ENCRYPTION_KEY is set, or it was changed ` +
        `without re-encrypting existing rows.`,
    );
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key.bytes,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAAD(Buffer.from(field, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return (
      decipher.update(Buffer.from(bodyB64, "base64")).toString("utf8") +
      decipher.final("utf8")
    );
  } catch (cause) {
    // Authentication failed: the ciphertext, the tag or the field binding was
    // altered. The message deliberately does not distinguish which — that
    // distinction is only useful to someone doing the altering.
    throw new Error(
      `Credential for field "${field}" failed authentication. The stored value was ` +
        `modified, or it was sealed under a different field.`,
      { cause },
    );
  }
}
