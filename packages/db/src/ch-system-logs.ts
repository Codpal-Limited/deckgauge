/**
 * ClickHouse's own abandoned log tables, and the sweep that removes them.
 *
 * When a system log's schema changes between server versions, ClickHouse
 * RENAMES the old table aside — `query_log` becomes `query_log_0` — and creates
 * a fresh one in its place. Nothing ever removes the renamed copy, and the TTLs
 * in `clickhouse/config/system-logs.xml` bind only the CURRENT table, so the old
 * one grows to whatever it reached and then sits there forever.
 *
 * Measured on both servers this repo owns: ~46 MiB and 58% of all system tables
 * on the test server, and 150 MiB in `text_log_0` alone on staging. Nothing
 * reads them. A config file cannot express the cleanup — there is no node for a
 * table that no longer has a config entry — so it is a DDL sweep.
 */

/**
 * ONE pattern, shared by the query and the guard.
 *
 * They disagreed before, and the consequence was not cosmetic: the query used
 * an unanchored prefix while the guard allowed no digits in it, so a
 * renamed-aside `s3queue_log_0` — ClickHouse ships `system.s3queue_log` —
 * satisfied the query and was REFUSED by the guard. Because the guard refuses
 * the whole list rather than filtering, one such table meant ZERO tables swept,
 * and the `catch` made that silent. Deriving both from this constant is what
 * makes "the query cannot return something the guard rejects" true by
 * construction instead of by inspection.
 *
 * Digits are allowed in the prefix, letters and underscores too, and nothing
 * else — no quotes, no semicolons, no dots — which is what makes interpolating
 * a matched name into DDL safe. Anchored at BOTH ends, and each anchor earns
 * its place: without `$`, `query_log_0_foo` — not a shape ClickHouse produces,
 * but not one to drop either — is swept; without `^`,
 * `x; DROP TABLE cockpit.jira_issues; --query_log_0` matches.
 *
 * `_log_<digits>` at the END is the whole discriminator, and it is the reason
 * this is safe at all: the live tables are `query_log`, `part_log`, `error_log`
 * and so on, with no numeric suffix.
 */
const ORPHANED_LOG_PATTERN = '^[a-z0-9_]+_log_[0-9]+$';

/** The renamed-aside tables currently on the server. */
export const ORPHANED_SYSTEM_LOG_QUERY = `
  SELECT name
  FROM system.tables
  WHERE database = 'system' AND match(name, '${ORPHANED_LOG_PATTERN}')
  ORDER BY name
`.trim();

/** `part_log_0`, `query_log_12`, `s3queue_log_0` — never `query_log`. */
const ORPHANED_LOG_NAME = new RegExp(ORPHANED_LOG_PATTERN);

/**
 * `DROP TABLE` for each named table, refusing anything that is not a
 * renamed-aside system log.
 *
 * The guard is HERE rather than trusted to the query, and that placement is the
 * point: this produces `DROP TABLE` against a live staging server, the caller
 * supplies the names, and a query can be edited by someone who has not read this
 * file. A live `query_log` — which this repo deliberately keeps with a 3-day TTL
 * — must not be droppable however it is asked for.
 *
 * Refusing rather than filtering, because a name that reaches here and does not
 * match means the caller's idea of the input and this function's disagree. A
 * silent skip would sweep some tables and quietly leave others, which is
 * indistinguishable from a clean server.
 */
export function orphanedSystemLogDropDdl(names: readonly string[]): string[] {
  return names.map((name) => {
    if (!ORPHANED_LOG_NAME.test(name)) {
      throw new Error(
        `refusing to drop ${JSON.stringify(name)}: not a renamed-aside system log ` +
          `(expected <name>_log_<digits>, e.g. query_log_0)`,
      );
    }
    return `DROP TABLE IF EXISTS system.${name}`;
  });
}
