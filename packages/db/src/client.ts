import { PrismaPg } from "@prisma/adapter-pg";
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
 * @param url Overrides DATABASE_URL. Used by the test-support helpers, which
 *            each target their own per-checkout database.
 */
export function createPrismaClient(url?: string): PrismaClient {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "createPrismaClient: no connection string. Pass one explicitly or set DATABASE_URL.",
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
