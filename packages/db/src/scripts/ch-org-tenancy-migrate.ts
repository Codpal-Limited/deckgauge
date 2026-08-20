import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CH_TENANT_TABLES, type ChTenantTable } from '../ch-tenancy-tables.js';
import { applyRowPolicyBaseline, chExecutorFromClient } from '../ch-provisioning.js';

/**
 * Migrates an EXISTING ClickHouse database to organization-keyed tables.
 *
 * The schema files under clickhouse/schemas/ already declare organization_id at
 * the head of every sort key, but the migration runner is a file ledger
 * (cockpit._ch_migrations records applied filenames and never re-applies one),
 * so those edits reach fresh installs only. Every database that already holds
 * data still has the old shape, and this script is the only path that moves it
 * across without losing rows.
 *
 * Each table is REBUILT rather than ALTERed because ClickHouse 24.3 refuses
 * every in-place route (verified against 24.3.18.7):
 *
 *   - ADD COLUMN, then a separate MODIFY ORDER BY
 *       → Code 36: "Existing column organization_id is used in the expression
 *         that was added to the sorting key."
 *   - one ALTER with ADD COLUMN … DEFAULT '' + MODIFY ORDER BY
 *       → Code 36: "Newly added column has a default expression, so adding
 *         expressions that use it to the sorting key is forbidden."
 *   - one ALTER with ADD COLUMN organization_id String (no default) +
 *     MODIFY ORDER BY
 *       → accepted, but existing rows get '' and Code 420 ("Cannot UPDATE key
 *         column organization_id") makes that permanent.
 *
 * So the tenant value has to be supplied while the rows are copied — there is
 * no second chance at it. The sequence per table is: create the new shape as a
 * scratch table, INSERT … SELECT with the organization stamped in, compare row
 * counts, EXCHANGE TABLES, drop the scratch.
 */

const DB = 'cockpit';
const ORG_COLUMN = 'organization_id';
const SCRATCH_SUFFIX = '__v2';
const FLOW_STATE_TABLE = 'jira_flow_efficiency_state';
const FLOW_VIEW = 'mv_jira_flow_efficiency';

/**
 * The materialized-view definition is read from the schema file rather than
 * restated here, so the view this script recreates and the view a fresh install
 * gets cannot drift apart. packages/db/src/scripts → repo root is four levels;
 * the compiled dist/scripts/ sits at the same depth.
 */
const MV_SCHEMA_FILE = resolve(__dirname, '../../../../clickhouse/schemas/50_materialized_views.sql');

/** The slice of @clickhouse/client this script needs — keeps tests injectable. */
export interface ChExec {
  command(params: { query: string }): Promise<unknown>;
  query(params: { query: string; format?: string }): Promise<{ json(): Promise<unknown> }>;
}

export interface MigrateOpts {
  client: ChExec;
  organizationId: string;
  /** Defaults to every tenant table; narrowed in tests. */
  tables?: ReadonlyArray<ChTenantTable>;
  onProgress?: (message: string) => void;
}

export interface TableReport {
  table: string;
  /** Logical rows (counted with FINAL) before the rebuild — see countLogicalRows. */
  rowsBefore: number;
  /** Logical rows after the copy; must equal rowsBefore or the swap is aborted. */
  rowsAfter: number;
  /** Present only when nothing was rebuilt, so a plain migration reports {table, rowsBefore, rowsAfter}. */
  skipped?: 'missing' | 'already-tenant-keyed';
  /** Set only when the post-swap cleanup failed: this table still exists and holds the pre-migration copy. */
  leftoverScratch?: string;
}

interface TableMeta {
  createQuery: string;
  sortingKey: string;
  engine: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`migrateChToOrgTenancy: refusing to interpolate "${name}" as a table name`);
  }
}

/** ClickHouse string literal quoting for the one untrusted value we interpolate. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function scalar(client: ChExec, sql: string): Promise<string> {
  const result = await client.query({ query: sql, format: 'JSONEachRow' });
  const rows = (await result.json()) as Array<Record<string, unknown>>;
  const first = rows[0];
  if (first === undefined) return '';
  const value = Object.values(first)[0];
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Engines whose background merges change the raw row count — and the only ones
 * that accept FINAL. A plain MergeTree rejects it outright ("Storage MergeTree
 * doesn't support FINAL"), and does not need it: nothing collapses its rows.
 * Every shipped tenant table is one of these two families today; the wider list
 * costs nothing and stops a future SummingMergeTree from silently taking the
 * raw-count path.
 */
