import { defineConfig } from "vitest/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env.test if present (intentionally no dotenv dependency).
// Skips blank lines and # comments. Unwraps matching single/double quotes.
function loadTestEnv(): Record<string, string> {
  const file = resolve(__dirname, ".env.test");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Every integration suite here shares one Postgres, and the one-org cap
    // (OrganizationService.bootstrap does an unfiltered findFirst) can only be
    // asserted when no other file is creating organizations concurrently.
    // Prefix-scoped cleanup cannot substitute: the assertion is global by
    // nature, not per-fixture.
    fileParallelism: false,
    env: loadTestEnv(),
  },
});
