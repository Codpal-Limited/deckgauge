import { ALLOW_PLAINTEXT_ENV } from "./fields.js";
import type { CredentialKey } from "./key.js";
import { openReadResult, sealWriteArgs } from "./transform.js";

/**
 * Wires `sealWriteArgs` / `openReadResult` into a Prisma client.
 *
 * Applied inside `createPrismaClient()`, which is the single place a client is
 * built in this repository — so all seven API services and every worker handler
 * get encryption without a line of their own changing, and the existing
 * `mask()` helpers and `credential-boundary.test.ts` keep working untouched.
 *
 * **Known bypass:** `$queryRaw` / `$executeRaw` do not pass through a `$allModels`
 * extension. Measured 2026-09-11: four raw-SQL sites exist in product code and
 * none touches a credential table. Recorded rather than guarded, because nothing
 * keeps it that way.
 */

export interface CredentialExtensionOptions {
  allowPlaintext?: boolean;
  warn?: (message: string) => void;
}

/** Warn once per model+field, not once per row. An un-backfilled table has as
 *  many rows as it has, and a per-row warning buries the operational signal it
 *  exists to give. */
function onceWarner(sink: (message: string) => void): (message: string) => void {
  const seen = new Set<string>();
  return (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    sink(message);
  };
}

export function credentialExtensionConfig(
  key: CredentialKey,
  options: CredentialExtensionOptions = {},
) {
  const allowPlaintext =
    options.allowPlaintext ?? process.env[ALLOW_PLAINTEXT_ENV] === "1";
  const warn = onceWarner(
    options.warn ?? ((message) => console.warn(`[credential-encryption] ${message}`)),
  );

  return {
    name: "credential-encryption",
    query: {
      $allModels: {
        async $allOperations({
          model,
          args,
          query,
        }: {
          model: string;
          operation: string;
          args: unknown;
          query: (args: never) => Promise<unknown>;
        }) {
          const result = await query(sealWriteArgs(model, args, key) as never);
          return openReadResult(result, key, { model, allowPlaintext, warn });
        },
      },
    },
  };
}