const MERGE_COLLAPSING_ENGINE =
  /^(Replicated)?(Replacing|Aggregating|Collapsing|Summing|VersionedCollapsing|Graphite)MergeTree$/;

/**
 * The number of LOGICAL rows in a table, counted with FINAL where the engine
 * collapses rows on merge.
 *
 * On a ReplacingMergeTree or an AggregatingMergeTree a raw count is not a stable
 * number: a background merge collapses duplicate keys and partial aggregate
 * states at any moment, so a raw count taken before the copy and one taken after
 * it can differ for that reason alone — which would make the guard abort a
 * perfectly good migration (observed: two AggregatingMergeTree state rows for one
 * key merged into one mid-run). The FINAL count is invariant under merges, so a
 * difference across the copy means rows really were lost or added.
 *
 * optimize_trivial_count_query is turned off so the answer cannot be served from
 * part metadata, which would ignore FINAL.
 */
async function countLogicalRows(client: ChExec, table: string, engine: string): Promise<number> {
  const query = MERGE_COLLAPSING_ENGINE.test(engine)
    ? `SELECT count() FROM ${DB}.${table} FINAL SETTINGS optimize_trivial_count_query = 0`
    : `SELECT count() FROM ${DB}.${table}`;
  return Number(await scalar(client, query));
}

