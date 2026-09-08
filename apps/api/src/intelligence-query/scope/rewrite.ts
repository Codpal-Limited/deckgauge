import type { AST } from 'node-sql-parser';
import { collectTableRefs } from './collect-refs.js';
import { getCatalogEntry, NARROWING_KEY, SCOPE_KEY, type CatalogEntry } from './catalog.js';
import { escapeChLiteral } from './literal.js';
import type { ResolvedScope } from './resolve-scope.js';

// ─── Public error class ──────────────────────────────────────────────────────

export class ScopeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ScopeError';
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Mutate `ast` in place, injecting `<qualifier>.<scopeColumn> IN (<values>)`
 * into the WHERE clause of the immediately-enclosing SELECT for every
 * base-table reference found by `collectTableRefs`.
 *
 * Throws `ScopeError` if:
 *  - `ast` is an array (multi-statement) → code `'MULTI_STATEMENT'`
 *  - a table is not in the catalog → code `'OUT_OF_CATALOG'`
 *  - the matching scope array is empty → code `'EMPTY_SCOPE'`
 */
export function rewriteWithScope(ast: AST | AST[], scope: ResolvedScope): void {
  if (Array.isArray(ast)) {
    throw new ScopeError('Only single SELECT statements are allowed.', 'MULTI_STATEMENT');
  }

  const refs = collectTableRefs(ast);

  for (const ref of refs) {
    const entry = getCatalogEntry(ref.tableName);
    if (!entry) {
      throw new ScopeError(
        `Table '${ref.tableName}' is not available on this board.`,
        'OUT_OF_CATALOG',
      );
    }

    const allowed = scope[SCOPE_KEY[entry.sourceType]];
    if (allowed.length === 0) {
      throw new ScopeError(
        `This board has no ${entry.sourceType} sources attached.`,
        'EMPTY_SCOPE',
      );
    }

    const qualifier = ref.alias ?? ref.tableName;
    // `NARROWING_KEY` is keyed off the catalog's source types, so a table whose
    // entry declares no `narrowColumn` — and a source type with no second
    // dimension at all — falls through to the plain IN predicate unchanged.
    const narrowKey = NARROWING_KEY[entry.sourceType];
    const narrowing = narrowKey ? scope[narrowKey] : undefined;
    injectPredicateIn(
      ref.enclosingSelect,
      buildScopePredicate(qualifier, entry, allowed, narrowing),
    );
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Build a `<qualifier>.<column> IN (<values>)` predicate node using the AST
 * shape that node-sql-parser's postgresql sqlify expects.
 *
 * Key subtleties discovered by inspection:
 *  - `column` must be `{ expr: { type: 'default', value: '<name>' } }`, not a
 *    plain string — sqlify reads that inner shape to emit the column name.
 *  - String values must be pre-escaped because sqlify emits
 *    `single_quote_string` values verbatim (no escaping pass) — see
 *    {@link escapeChLiteral}.
 */
function buildInPredicate(
  qualifier: string,
  column: string,
  values: readonly string[],
): Record<string, unknown> {
  return {
    type: 'binary_expr',
    operator: 'IN',
    left: {
      type: 'column_ref',
      table: qualifier,
      column: { expr: { type: 'default', value: column } },
      collate: null,
    },
    right: {
      type: 'expr_list',
      value: values.map((v) => ({
        type: 'single_quote_string',
        value: escapeChLiteral(v),
      })),
    },
  };
}

/**
 * A binary node, always PARENTHESISED.
 *
 * The parentheses are load-bearing rather than cosmetic. sqlify emits them from
 * this flag alone, and without it the injected disjunction serialises as
 * `<user where> AND a OR b`, which re-parses — and executes — as
 * `(<user where> AND a) OR b`: a predicate that admits every row `b` matches,
 * from any project. `assertEveryRefIsScoped` refuses that shape, so the failure
 * mode is a 500 rather than a leak, but the SQL would still be wrong.
 */
function buildBinary(
  operator: 'AND' | 'OR',
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  return { type: 'binary_expr', operator, left, right, parentheses: true };
}

/**
 * The scope predicate for one table reference.
 *
 * With no narrowing this is today's plain `scopeColumn IN (…)`, byte-identical.
 * With narrowing it is a disjunction in which EVERY branch constrains
 * `scopeColumn` — one branch carrying all unnarrowed projects, plus one branch
 * per narrowed project pairing that project with its allowed values.
 *
 * Every branch constraining the scope column is what lets `assert.ts` accept
 * this shape soundly. A branch that constrained only the narrow column would
 * admit rows from any project.
 */
function buildScopePredicate(
  qualifier: string,
  entry: CatalogEntry,
  allowed: readonly string[],
  narrowing: Record<string, string[]> | undefined,
): Record<string, unknown> {
  const narrowColumn = entry.narrowColumn;
  if (!narrowColumn || !narrowing) {
    return buildInPredicate(qualifier, entry.scopeColumn, allowed);
  }
  // Empty array means "no restriction", so it is NOT a narrowed project.
  const narrowed = allowed.filter((p) => (narrowing[p]?.length ?? 0) > 0);
  if (narrowed.length === 0) {
    return buildInPredicate(qualifier, entry.scopeColumn, allowed);
  }
  const unnarrowed = allowed.filter((p) => !narrowed.includes(p));
  const branches: Array<Record<string, unknown>> = [];
  if (unnarrowed.length > 0) {
    branches.push(buildInPredicate(qualifier, entry.scopeColumn, unnarrowed));
  }
  for (const project of narrowed) {
    branches.push(
      buildBinary(
        'AND',
        buildInPredicate(qualifier, entry.scopeColumn, [project]),
        buildInPredicate(qualifier, narrowColumn, narrowing[project]!),
      ),
    );
  }
  return branches.reduce((left, right) => buildBinary('OR', left, right));
}

/**
 * Inject a prebuilt scope predicate into the WHERE clause of a SELECT node.
 * Combines with any existing WHERE via AND (existing condition on the left).
 *
 * **The user's clause is PARENTHESISED, and that is a security requirement.**
 * Without it, `WHERE a OR b` serialised as `a OR b AND <injected>`, which
 * ClickHouse reads as `a OR (b AND <injected>)` — every row `a` matches,
 * unscoped. Worse, node-sql-parser does NOT model SQL's precedence here, so
 * `assertEveryRefIsScoped` could not see it: measured on this dialect,
 * `a OR b AND c` re-parses with `AND` at the root (`(a OR b) AND c`) for bare
 * identifiers and with `OR` at the root for `IN` predicates — the second line's
 * model of the string diverged from the executor's, in both directions. A
 * parenthesised left operand is unambiguous under any precedence, so the
 * injected conjunct is always on the emitted top-level AND spine and the user's
 * clause can only ever narrow.
 *
 * `parentheses: true` is honoured on every WHERE node shape sqlify emits
 * (binary_expr, unary_expr, column_ref, function, EXISTS), so this needs no
 * per-type branch.
 */
function injectPredicateIn(selectNode: unknown, predicate: Record<string, unknown>): void {
  if (selectNode === null || typeof selectNode !== 'object') return;

  const n = selectNode as Record<string, unknown>;
  const existing = n['where'];

  if (existing !== null && existing !== undefined) {
    if (typeof existing === 'object') {
      (existing as Record<string, unknown>)['parentheses'] = true;
    }
    n['where'] = {
      type: 'binary_expr',
      operator: 'AND',
      left: existing,
      right: predicate,
    };
  } else {
    n['where'] = predicate;
  }
}
