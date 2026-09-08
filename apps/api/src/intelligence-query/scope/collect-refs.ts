import type { AST } from 'node-sql-parser';

export interface TableRef {
  /** Base table name, lowercased. */
  tableName: string;
  /** Query alias (`AS foo`), or null when no alias is given. */
  alias: string | null;
  /** The SELECT AST node whose FROM clause contains this reference.
   *  The rewriter will inject scope predicates into this node's WHERE. */
  enclosingSelect: unknown;
}

/**
 * Walk a parsed SQL AST and return every base-table reference found,
 * including those inside `FROM` subqueries, CTEs, UNION branches, and every
 * OTHER subquery position node-sql-parser can produce — the SELECT-list,
 * `WHERE` (`IN`, `EXISTS`, `NOT EXISTS`), `HAVING`, `ORDER BY`, `GROUP BY`,
 * `JOIN ... ON`, `LIMIT`, and nested subqueries within any of those. Each
 * such subquery gets its own `enclosingSelect`, so the rewriter injects a
 * scope predicate into ITS OWN `WHERE`, not the outer query's.
 *
 * CTE alias references in outer SELECTs are skipped — they are not base
 * tables and do not need scope injection.
 *
 * Multi-statement arrays (e.g. `SELECT 1; SELECT 2`) are defensively
 * rejected by returning an empty array; the validator rejects them before
 * we reach this point in normal operation.
 */
export function collectTableRefs(ast: AST | AST[]): TableRef[] {
  if (Array.isArray(ast)) return [];

  const refs: TableRef[] = [];
  walkSelect(ast, new Set<string>(), refs);
  return dedupeRefs(refs);
}

/**
 * Dedupe accumulated refs on the triple (tableName, alias, enclosingSelect
 * identity) — object identity for `enclosingSelect`, not deep equality.
 *
 * This is what makes the generic deep scan in `walkSelect` safe to
 * over-reach: a `FROM` subquery is reached once by the explicit `from`
 * handling and again by the generic scan (since `from` is not skipped, to
 * reach `JOIN ON` subqueries nested inside it), and this collapses the two
 * back into one ref rather than double-injecting the same predicate.
 */
