import { PrismaPg } from "@prisma/adapter-pg";
import { credentialExtensionConfig } from "./credential-encryption/extension.js";
import { loadCredentialKey } from "./credential-encryption/key.js";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * The one place a Prisma client is constructed.
 *
 * Prisma 7 removed the `datasources` / `datasourceUrl` constructor options: the
 * connection is supplied by a driver adapter instead, so every call site needs
 * an adapter and `createPrismaClient()` on its own no longer connects to anything.
 * Rather than repeat that wiring at ~85 sites, they all come through here.
 *
 * This is also what removes the Rust query engine from the runtime. Under
 * Prisma 5 the client loaded a platform-specific `libquery_engine` binary, which
 * had to be downloaded from binaries.prisma.sh at image-build time; on this
 * network that download is blocked for Linux targets (darwin passes, every Linux
 * target returns HTTP 200 with a zero-byte body), which is why the api/web/worker
 * images could not build at all. With the driver adapter the runtime is pure
 * TypeScript over `pg` and needs no binary.
 *
 * ## Credential encryption
 *
 * Being the single construction site is also why the credential-encryption
 * extension lives here: applying it once covers all seven API services and every
 * worker handler without any of them changing. See
 * `credential-encryption/transform.ts` for what it does and where its edges are.
 *
 * @param url Overrides DATABASE_URL. Used by the test-support helpers, which
 *            each target their own per-checkout database.
 */
export function createPrismaClient(
  url?: string,
  options: CreatePrismaClientOptions = {},
): PrismaClient {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "createPrismaClient: no connection string. Pass one explicitly or set DATABASE_URL.",
    );
  }

  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  // The ONLY caller is the backfill script, which has to read plaintext and write
  // ciphertext itself; through the extension it would decrypt-fail on the read and
  // double-seal on the write.
  if (options.credentialEncryption === "bypass") return client;

  // Throws when the key is absent or malformed, naming the variable and the
  // command that repairs it. Deliberately at construction: a deployment missing
  // its key fails at startup rather than on the first sync, and there is no
  // fallback to storing credentials in the clear.
  const key = loadCredentialKey();

  // The cast is safe and is confined to this line. `$extends` returns
  // `DynamicClientExtensionThis`, which drops a few client-level members from the
  // type; this extension adds no members and changes no model-operation signature,
  // so every one of the ~85 call sites sees exactly the API it did before.
  return client.$extends(credentialExtensionConfig(key)) as unknown as PrismaClient;
}

export interface CreatePrismaClientOptions {
  /**
   * `"bypass"` builds a client with NO credential encryption — raw ciphertext in,
   * raw ciphertext out, and no key required. Reserved for
   * `scripts/encrypt-credentials.ts`. Anything else that reaches for this is
   * reintroducing the plaintext convention this module removed.
   */
  credentialEncryption?: "enabled" | "bypass";
}
