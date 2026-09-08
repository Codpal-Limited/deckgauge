import { parseSelect } from './parser.js';
import { collectTableRefs } from './collect-refs.js';
import { getCatalogEntry, NARROWING_KEY, SCOPE_KEY } from './catalog.js';
import { escapeChLiteral } from './literal.js';
import type { ResolvedScope } from './resolve-scope.js';

export class AssertError extends Error {
  constructor() {
    super('Scope enforcement failed. This is a bug; please report.');
    this.name = 'AssertError';
  }
}

/**
 * Second-line defense: re-parse `sql` (post-rewrite) and assert that every
 * cataloged table reference has its `scopeColumn` in an IN predicate within
 * the nearest enclosing WHERE clause.
 *
 * When `scope` names a NARROWED project for a table that declares a
 * `narrowColumn`, the bar is higher: the WHERE clause must carry the rewriter's
 * own injected conjunct, in which every branch constrains `scopeColumn` with
 * VALUES the board actually has and every narrowed project carries a
 * `narrowColumn IN` predicate confined to its own allow-list. That shape is
 * recognised by a SEPARATE walker — see {@link isInjectedScopeDisjunction} for
 * why `containsInOnColumn` must not be relaxed to accept it, and why the
 * walker compares values rather than shapes.
 *
 * `scope` is optional so every existing caller and test keeps compiling; a call
 * without it enforces exactly the pre-existing rule.
 *
 * Throws `AssertError` with a deliberately generic message on any violation
 * so that attackers cannot probe which check caught them.
 */
