import * as fs from 'fs';
import * as path from 'path';
import {
  applyRowPolicyBaseline,
  chExecutorFromClient,
  type ChCoverageReport,
} from './ch-provisioning.js';
import { dirnameOf, isMainModule } from './esm-main.js';

export interface ClickhouseExecClient {
  exec(params: { query: string }): Promise<unknown>;
  query(params: { query: string; format?: string }): Promise<{
    // @clickhouse/client returns a union here (T[] | ResponseJSON<T> | Record<string, T>);
    // we narrow at the call site (e.g. `(await result.json()) as MigrationRow[]`)
    // because we only ever request format=JSONEachRow, which always yields T[].
    // Using unknown (no generic) keeps the interface compatible with both the
    // real NodeClickHouseClient and the fake test client.
    json(): Promise<unknown>;
  }>;
}

export interface ClickhouseMigrationOptions {
  client: ClickhouseExecClient;
  schemasDir: string;
}

export interface ClickhouseMigrationResult {
  applied: string[];
  skipped: string[];
  /**
   * What the closing row-policy pass covered. Always present: the pass is not
   * optional, because a table this migration just created is covered by nothing
   * until it runs, and an uncovered ClickHouse object is world-readable.
   */
  rowPolicies: ChCoverageReport;
}

const ENSURE_DATABASE_DDL = 'CREATE DATABASE IF NOT EXISTS cockpit';

// Split a multi-statement SQL file into individual statements. ClickHouse's
// HTTP API rejects multi-statement queries (Code 62 SYNTAX_ERROR), so each
// statement must be sent separately. Splits on top-level semicolons; the DDL
// files in clickhouse/schemas/ have no string literals containing ';' so a
// naive split is safe. Comment-only lines (-- ...) are stripped before split
// to keep statement boundaries unambiguous.
function splitSqlStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS cockpit._ch_migrations (
  filename   String,
  applied_at DateTime DEFAULT now()
) ENGINE = MergeTree() ORDER BY filename
`.trim();

interface MigrationRow {
  filename: string;
}

export async function runClickhouseMigrations(
  opts: ClickhouseMigrationOptions,
): Promise<ClickhouseMigrationResult> {
  const { client, schemasDir } = opts;

  await client.exec({ query: ENSURE_DATABASE_DDL });
  await client.exec({ query: MIGRATIONS_TABLE_DDL });

  const appliedResult = await client.query({
    query: 'SELECT filename FROM cockpit._ch_migrations',
    format: 'JSONEachRow',
  });
  const appliedRows = (await appliedResult.json()) as MigrationRow[];
  const appliedSet = new Set(appliedRows.map((row) => row.filename));

  const allFiles = fs
    .readdirSync(schemasDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of allFiles) {
    if (appliedSet.has(filename)) {
      skipped.push(filename);
      continue;
    }
    const filePath = path.join(schemasDir, filename);
    const sql = fs.readFileSync(filePath, 'utf8').trim();
    if (sql.length === 0) {
      skipped.push(filename);
      continue;
    }
    const statements = splitSqlStatements(sql);
    for (const statement of statements) {
      try {
        await client.exec({ query: statement });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`ClickHouse migration ${filename} failed: ${reason}`);
      }
    }
    await client.exec({
      query: `INSERT INTO cockpit._ch_migrations (filename) VALUES ('${filename}')`,
    });
    applied.push(filename);
  }

  // Re-apply the catch-all deny LAST, over the server's live object list.
  //
  // Onboarding-time provisioning is not enough: any table or materialized view
  // a schema file just created is covered by no row policy, and ClickHouse row
  // policies are permissive, so an uncovered object is readable in full by any
  // identity — including one holding no organization role at all. Ending every
  // migration with this pass is what makes "a new table is protected" a property
  // of the migration rather than of someone remembering.
  //
  // Re-running is safe but is NOT entirely window-free, and the distinction
  // matters. The catch-all deny is IF NOT EXISTS and is never dropped, so an
  // object's protection is never lifted. The service identity's `ingest_all`
  // grant, however, converges by drop-then-create, so mid-pass that one
  // identity is briefly denied on the object being replaced. That direction
  // fails CLOSED — the app transiently reads zero rather than reading another
  // tenant — which is why drop-then-create is acceptable here and forbidden for
  // the deny. If the process dies inside that window, the object stays denied to
  // the app until `migrate:clickhouse` runs again; nothing reports it, so a
  // single table reading zero after a crashed migration is the symptom to look
  // for.
  //
  // It throws rather than warning: a migration that leaves objects unprotected
  // must not report success. Applying row policies needs a ClickHouse user with
  // access management.
  let rowPolicies: ChCoverageReport;
  try {
    rowPolicies = await applyRowPolicyBaseline(chExecutorFromClient(client));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ClickHouse migrations applied but the row-policy pass failed, so tenant isolation is ` +
        `NOT in place and new objects are world-readable: ${reason}`,
    );
  }

  return { applied, skipped, rowPolicies };
}

