import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 moved CLI configuration out of `schema.prisma` and into this file.
 * Two things live here that used to live in the schema:
 *
 *  1. The connection URL. `datasource db` no longer accepts `url` — Prisma 7
 *     rejects the schema outright (P1012) if it is still there. The CLI reads
 *     the URL from here; the RUNTIME gets it from the driver adapter instead
 *     (see `createPrismaClient` in src/index.ts), which is why the datasource
 *     block is now provider-only.
 *
 *  2. The migrations directory, which the CLI no longer infers.
 *
 * Deliberately NO `dotenv` import. `packages/db`'s vitest config used to call
 * dotenv on the ROOT `.env`, whose DATABASE_URL is the LIVE staging Postgres on
 * :5433, while two of its suites `create` and `deleteMany` — the hazard called
 * out in CLAUDE.md § Testing. Every script in this package passes DATABASE_URL
 * explicitly, so nothing here needs to read a file to find a database, and an
 * unset DATABASE_URL fails loudly rather than silently resolving to staging.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