export function assertEveryRefIsScoped(sql: string, scope?: ResolvedScope): void {
  let parsed: ReturnType<typeof parseSelect>;
  try {
    parsed = parseSelect(sql);
  } catch {
    throw new AssertError();
  }

  if (Array.isArray(parsed.ast)) throw new AssertError();

  const refs = collectTableRefs(parsed.ast);

  for (const ref of refs) {
    const entry = getCatalogEntry(ref.tableName);
    if (!entry) throw new AssertError();

    const selectNode = ref.enclosingSelect as Record<string, unknown> | null;

    const narrowKey = NARROWING_KEY[entry.sourceType];
    const narrowing = narrowKey && scope ? scope[narrowKey] : undefined;
    // "Empty means all" — a project mapped to an empty array is unnarrowed, so
    // it demands nothing beyond the pre-existing rule.
    //
    // Every value is held in its ESCAPED form, because that is what a re-parsed
    // literal is: node-sql-parser reports `'it''s'` as `it''s`. See
    // `literal.ts`.
    const narrowedValues = new Map<string, ReadonlySet<string>>(
      Object.entries(narrowing ?? {})
        .filter(([, values]) => values.length > 0)
        .map(([project, values]) => [
          escapeChLiteral(project),
          new Set(values.map(escapeChLiteral)) as ReadonlySet<string>,
        ]),
    );

    if (entry.narrowColumn !== undefined && narrowedValues.size > 0 && scope) {
      const narrowColumn = entry.narrowColumn;
      const allowed = new Set(scope[SCOPE_KEY[entry.sourceType]].map(escapeChLiteral));
      if (
        !whereHasConjunct(selectNode?.['where'], (conjunct) =>
          isInjectedScopeDisjunction(
            conjunct,
            entry.scopeColumn,
            narrowColumn,
            allowed,
            narrowedValues,
          ),
        )
      ) {
        throw new AssertError();
      }
      continue;
    }

    if (!containsInOnColumn(selectNode?.['where'], entry.scopeColumn)) {
      throw new AssertError();
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Test each conjunct of a WHERE clause's top-level AND spine with `predicate`.
 *
 * The whole node is offered FIRST and the spine walked only afterwards, because
 * the injected conjunct is itself an AND when a board has exactly one narrowed
 * project and nothing unnarrowed (`project_key IN ('RDRR') AND key IN (…)`) —
 * splitting first would hand the predicate two halves neither of which is the
 * shape.
 *
 * The traversal is the same one `containsInOnColumn` performs: AND branches
 * only, so an OR halts it. The rewriter always ANDs its conjunct onto whatever
 * the user wrote, so that is the only place it can be.
 */
function whereHasConjunct(node: unknown, predicate: (conjunct: unknown) => boolean): boolean {
  if (node === null || node === undefined || typeof node !== 'object') return false;
  if (predicate(node)) return true;

  const n = node as Record<string, unknown>;
  if (n['type'] !== 'binary_expr') return false;
  if ((n['operator'] as string | undefined)?.toUpperCase() !== 'AND') return false;

  return whereHasConjunct(n['left'], predicate) || whereHasConjunct(n['right'], predicate);
}

/**
 * Recognises the rewriter's own injected conjunct, by VALUE and not merely by
 * shape: a disjunction in which every branch is either
 *
 *  - `scopeColumn IN (…)` naming only projects the board HAS and has NOT
 *    narrowed, or
 *  - `scopeColumn IN ('P') AND narrowColumn IN (…)` for exactly one narrowed
 *    project `P` the board has, with every narrow value inside `P`'s own
 *    allow-list.
 *
 * Kept separate from `containsInOnColumn` deliberately, and this is the whole
 * point of the split. That function halts on OR, so an OR in a scoping position
 * is rejected outright — the strictest possible rule, and the one user-authored
 * SQL must keep facing. Relaxing it would let a user satisfy the scope
 * requirement with a disjunction they cannot use today.
 *
 * **The value comparison is why the shape check alone was not enough, and it
 * was a measured leak rather than a theoretical one.** The first version took
 * only `narrowedProjects` and compared nothing against `allowed`, so
 * `WHERE project_key IN ('SECRET') OR project_key IN ('SECRET')` on a board
 * scoped to a narrowed `RDRR` was ACCEPTED — the recogniser blessed the USER's
 * own branches. `injectPredicateIn`'s parenthesisation now keeps the injected
 * conjunct on the top-level AND spine so a user's clause can only narrow, but a
 * second line of defence must not depend on the first being right: a branch
 * that names a project the board does not have is refused here on its own
 * terms.
 *
 * Exactly ONE project per AND branch, because that is what the rewriter emits.
 * Two would make the paired narrow list ambiguous, and guessing which project a
 * shared narrow list belongs to is how a check stops being one.
 */
function isInjectedScopeDisjunction(
  node: unknown,
  scopeColumn: string,
  narrowColumn: string,
  /** Escaped identifiers the board actually has, for this source type. */
  allowed: ReadonlySet<string>,
  /** Escaped project → its escaped allow-list; keys are the NARROWED projects. */
  narrowedValues: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (node === null || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (n['type'] !== 'binary_expr') return false;
  const op = (n['operator'] as string | undefined)?.toUpperCase();

  if (op === 'OR') {
    // BOTH branches, not either: one unconstrained branch admits every row it
    // matches, from any project.
    return (
      isInjectedScopeDisjunction(n['left'], scopeColumn, narrowColumn, allowed, narrowedValues) &&
      isInjectedScopeDisjunction(n['right'], scopeColumn, narrowColumn, allowed, narrowedValues)
    );
  }

  // Leaf: the unnarrowed branch. Every project must be on the board, and none
  // of them narrowed — a narrowed project here would come back unrestricted.
  const projects = inValuesOnColumn(node, scopeColumn);
  if (projects !== null) {
    return (
      projects.length > 0 &&
      projects.every((p) => allowed.has(p) && !narrowedValues.has(p))
    );
  }

  // Leaf: one narrowed project paired with its own allow-list.
  if (op === 'AND') {
    const named = inValuesOnColumn(n['left'], scopeColumn);
    if (named === null || named.length !== 1) return false;
    const project = named[0]!;
    if (!allowed.has(project)) return false;
    const permitted = narrowedValues.get(project);
    if (permitted === undefined) return false;
    const values = inValuesOnColumn(n['right'], narrowColumn);
    if (values === null || values.length === 0) return false;
    return values.every((v) => permitted.has(v));
  }
  return false;
}

/**
 * The string values of an `IN` predicate on `column`, or null when `node` is not
 * one. Mirrors `containsInOnColumn`'s matching rules exactly.
 */
function inValuesOnColumn(node: unknown, column: string): string[] | null {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (n['type'] !== 'binary_expr') return null;
  if ((n['operator'] as string | undefined)?.toUpperCase() !== 'IN') return null;
  const left = n['left'] as Record<string, unknown> | undefined;
  if (left?.['type'] !== 'column_ref' || !isMatchingColumn(left, column)) return null;
  const right = n['right'] as Record<string, unknown> | undefined;
  const values = (right?.['value'] as Array<Record<string, unknown>> | undefined) ?? [];
  return values.map((v) => String(v['value']));
}

/**
 * Recursively walk a WHERE-clause AST node looking for a `binary_expr` IN
 * predicate whose left-hand side is a `column_ref` matching `column`.
 * AND nodes are traversed on both branches; all other node types halt the walk.
 */
function containsInOnColumn(node: unknown, column: string): boolean {
  if (node === null || node === undefined || typeof node !== 'object') return false;

  const n = node as Record<string, unknown>;
  if (n['type'] !== 'binary_expr') return false;

  const op = (n['operator'] as string | undefined)?.toUpperCase();

  if (op === 'IN') {
    const left = n['left'] as Record<string, unknown> | undefined;
    return left?.['type'] === 'column_ref' && isMatchingColumn(left, column);
  }

  if (op === 'AND') {
    return (
      containsInOnColumn(n['left'], column) || containsInOnColumn(n['right'], column)
    );
  }

  return false;
}

/**
 * Return true when a `column_ref` node references the given column name
 * (case-insensitive).
 *
 * node-sql-parser represents a re-parsed column name as a plain string in the
 * `column` field. The rewriter (buildInPredicate) injects an in-memory shape
 * of `{ expr: { type: 'default', value: '<name>' } }`, but assertEveryRefIsScoped
 * always operates on freshly-parsed (post-rewrite serialized) SQL, so the plain
 * string branch is the only one exercised at runtime. The structured branch is
 * kept for defensive completeness.
 */
function isMatchingColumn(left: Record<string, unknown>, column: string): boolean {
  const col = left['column'];

  // Common path: node-sql-parser emits a plain string after parsing text SQL.
  if (typeof col === 'string') {
    return col.toLowerCase() === column.toLowerCase();
  }

  // Defensive: in-memory AST from buildInPredicate uses { expr: { type, value } }.
  if (col !== null && typeof col === 'object') {
    const c = col as Record<string, unknown>;
    const expr = c['expr'] as Record<string, unknown> | undefined;
    if (typeof expr?.['value'] === 'string') {
      return (expr['value'] as string).toLowerCase() === column.toLowerCase();
    }
    if (typeof c['value'] === 'string') {
      return (c['value'] as string).toLowerCase() === column.toLowerCase();
    }
  }

  return false;
}
