/**
 * Seal every provider credential that is still stored as plaintext.
 *
 * Run once after upgrading an existing install. New installs need it only to
 * report zero.
 *
 *     pnpm --filter @deckgauge/db encrypt-credentials           # encrypt
 *     pnpm --filter @deckgauge/db encrypt-credentials --verify  # count, change nothing
 *
 * `--verify` exits non-zero while any plaintext remains, which is what lets the
 * published security statement make an unconditional claim rather than a hedged
 * one.
 *
 * ## Why this is a script and not a migration
 *
 * Migrations here are hand-written SQL applied with `prisma migrate deploy`
 * (CLAUDE.md § First-time setup), and SQL cannot call Node's crypto. There is
 * also no schema change to make: all nine columns are already unbounded `TEXT`
 * and ciphertext is text.
 *
 * ## Why it bypasses the extension
 *
 * It has to READ plaintext — which the extension refuses by default — and WRITE
 * ciphertext it has already produced, which the extension would seal a second
 * time. `sealValue` is idempotent so the double-seal would not actually occur,
 * but depending on that is a worse design than not routing through it at all.
 */
import { createPrismaClient } from "../client.js";
import { CREDENTIAL_FIELDS } from "../credential-encryption/fields.js";
import { encryptCredential, isEnvelope } from "../credential-encryption/envelope.js";
import { loadCredentialKey } from "../credential-encryption/key.js";
import { isMainModule } from "../esm-main.js";

/** Prisma exposes `GitHubInstance` as `prisma.gitHubInstance` — first letter
 *  lowered, nothing else changed. */
function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

interface ColumnReport {
  model: string;
  field: string;
  plaintext: number;
  sealed: number;
}

export interface BackfillReport {
  columns: ColumnReport[];
  /** Values this run sealed. Always 0 under `--verify`. */
  encrypted: number;
  /** Values still in the clear when the run finished. */
  remaining: number;
}

type Row = { id: string } & Record<string, unknown>;
type Delegate = {
  findMany(args: unknown): Promise<Row[]>;
  update(args: unknown): Promise<unknown>;
};

export async function backfillCredentials(
  client: Record<string, unknown>,
  options: { verify: boolean; log?: (message: string) => void } = { verify: false },
): Promise<BackfillReport> {
  const log = options.log ?? ((message: string) => console.log(message));
  const key = loadCredentialKey();
  const columns: ColumnReport[] = [];
  let encrypted = 0;
  let remaining = 0;

  for (const [model, fields] of Object.entries(CREDENTIAL_FIELDS)) {
    const delegate = client[delegateName(model)] as Delegate | undefined;
    if (!delegate) throw new Error(`No Prisma delegate for model ${model}`);

    for (const field of fields) {
      // Selecting only id + the one column keeps a credential out of memory for
      // longer than it has to be, and keeps the query cheap on a large table.
      const rows = await delegate.findMany({ select: { id: true, [field]: true } });

      let plaintext = 0;
      let sealed = 0;

      for (const row of rows) {
        const value = row[field];
        if (typeof value !== "string" || value === "") continue;
        if (isEnvelope(value)) {
          sealed += 1;
          continue;
        }
        plaintext += 1;
        if (options.verify) continue;

        await delegate.update({
          where: { id: row.id },
          data: { [field]: encryptCredential(value, field, key) },
        });
        encrypted += 1;
      }

      if (options.verify) remaining += plaintext;
      columns.push({ model, field, plaintext, sealed });
      const verb = options.verify ? "plaintext" : "encrypted";
      log(
        `  ${model}.${field}: ${plaintext} ${verb}, ${sealed} already sealed` +
          ` (${rows.length} row${rows.length === 1 ? "" : "s"})`,
      );
    }
  }

  return { columns, encrypted, remaining };
}

async function main(): Promise<void> {
  const verify = process.argv.includes("--verify");

  console.log(
    verify
      ? "Checking provider credentials for plaintext…"
      : "Encrypting provider credentials at rest…",
  );

  // Bypass, for the two reasons in this file's header.
  const client = createPrismaClient(undefined, { credentialEncryption: "bypass" });

  try {
    const report = await backfillCredentials(client as unknown as Record<string, unknown>, {
      verify,
    });

    if (verify) {
      if (report.remaining > 0) {
        console.error(
          `\n${report.remaining} credential value(s) are still stored as plaintext. ` +
            `Run this command without --verify to seal them.`,
        );
        process.exitCode = 1;
        return;
      }
      console.log("\nNo plaintext credentials remain.");
      return;
    }

    console.log(`\nEncrypted ${report.encrypted} credential value(s).`);
  } finally {
    await (client as unknown as { $disconnect(): Promise<void> }).$disconnect();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
