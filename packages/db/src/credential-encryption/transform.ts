import { decryptCredential, encryptCredential, isEnvelope } from "./envelope.js";
import { CREDENTIAL_FIELD_NAMES, credentialFieldsFor } from "./fields.js";
import type { CredentialKey } from "./key.js";

/**
 * The two halves of the Prisma extension, kept separate from the wiring so they
 * can be tested without a database.
 *
 * They are deliberately asymmetric, and the reason is measured rather than
 * assumed (2026-09-11, across `apps/api` and `apps/worker`):
 *
 *  - **Writes are model-scoped.** No nested credential write exists anywhere in
 *    the repository — no `gitHubInstance: { create: … }` or equivalent — so
 *    sealing the top-level model's own registered fields is complete.
 *    `credential-coverage.test.ts` fails if one ever appears.
 *  - **Reads are a generic recursive walk**, because nested includes DO exist:
 *    six sites, e.g. `board → jiraProjectSync → jiraInstance`. A top-level-only
 *    read path would hand those back as ciphertext.
 */

export interface OpenOptions {
  /**
   * The model the query was issued against, when it owns credential columns.
   * Used ONLY for the plaintext check — the decryption walk does not need it.
   */
  model?: string;
  /** See `ALLOW_PLAINTEXT_ENV`. */
  allowPlaintext: boolean;
  warn: (message: string) => void;
}

/** Plain object, i.e. something worth walking into. Dates, Buffers and class
 *  instances are values, not containers, and descending into them corrupts them. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Prisma accepts both `field: value` and `field: { set: value }` on updates. */
function sealValue(value: unknown, field: string, key: CredentialKey): unknown {
  if (typeof value === "string") {
    // Already sealed: re-sealing would produce an envelope around an envelope,
    // and the backfill script depends on this being idempotent.
    return isEnvelope(value) ? value : encryptCredential(value, field, key);
  }
  if (isPlainObject(value) && typeof value.set === "string") {
    return { ...value, set: sealValue(value.set, field, key) };
  }
  // null clears a nullable token; undefined means "not being written".
  return value;
}

function sealPayload(payload: unknown, fields: readonly string[], key: CredentialKey): unknown {
  if (Array.isArray(payload)) return payload.map((row) => sealPayload(row, fields, key));
  if (!isPlainObject(payload)) return payload;

  let changed = false;
  const out: Record<string, unknown> = { ...payload };
  for (const field of fields) {
    if (!(field in out)) continue;
    const sealed = sealValue(out[field], field, key);
    if (sealed !== out[field]) {
      out[field] = sealed;
      changed = true;
    }
  }
  return changed ? out : payload;
}

/**
 * Seal registered credential fields in a write's arguments.
 *
 * Copies rather than mutating: Prisma hands the caller's own object to the
 * extension, and a caller that reuses its input would otherwise find its
 * plaintext silently replaced by ciphertext.
 */
export function sealWriteArgs(
  model: string | undefined,
  args: unknown,
  key: CredentialKey,
): unknown {
  const fields = credentialFieldsFor(model);
  if (fields.length === 0 || !isPlainObject(args)) return args;

  // `data` covers create/createMany/update/updateMany; `create` and `update`
  // together cover upsert.
  const out: Record<string, unknown> = { ...args };
  let changed = false;
  for (const slot of ["data", "create", "update"] as const) {
    if (!(slot in out)) continue;
    const sealed = sealPayload(out[slot], fields, key);
    if (sealed !== out[slot]) {
      out[slot] = sealed;
      changed = true;
    }
  }
  return changed ? out : args;
}

/**
 * Decrypt every sealed credential in a result, however deeply nested.
 *
 * Both conditions must hold before a value is touched: the key is a known
 * credential field name, AND the value is a `dgc.v1.` envelope. The second is
 * what keeps the walk away from the schema's ~20 `Json` columns — a JSON payload
 * with an `apiKey` key holds a value that is not an envelope, so it passes
 * through untouched.
 */
export function openReadResult(
  result: unknown,
  key: CredentialKey,
  options: OpenOptions,
): unknown {
  const plaintextFields = credentialFieldsFor(options.model);

  /**
   * Maps each container to its walked result.
   *
   * A Map rather than a `WeakSet` of visited nodes, and the difference is a real
   * defect rather than a style preference: with a set, the SECOND encounter of a
   * shared reference returned the node unwalked — so a credential reachable by
   * two paths came back decrypted down one and as raw ciphertext down the other.
   * Memoising the RESULT makes both paths agree, and still terminates on a cycle.
   *
   * Prisma materialises a tree today, so neither case is reachable from the
   * product. An extension sits in front of arbitrary callers, and a stack
   * overflow here would surface as an unexplained crash inside a sync job.
   */
  const walked = new Map<object, unknown>();

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const memo = walked.get(value);
      if (memo !== undefined) return memo;
      const out: unknown[] = [];
      // Registered BEFORE recursing, so a cycle resolves to this array rather
      // than recurring forever.
      walked.set(value, out);
      for (const item of value) out.push(walk(item));
      return out;
    }
    if (!isPlainObject(value)) return value;
    const memo = walked.get(value);
    if (memo !== undefined) return memo;

    const out: Record<string, unknown> = {};
    walked.set(value, out);
    for (const [field, child] of Object.entries(value)) {
      out[field] =
        CREDENTIAL_FIELD_NAMES.has(field) && isEnvelope(child)
          ? decryptCredential(child, field, key)
          : walk(child);
    }
    return out;
  };

  // The plaintext check runs on the TOP-LEVEL rows only, where the column is
  // known to be a genuine credential rather than a lookalike key inside a Json
  // payload. A plaintext value reached through a nested include passes through
  // and still works; the direct reads every service uses — getRawInstanceById,
  // getRawById — are what surface an un-backfilled database.
  if (plaintextFields.length > 0) {
    for (const row of Array.isArray(result) ? result : [result]) {
      if (!isPlainObject(row)) continue;
      for (const field of plaintextFields) {
        const value = row[field];
        if (typeof value !== "string" || value === "" || isEnvelope(value)) continue;
        const message =
          `${options.model}.${field} is still stored as plaintext. Run ` +
          `\`pnpm --filter @deckgauge/db encrypt-credentials\` to seal existing rows ` +
          `(\`--verify\` reports what is left).`;
        if (!options.allowPlaintext) throw new Error(message);
        options.warn(message);
      }
    }
  }

  return walk(result);
}