async function readTableMeta(client: ChExec, table: string): Promise<TableMeta | undefined> {
  const result = await client.query({
    query: `SELECT create_table_query, sorting_key, engine FROM system.tables
            WHERE database = ${quote(DB)} AND name = ${quote(table)}`,
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as Array<{
    create_table_query: string; sorting_key: string; engine: string;
  }>;
  const row = rows[0];
  return row === undefined
    ? undefined
    : { createQuery: row.create_table_query, sortingKey: row.sorting_key, engine: row.engine };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derives the new table's DDL from the server's own `create_table_query`.
 *
 * Deriving beats restating: the string the server hands back carries every
 * column type, DEFAULT, CODEC, engine parameter, PARTITION BY expression and
 * SETTINGS value, so none of them can be dropped by this script or drift from
 * the schema file. Only two things are patched — the table name and the sort key
 * — and the sort key comes from `system.tables.sorting_key` (the server's own
 * rendering of the clause) rather than from the caller, so the text always
 * matches what is in the DDL.
 *
 * Verified against ClickHouse 24.3: `create_table_query` is a single line with
 * every column back-quoted, e.g.
 *   CREATE TABLE cockpit.jira_issues (`id` String, … , `synced_at` DateTime
 *   DEFAULT now()) ENGINE = ReplacingMergeTree(synced_at)
 *   PARTITION BY toYYYYMM(created_at) ORDER BY (project_key, key)
 *   SETTINGS index_granularity = 8192
 */
export function buildTenantKeyedDdl(meta: TableMeta, table: string, scratch: string): string {
  const namePattern = new RegExp(`^CREATE TABLE\\s+(\`?${escapeRe(DB)}\`?\\.)?\`?${escapeRe(table)}\`?`);
  if (!namePattern.test(meta.createQuery)) {
    throw new Error(`${table}: unrecognised CREATE TABLE text from the server:\n${meta.createQuery}`);
  }

  // An explicit PRIMARY KEY clause must stay a prefix of the sort key. Widening
  // ORDER BY alone would break that rule, and guessing at the intent of a shape
  // the schema does not use is worse than stopping.
  if (/\bPRIMARY KEY\b/i.test(meta.createQuery)) {
    throw new Error(
      `${table}: has an explicit PRIMARY KEY clause, which this migration does not handle. ` +
      `Rebuild it by hand.\n${meta.createQuery}`,
    );
  }

  let ddl = meta.createQuery.replace(namePattern, `CREATE TABLE ${DB}.${scratch}`);

  const openParen = ddl.indexOf('(');
  if (openParen === -1) {
    throw new Error(`${table}: no column list found in:\n${meta.createQuery}`);
  }
  ddl = `${ddl.slice(0, openParen + 1)}\`${ORG_COLUMN}\` String, ${ddl.slice(openParen + 1)}`;

  const widened = `ORDER BY (${ORG_COLUMN}, ${meta.sortingKey})`;
  const parenthesised = `ORDER BY (${meta.sortingKey})`;
  const bare = `ORDER BY ${meta.sortingKey}`;
  if (ddl.includes(parenthesised)) {
    ddl = ddl.replace(parenthesised, widened);
  } else if (ddl.includes(bare)) {
    // A single-column key is rendered without parentheses ("ORDER BY a"), and
    // SETTINGS may follow it — so this cannot be anchored to end-of-string.
    ddl = ddl.replace(bare, widened);
  } else {
    throw new Error(
      `${table}: could not locate the ORDER BY clause for sort key "${meta.sortingKey}" in:\n${meta.createQuery}`,
    );
  }

  if (!ddl.includes(`ORDER BY (${ORG_COLUMN},`)) {
    throw new Error(`${table}: rewrite did not produce a tenant-led sort key:\n${ddl}`);
  }
  return ddl;
}

/**
 * Every column that can be written, in declaration order. ALIAS and MATERIALIZED
 * columns are computed by the server and rejected in an INSERT column list.
 */
async function insertableColumns(client: ChExec, table: string): Promise<string> {
  const result = await client.query({
    query: `SELECT name FROM system.columns
            WHERE database = ${quote(DB)} AND table = ${quote(table)}
              AND name != ${quote(ORG_COLUMN)}
              AND default_kind NOT IN ('ALIAS', 'MATERIALIZED')
            ORDER BY position`,
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as Array<{ name: string }>;
  if (rows.length === 0) {
    throw new Error(`${table}: system.columns reports no writable columns`);
  }
  return rows.map((r) => `\`${r.name}\``).join(', ');
}

async function rebuildTable(
  client: ChExec,
  entry: ChTenantTable,
  organizationId: string,
  onProgress: (message: string) => void,
): Promise<TableReport> {
  const { table, originalOrderBy } = entry;
  assertIdentifier(table);
  const scratch = `${table}${SCRATCH_SUFFIX}`;

  const meta = await readTableMeta(client, table);
  if (meta === undefined) {
    onProgress(`${table}: not present in ${DB} — skipped`);
    return { table, rowsBefore: 0, rowsAfter: 0, skipped: 'missing' };
  }

  const rowsBefore = await countLogicalRows(client, table, meta.engine);

  if (meta.sortingKey === ORG_COLUMN || meta.sortingKey.startsWith(`${ORG_COLUMN},`)) {
    // Already migrated. A half-finished rollout gets re-run, and rebuilding a
    // tenant-keyed table again would restamp its rows with whatever
    // organization this invocation was given — so skip, do not redo.
    onProgress(`${table}: already tenant-keyed — skipped`);
    return { table, rowsBefore, rowsAfter: rowsBefore, skipped: 'already-tenant-keyed' };
  }

  if (meta.sortingKey !== originalOrderBy) {
    throw new Error(
      `${table}: expected the sort key "${originalOrderBy}" but the server reports ` +
      `"${meta.sortingKey}". Refusing to rebuild a table whose shape this migration does not recognise.`,
    );
  }

  const ddl = buildTenantKeyedDdl(meta, table, scratch);
  const columns = await insertableColumns(client, table);

  await client.command({ query: `DROP TABLE IF EXISTS ${DB}.${scratch}` });
  let rowsAfter = 0;
  try {
    await client.command({ query: ddl });
    // No FINAL on the source — but the copy is NOT row-for-row either. ClickHouse
    // applies optimize_on_insert (default 1) as rows are written, so a
    // ReplacingMergeTree collapses rows sharing a sort key on the way in:
    // 4 raw source rows can legitimately land as 2. That is the same content, and
    // it is why the guard below compares logical (FINAL) counts — a raw count is
    // the wrong comparison, moved both by this collapse and by background merges,
    // while the FINAL count is moved by neither.
    //
    // max_partitions_per_insert_block = 0 lifts ClickHouse's default limit of 100
    // partitions per insert block. A whole-table copy of a monthly-partitioned
    // table spans one partition per month of history, so any table with more than
    // ~8 years of data is refused outright with `Code 252 TOO_MANY_PARTS`.
    // Observed on real staging data: ado_work_items and ado_transitions both
    // failed, mid-run, after earlier tables had already been swapped — leaving a
    // half-migrated database. It is a per-query setting, so nothing about normal
    // ingest is relaxed by it.
    await client.command({
      query:
        `INSERT INTO ${DB}.${scratch} (\`${ORG_COLUMN}\`, ${columns}) ` +
        `SELECT ${quote(organizationId)}, ${columns} FROM ${DB}.${table} ` +
        `SETTINGS max_partitions_per_insert_block = 0`,
    });

    // Same engine as the source, so the same counting rule applies.
    rowsAfter = await countLogicalRows(client, scratch, meta.engine);
    if (rowsAfter !== rowsBefore) {
      throw new Error(
        `${table}: copied ${rowsAfter} rows but the source had ${rowsBefore}; aborting before the swap. ` +
        `(Ingest writing to this table during the migration is the usual cause — stop the worker and re-run.)`,
      );
    }
  } catch (err) {
    // The source table has not been touched yet, so the safe state is: source
    // intact, scratch gone. Leaving a full copy behind would waste the disk and
    // confuse a retry.
    await client.command({ query: `DROP TABLE IF EXISTS ${DB}.${scratch}` }).catch(() => undefined);
    throw err;
  }

  await client.command({ query: `EXCHANGE TABLES ${DB}.${table} AND ${DB}.${scratch}` });

  // After the exchange the scratch name holds the OLD table. If this drop fails
  // the rebuild is still complete and correct — the swap already happened — so
  // report the orphan rather than abort a finished table. It only costs disk.
  let leftoverScratch: string | undefined;
  try {
    await client.command({ query: `DROP TABLE IF EXISTS ${DB}.${scratch}` });
  } catch (err) {
    leftoverScratch = `${DB}.${scratch}`;
    onProgress(
      `${table}: rebuilt, but ${leftoverScratch} (the pre-migration copy) could not be dropped — ` +
      `${describeError(err)}. Drop it by hand to reclaim the disk.`,
    );
  }

  onProgress(`${table}: ${rowsAfter} rows`);
  return leftoverScratch === undefined
    ? { table, rowsBefore, rowsAfter }
    : { table, rowsBefore, rowsAfter, leftoverScratch };
}

async function objectExists(client: ChExec, name: string): Promise<boolean> {
  const count = await scalar(
    client,
    `SELECT count() FROM system.tables WHERE database = ${quote(DB)} AND name = ${quote(name)}`,
  );
  return Number(count) > 0;
}

async function columnExists(client: ChExec, table: string, column: string): Promise<boolean> {
  const count = await scalar(
    client,
    `SELECT count() FROM system.columns
     WHERE database = ${quote(DB)} AND table = ${quote(table)} AND name = ${quote(column)}`,
  );
  return Number(count) > 0;
}

/**
 * The CREATE MATERIALIZED VIEW statement as the schema file declares it today.
 *
 * Split on `;` at end of line, exactly the way the schema loader and the test
 * container split these files — NOT on the first `;` in the text. The view's own
 * comments contain a mid-line semicolon ("resolved_at is non-null; assumeNotNull
 * above strips…"), and cutting there silently drops the WHERE and GROUP BY.
 */
function readFlowViewStatement(): string {
  const sql = readFileSync(MV_SCHEMA_FILE, 'utf-8');
  const statement = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .find((s) => /^CREATE MATERIALIZED VIEW/i.test(s));
  if (statement === undefined) {
    throw new Error(`No CREATE MATERIALIZED VIEW statement found in ${MV_SCHEMA_FILE}`);
  }

  // The whole point of recreating the view is the tenant column. If the file
  // ever loses it, fail here rather than install a view that blends every
  // organization into one bucket.
  if (!new RegExp(`GROUP BY[\\s\\S]*\\b${ORG_COLUMN}\\b`, 'i').test(statement)) {
    throw new Error(`${FLOW_VIEW} definition in ${MV_SCHEMA_FILE} does not GROUP BY ${ORG_COLUMN}`);
  }
  if (!new RegExp(`\\b${ORG_COLUMN}\\b\\s*,`).test(statement)) {
    throw new Error(`${FLOW_VIEW} definition in ${MV_SCHEMA_FILE} does not select ${ORG_COLUMN}`);
  }
  return statement;
}

/**
 * What the flow-efficiency view looked like before this run touched it, plus a
 * fingerprint of its source table taken at the same moment.
 *
 * Both halves are load-bearing:
 *
 * - `originalDdl` is the only way to put the view back on a failure path where
 *   jira_issues has not been rebuilt yet. The tenant-aware definition reads
 *   organization_id from jira_issues and fails with Code 47 against the old
 *   shape, which would leave the view dropped.
 * - the fingerprint is how a gap is detected. A materialized view does not
 *   backfill, so anything written to jira_issues while the view was down is
 *   missing from the state table permanently — and silently — unless the
 *   aggregate is re-derived.
 *
 * The fingerprint is a heuristic, not a proof, and the two legs are not
 * exhaustive. A re-ingest that rewrites existing keys without changing the
 * logical row count AND without advancing max(synced_at) is invisible to both
 * legs, so the gap goes undetected. That needs a same-second write or a
 * backfill that stamps a non-advancing synced_at, so it is narrow — but it is
 * not impossible, and the honest reading of a clean fingerprint is "no gap was
 * observed", not "no gap occurred". Stopping ingest before a migration (the
 * documented rollout step) is what actually makes the window empty; this check
 * is the backstop for when that step is skipped.
 *
 * Note also that the repair truncates and fully recomputes from jira_issues, so
 * it can only reproduce weeks jira_issues still covers. That is sound today —
 * nothing deletes or TTLs those rows — but a future retention policy on
 * jira_issues would make the repair lossy for older weeks, and this comment is
 * the warning for whoever adds one.
 */
interface FlowViewSnapshot {
  existed: boolean;
  originalDdl: string;
  issuesRows: number;
  issuesWatermark: string;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A pair of numbers that move if and only if jira_issues was written to.
 *
 * Both have to be invariant under the rebuild itself, or the gap check would fire
 * on every migration: the copy is NOT row-for-row (see the INSERT below), so a raw
 * row count legitimately shrinks across it. A FINAL count does not, and neither
 * does max(synced_at) — ReplacingMergeTree keeps the highest synced_at per key, so
 * the global maximum always survives a collapse.
 *
 * The watermark earns its place separately: an issue that transitioned to Done
 * while the view was down re-enters as a new version under the same key, so the
 * count is unchanged while the aggregate really has fallen behind.
 */
async function fingerprintIssues(client: ChExec): Promise<{ rows: number; watermark: string }> {
  const meta = await readTableMeta(client, 'jira_issues');
  if (meta === undefined) return { rows: 0, watermark: '' };
  const rows = await countLogicalRows(client, 'jira_issues', meta.engine);
  const watermark = (await columnExists(client, 'jira_issues', 'synced_at'))
    ? await scalar(client, `SELECT toString(max(synced_at)) FROM ${DB}.jira_issues`)
    : '';
  return { rows, watermark };
}

async function captureFlowView(client: ChExec): Promise<FlowViewSnapshot> {
  const existed = await objectExists(client, FLOW_VIEW);
  const originalDdl = existed
    ? await scalar(
      client,
      `SELECT create_table_query FROM system.tables
       WHERE database = ${quote(DB)} AND name = ${quote(FLOW_VIEW)}`,
    )
    : '';
  const { rows, watermark } = await fingerprintIssues(client);
  return { existed, originalDdl, issuesRows: rows, issuesWatermark: watermark };
}

/**
 * Refuses, before anything is dropped, a run that could not put the view back.
 *
 * The case this catches is migrateChMaterializedViews() against a database that
 * has not been migrated yet: it rebuilds only the state table, so the view that
 * has to go back is the tenant-aware definition — which fails with Code 47 while
 * jira_issues still has no organization_id, leaving the view down with no way to
 * recreate it. Checking up front is the point: this function must not be able to
 * leave a database worse than it found it.
 */
async function assertFlowViewRestorable(
  client: ChExec,
  tables: ReadonlyArray<ChTenantTable>,
): Promise<void> {
  if (!(await objectExists(client, FLOW_STATE_TABLE)) || !(await objectExists(client, 'jira_issues'))) {
    return;
  }

  const stateWillCarryOrg = tables.some((t) => t.table === FLOW_STATE_TABLE)
    || await columnExists(client, FLOW_STATE_TABLE, ORG_COLUMN);
  if (!stateWillCarryOrg) return;

  const issuesWillCarryOrg = tables.some((t) => t.table === 'jira_issues')
    || await columnExists(client, 'jira_issues', ORG_COLUMN);
  if (issuesWillCarryOrg) return;

  throw new Error(
    `Refusing to start: ${FLOW_STATE_TABLE} would end up tenant-keyed while ${DB}.jira_issues still has no ` +
    `${ORG_COLUMN}, so ${FLOW_VIEW} could not be recreated (Code 47) and would be left dropped. ` +
    'Migrate jira_issues in the same run — migrateChToOrgTenancy() with no `tables` option does exactly that.',
  );
}

/**
 * Puts the flow-efficiency view back, and closes any gap the outage opened.
 *
 * Which definition goes back is decided by the STATE TABLE's shape, because that
 * is what the view writes into. The tenant-aware definition over an old-shape
 * state table, or the old definition over a rebuilt one, both write rows that are
 * wrong in ways Code 420 makes permanent — the second silently, at ''.
 */
async function restoreFlowView(
  client: ChExec,
  snapshot: FlowViewSnapshot,
  reports: ReadonlyArray<TableReport>,
  onProgress: (message: string) => void,
): Promise<void> {
  if (!(await objectExists(client, FLOW_STATE_TABLE)) || !(await objectExists(client, 'jira_issues'))) {
    onProgress(`${FLOW_VIEW}: skipped — its source or target table is not in this database`);
    return;
  }

  const stateHasOrg = await columnExists(client, FLOW_STATE_TABLE, ORG_COLUMN);
  const issuesHasOrg = await columnExists(client, 'jira_issues', ORG_COLUMN);

  let definition: string;
  if (stateHasOrg && issuesHasOrg) {
    definition = readFlowViewStatement();
  } else if (!stateHasOrg && snapshot.existed) {
    // A partial run: the loop aborted before it reached the state table. Put back
    // exactly what was there. The old definition never mentions organization_id,
    // so it stays valid whether or not jira_issues was rebuilt.
    definition = snapshot.originalDdl;
  } else if (!stateHasOrg) {
    // Nothing was there to restore, and nothing changed shape.
    return;
  } else {
    throw new Error(
      `${FLOW_VIEW} cannot be recreated: ${FLOW_STATE_TABLE} is tenant-keyed but ${DB}.jira_issues is not, ` +
      'so neither the old nor the new definition would write correct rows. ' +
      (snapshot.existed
        ? `THE VIEW IS CURRENTLY DROPPED — the aggregate will not track new issues until it is back. ` +
          `Rebuild jira_issues and re-run, or restore the view by hand with:\n${snapshot.originalDdl}`
        : 'Rebuild jira_issues and re-run.'),
    );
  }

  await client.command({ query: definition });
  onProgress(`${FLOW_VIEW}: recreated (${stateHasOrg ? 'tenant-aware' : 'as-found'} definition)`);

  await repairFlowStateGap(client, snapshot, reports, definition, onProgress);
}

/**
 * Re-derives the aggregate when — and only when — it is behind.
 *
 * Two triggers, both meaning "the states in the table cannot be trusted as the
 * whole story":
 *
 * 1. jira_issues changed while the view was down. The view does not backfill, so
 *    those issues are absent from the aggregate for good otherwise. This is the
 *    path an aborted run takes.
 * 2. the rebuilt state table came out empty, so there was nothing to preserve.
 *
 * Anything else must NOT re-derive: the table loop already copied the existing
 * AggregateFunction states across (selected by name, never through a *Merge), and
 * a re-derive on top of them counts every issue twice — the R2 trap. TRUNCATE
 * first for the same reason.
 */
async function repairFlowStateGap(
  client: ChExec,
  snapshot: FlowViewSnapshot,
  reports: ReadonlyArray<TableReport>,
  definition: string,
  onProgress: (message: string) => void,
): Promise<void> {
  const stateReport = reports.find((r) => r.table === FLOW_STATE_TABLE);
  const rebuiltEmpty = stateReport !== undefined
    && stateReport.skipped === undefined
    && stateReport.rowsAfter === 0;

  const now = await fingerprintIssues(client);
  const wroteWhileViewWasDown = snapshot.existed
    && (now.rows !== snapshot.issuesRows || now.watermark !== snapshot.issuesWatermark);

  if (!wroteWhileViewWasDown && !rebuiltEmpty) return;
  if (now.rows === 0) return;

  // Positional INSERT: the view's SELECT list is written in the state table's
  // column order, so a drift is a type error rather than a silent misalignment.
  const select = definition.match(/\bAS\s+(SELECT[\s\S]*)$/i)?.[1];
  if (select === undefined) {
    throw new Error(
      `${FLOW_STATE_TABLE} is behind and needs re-deriving, but the SELECT body of ${FLOW_VIEW} ` +
      `could not be read from:\n${definition}`,
    );
  }

  await client.command({ query: `TRUNCATE TABLE ${DB}.${FLOW_STATE_TABLE}` });
  await client.command({ query: `INSERT INTO ${DB}.${FLOW_STATE_TABLE} ${select}` });

  onProgress(
    wroteWhileViewWasDown
      ? `${FLOW_STATE_TABLE}: jira_issues changed while ${FLOW_VIEW} was down ` +
        `(${snapshot.issuesRows} rows/"${snapshot.issuesWatermark}" → ${now.rows} rows/"${now.watermark}") — ` +
        'the whole aggregate was re-derived to close the gap'
      : `${FLOW_STATE_TABLE}: was empty, re-derived from jira_issues`,
  );
}

export async function migrateChToOrgTenancy(opts: MigrateOpts): Promise<TableReport[]> {
  const { client, organizationId, onProgress = () => {} } = opts;
  if (organizationId.trim() === '') {
    throw new Error(
      'migrateChToOrgTenancy: organizationId is required and must be non-empty. Rows stamped with ' +
      "'' match no tenant predicate, and Code 420 forbids correcting a key column afterwards.",
    );
  }

  const tables = opts.tables ?? CH_TENANT_TABLES;
  const rebuildsFlowState = tables.some((t) => t.table === FLOW_STATE_TABLE);

  await assertFlowViewRestorable(client, tables);
  const snapshot = await captureFlowView(client);

  // Step 1: drop the view before ANY rebuild.
  //
  // Not because EXCHANGE TABLES orphans it — measured, and it does not: the MV
  // dependency follows the table NAME, so the view stays attached to whatever
  // cockpit.jira_issues is after the swap. The reason is what that surviving view
  // would write. Its old definition selects no organization_id, so for as long as
  // it is attached, any ingest lands state rows that either do not match a rebuilt
  // state table or arrive stamped '' in a key column, where Code 420 makes them
  // uncorrectable. Dropping first makes the window well-defined no matter which
  // table the loop reaches first; the restore below closes it again. Dropping the
  // view does not touch the state table's data.
  if (snapshot.existed) {
    await client.command({ query: `DROP VIEW IF EXISTS ${DB}.${FLOW_VIEW}` });
    onProgress(`${FLOW_VIEW}: dropped (restored after the rebuild)`);
  }

  // Step 2: the ordinary table loop, which includes the state table.
  const reports: TableReport[] = [];
  let failure: unknown;
  try {
    for (const entry of tables) {
      reports.push(await rebuildTable(client, entry, organizationId, onProgress));
    }
  } catch (err) {
    failure = err;
  }

  // Step 3, on EVERY exit path — success or failure. A dropped view left behind
  // by an aborted run is a data-loss path, not an inconvenience: the aggregate
  // silently stops tracking everything ingested from that moment on, and a
  // re-run would find an already-tenant-keyed state table and do nothing.
  if (snapshot.existed || rebuildsFlowState) {
    try {
      await restoreFlowView(client, snapshot, reports, onProgress);
    } catch (restoreErr) {
      if (failure === undefined) throw restoreErr;
      throw new Error(
        `${describeError(failure)}\n\nAND ${FLOW_VIEW} could not be restored afterwards: ` +
        describeError(restoreErr),
        { cause: failure },
      );
    }
  }

  if (failure !== undefined) throw failure;

  // Step 4: re-apply the row-policy baseline, after every swap.
  //
  // What this achieves: EXCHANGE TABLES puts a freshly created table under each
  // live name, and a table that was created after the last baseline carries no
  // row policy — ClickHouse row policies are permissive, so it would be readable
  // in full by any identity. This pass covers the post-swap tables under their
  // live names, and re-admits the configured service identity along with the
  // deny (see applyRowPolicyBaseline).
  //
  // What it explicitly does NOT achieve: it does not close the scratch-table
  // exposure window. Every `__v2` is already gone by the time this runs — dropped
  // on the failure path (line ~304) and after the swap (line ~315) — and on a
  // failed rebuild `throw failure` above returns before Step 4 is reached at all.
  // So no run of this pass ever sees a `__v2` to cover. **The scratch tables are
  // uncovered for as long as they exist, and what keeps that safe is the rollout
  // stopping ingest and admitting only the operator — a procedure, not this
  // code.** Anyone tempted to relax that procedure should not point at this call
  // as the mitigation.
  //
  // Non-fatal: this script's job is the data rebuild, and it has already
  // completed and verified row counts by here. Failing the run at this point
  // would report a rebuild that actually succeeded as failed. The pass is
  // mandatory in runClickhouseMigrations, which is where "no isolation" must
  // stop a deploy.
  try {
    const coverage = await applyRowPolicyBaseline(chExecutorFromClient(client));
    onProgress(`row policies: ${coverage.denied.length} objects covered by the catch-all deny`);
    if (coverage.needsReprovision.length > 0) {
      onProgress(
        `row policies: ${coverage.needsReprovision.length} tenant object(s) still need ` +
        `per-organization predicates — re-provision before expecting analytics to return rows`,
      );
    }
  } catch (policyErr) {
    onProgress(
      `WARNING: tables rebuilt, but the row-policy baseline could not be applied: ` +
      `${describeError(policyErr)}. New objects are unprotected until it runs.`,
    );
  }

  return reports;
}

/**
 * The materialized-view half on its own: drop the view, rebuild the state table,
 * recreate the view. Same ordered unit the full migration runs, narrowed to the
 * one table the view writes into.
 *
 * Only valid once jira_issues is tenant-keyed — on an untouched database the view
 * it would have to put back cannot be created (Code 47). That is checked before
 * anything is dropped, so calling this out of order refuses rather than leaving
 * the view down.
 */
export async function migrateChMaterializedViews(opts: MigrateOpts): Promise<TableReport[]> {
  const entry = CH_TENANT_TABLES.find((t) => t.table === FLOW_STATE_TABLE);
  if (entry === undefined) {
    throw new Error(`${FLOW_STATE_TABLE} is missing from CH_TENANT_TABLES`);
  }
  return migrateChToOrgTenancy({ ...opts, tables: [entry] });
}

const USAGE = [
  'Rebuilds every ClickHouse tenant table with organization_id leading its sort key.',
  '',
  'Required environment:',
  '  CH_MIGRATE_URL     ClickHouse HTTP URL to migrate, e.g. http://user:pass@localhost:8123/cockpit',
  '  CH_MIGRATE_ORG_ID  organization that owns the rows already in that database',
  '',
  'There is deliberately no default target: this script drops and replaces tables,',
  'so the database has to be named explicitly every time.',
].join('\n');

async function runFromCli(): Promise<void> {
  const url = process.env.CH_MIGRATE_URL ?? '';
  const organizationId = process.env.CH_MIGRATE_ORG_ID ?? '';
  if (url.trim() === '' || organizationId.trim() === '') {
    console.error(USAGE);
    process.exit(1);
  }

  // Built here rather than imported from ../clickhouse.js on purpose: that
  // module falls back to a hard-coded localhost:8123 when CLICKHOUSE_URL is
  // unset, which would let a destructive run default onto a live database.
  const { createClient } = await import('@clickhouse/client');
  const client = createClient({ url });
  try {
    const report = await migrateChToOrgTenancy({
      client: client as unknown as ChExec,
      organizationId,
      onProgress: (m) => console.log(`  ✓ ${m}`),
    });
    console.table(report);
  } finally {
    await client.close();
  }
}

// Guard the entry point so importing this module (as the test and Task 4 do)
// never triggers a live run.
if (require.main === module) {
  runFromCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