function dedupeRefs(refs: TableRef[]): TableRef[] {
  const identities = new WeakMap<object, number>();
  let nextId = 0;
  const seen = new Set<string>();
  const out: TableRef[] = [];

  for (const ref of refs) {
    const selectObj = ref.enclosingSelect as object;
    let id = identities.get(selectObj);
    if (id === undefined) {
      id = nextId++;
      identities.set(selectObj, id);
    }
    const key = `${id} ${ref.tableName} ${ref.alias ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// ─── Internal types ───────────────────────────────────────────────────────────

type SelectNode = Record<string, unknown>;

interface CteEntry {
  name: { type: string; value: string } | string;
  stmt: unknown;
  columns: unknown;
}

interface FromEntry {
  table?: string | null;
  as?: string | null;
  db?: string | null;
  expr?: unknown;
  join?: string;
  on?: unknown;
  prefix?: unknown;
}

// ─── Walker ───────────────────────────────────────────────────────────────────

/**
 * Walk a SELECT node (or UNION chain) collecting table refs.
 *
 * @param node         The current SELECT-shaped AST node.
 * @param cteAliases   Set of CTE alias names defined in outer scope (lowercased).
 * @param refs         Accumulator for discovered TableRef entries.
 */
function walkSelect(node: unknown, cteAliases: Set<string>, refs: TableRef[]): void {
  if (node === null || typeof node !== 'object') return;

  const n = node as SelectNode;
  if (n['type'] !== 'select') return;

  // ── Build local CTE alias set ─────────────────────────────────────────────
  // Extend the inherited set with CTEs defined on this SELECT node.
  const localCteAliases = new Set(cteAliases);
  const withs = (n['with'] as CteEntry[] | null) ?? [];

  for (const w of withs) {
    const name = extractCteName(w.name);
    if (name) localCteAliases.add(name.toLowerCase());
  }

  // ── Walk CTE bodies ───────────────────────────────────────────────────────
  // Each CTE body is itself a SELECT; walk it with the current local alias set
  // so inner CTEs can reference outer ones correctly.
  for (const w of withs) {
    walkSelect(w.stmt, localCteAliases, refs);
  }

  // ── Walk FROM clause of this SELECT ───────────────────────────────────────
  const fromList = (n['from'] as FromEntry[] | null) ?? [];

  for (const f of fromList) {
    if (typeof f.table === 'string') {
      // Plain table reference (base table or CTE alias reference).
      //
      // Schema-qualified names: node-sql-parser places the qualifier in
      // `f.db`. We accept the single literal qualifier `cockpit` (our own
      // schema — emitted by the builder helpers in widgets/unions.ts and
      // by several intelligence-query builders) and route it through the
      // bare-name catalog lookup. Any other qualifier (e.g.
      // `evilschema.github_pull_requests`, `system.tables`) is recorded
      // with the prefix so the catalog miss surfaces as OUT_OF_CATALOG —
      // this is the schema-confusion guard that stops a scope-rewritten
      // query from silently reading the wrong schema.
      if (f.db != null && f.db.toLowerCase() !== 'cockpit') {
        refs.push({
          tableName: `${f.db}.${f.table}`,
          alias: f.as ?? null,
          enclosingSelect: n,
        });
        continue;
      }

      const lower = f.table.toLowerCase();
      if (!localCteAliases.has(lower)) {
        refs.push({
          tableName: lower,
          alias: f.as ?? null,
          enclosingSelect: n,
        });
      }
    } else if (f.expr !== undefined && f.expr !== null) {
      // Subquery in FROM: { expr: { ast: { type: 'select', ... } }, as: '...' }
      const exprNode = f.expr as Record<string, unknown>;
      const innerAst = exprNode['ast'] as unknown;
      if (innerAst !== null && typeof innerAst === 'object') {
        walkSelect(innerAst, localCteAliases, refs);
      }
    }
  }

  // ── Deep-scan every OTHER position for nested SELECTs ─────────────────────
  // node-sql-parser puts a subquery wherever an expression can go: the
  // SELECT-list, WHERE (IN / EXISTS / NOT EXISTS), HAVING, ORDER BY,
  // GROUP BY, a JOIN's ON clause (nested inside `from`, so `from` is NOT
  // skipped here even though it was already walked above), and LIMIT — and
  // it nests arbitrarily deep inside function calls and CASE expressions
  // (`columns.[0].expr.args.[0].cond.right.ast`). No hand-written list of
  // sub-paths survives that, so this scans every property generically.
  //
  // `with` and `_next` are skipped: both are already walked explicitly,
  // above, each with a DIFFERENT alias scope (`with` bodies get
  // `localCteAliases`; `_next` gets the inherited `cteAliases`, because
  // UNION branches share the outer CTE scope). Reaching them again here
  // would walk them with the wrong scope.
  //
  // Reaching a `from` subquery twice (once above, once here) is harmless:
  // `collectTableRefs` dedupes the accumulated refs by
  // (tableName, alias, enclosingSelect identity).
  for (const [key, value] of Object.entries(n)) {
    if (key === 'with' || key === '_next') continue;
    const nested: SelectNode[] = [];
    scanForNestedSelects(value, 0, nested);
    for (const sel of nested) {
      walkSelect(sel, localCteAliases, refs);
    }
  }

  // ── Walk UNION branch (_next) ─────────────────────────────────────────────
  // node-sql-parser represents UNION / UNION ALL as a linked list via `_next`.
  // Each `_next` node is a full SELECT; use the same inherited aliases (not
  // the local ones — UNION branches share the outer CTE scope).
  if (n['_next'] !== undefined && n['_next'] !== null) {
    walkSelect(n['_next'], cteAliases, refs);
  }
}

/**
 * Recursively scan an arbitrary AST fragment for nested SELECT nodes,
 * accepting both wrapper shapes node-sql-parser uses: a node that IS itself
 * `{ type: 'select' }`, and a node with an `ast` property holding one
 * (`limit.value.[0]` is the bare form; every other measured position is the
 * `.ast` form).
 *
 * Stops descending the moment it finds a nested SELECT — that subtree
 * belongs to `walkSelect`, including its OWN `with` / `from` / `_next` — so
 * a select nested inside a select found here is picked up when `walkSelect`
 * runs on it, not by this scan going deeper.
 *
 * Depth-capped so a pathological (or adversarially deep) AST cannot spin.
 */
const MAX_SCAN_DEPTH = 60;

function scanForNestedSelects(node: unknown, depth: number, found: SelectNode[]): void {
  if (depth > MAX_SCAN_DEPTH) return;
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) scanForNestedSelects(item, depth + 1, found);
    return;
  }

  const select = unwrapSelectNode(node);
  if (select) {
    found.push(select);
    return;
  }

  for (const value of Object.values(node as Record<string, unknown>)) {
    scanForNestedSelects(value, depth + 1, found);
  }
}

/**
 * Unwrap a node to the SELECT it holds, accepting either the bare form
 * (`node` itself is `{ type: 'select' }`) or the wrapped form
 * (`node.ast` is `{ type: 'select' }`). Returns null for neither.
 */
function unwrapSelectNode(node: object): SelectNode | null {
  const n = node as SelectNode;
  if (n['type'] === 'select') return n;

  const inner = n['ast'];
  if (inner !== null && typeof inner === 'object' && (inner as SelectNode)['type'] === 'select') {
    return inner as SelectNode;
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the string value from a CTE name node.
 *  node-sql-parser emits CTE names as `{ type: 'default', value: 'foo' }`. */
function extractCteName(name: unknown): string | null {
  if (typeof name === 'string') return name;
  if (name !== null && typeof name === 'object') {
    const n = name as Record<string, unknown>;
    if (typeof n['value'] === 'string') return n['value'];
  }
  return null;
}