async function runFromCli(): Promise<void> {
  const { clickhouse } = await import('./clickhouse.js');
  const repoRoot = path.resolve(dirnameOf(import.meta.url), '../../..');
  const schemasDir = process.env.CLICKHOUSE_SCHEMAS_DIR
    ?? path.join(repoRoot, 'clickhouse', 'schemas');

  if (!fs.existsSync(schemasDir)) {
    console.error(`Schemas directory not found: ${schemasDir}`);
    process.exit(1);
  }

  console.log(`Applying ClickHouse migrations from ${schemasDir}`);
  const result = await runClickhouseMigrations({ client: clickhouse, schemasDir });

  for (const filename of result.skipped) {
    console.log(`  • skipped ${filename} (already applied)`);
  }
  for (const filename of result.applied) {
    console.log(`  ✓ applied ${filename}`);
  }

  console.log(
    `  ✓ row policies: ${result.rowPolicies.denied.length} objects denied by default, ` +
      `${result.rowPolicies.tenant.length} organization-scoped, ` +
      `${result.rowPolicies.shared.length} shared`,
  );
  // Stated on every run, not warned about: the API and the worker share this one
  // connection, so it is granted a cross-organization read on every object — the
  // same access it had before row policies existed. The catch-all's value is the
  // default it sets for every OTHER identity. Per-organization credentials are a
  // separate, deferred decision, and until they exist an operator should be able
  // to see this in the output rather than infer it from the code.
  console.log(
    `  ✓ ingest identity '${result.rowPolicies.serviceIdentity}' reads and writes across all ` +
      `organizations (the worker's cross-tenant ingest connection)`,
  );
  // The one line that says whether the read path is actually split. Both states
  // are legitimate and they are not distinguishable from any other output, so
  // neither is left to inference.
  if (result.rowPolicies.apiReadIdentity === undefined) {
    console.warn(
      `  ! no API read identity is configured, so reads still run through the ingest identity ` +
        `'${result.rowPolicies.serviceIdentity}' and span every organization. Set ` +
        `CLICKHOUSE_READ_USER / CLICKHOUSE_READ_URL to a SEPARATE ClickHouse login holding no ` +
        `row policy of its own to scope reads per organization.`,
    );
  } else {
    console.log(
      `  ✓ API read identity '${result.rowPolicies.apiReadIdentity}' holds DEFAULT ROLE NONE and ` +
        `is granted each organization's role, so a read is scoped by the role= it passes and ` +
        `reads nothing without one`,
    );
  }
  if (result.rowPolicies.unreadable.length > 0) {
    // Loud on purpose. These have no organization_id, so no per-organization
    // policy can re-admit them and every organization's users read zero rows —
    // which looks like empty analytics, not like an error.
    //
    // The fix is to give the object an organization_id. Deliberately NOT
    // suggesting CH_SHARED_OBJECTS: that list is for objects holding no tenant
    // data at all, and adding a table that does hold it would make every
    // organization's rows readable by every user (sharedObjectAllowDdl refuses,
    // but the advice should not point at the wall in the first place).
    console.warn(
      `  ! ${result.rowPolicies.unreadable.length} object(s) have no organization_id and are ` +
        `readable by NOBODY except the ingest identity: ${result.rowPolicies.unreadable.join(', ')}. ` +
        `Give them an organization_id to make them tenant-scoped.`,
    );
  }
  if (result.rowPolicies.needsReprovision.length > 0) {
    // Fails closed, so this is a correctness note rather than a security one —
    // but an unreported one reads as "analytics went empty after the deploy".
    console.warn(
      `  ! ${result.rowPolicies.needsReprovision.length} organization-scoped object(s) have no ` +
        `per-organization policy yet, so NO organization can read them: ` +
        `${result.rowPolicies.needsReprovision.join(', ')}. Re-provision to write the predicates ` +
        `(OrganizationService.provisionAllAnalytics(), or reprovisionOrganizations(exec, ids)).`,
    );
  }

  await clickhouse.close();
  console.log(`Done. ${result.applied.length} applied, ${result.skipped.length} skipped.`);
}

const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  runFromCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
