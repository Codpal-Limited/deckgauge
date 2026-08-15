// node-sql-parser ships a CommonJS UMD bundle. Under Node ESM (`"type":
// "module"`), only the default export is reliably available — named imports
// like `import { Parser } from 'node-sql-parser'` blow up at runtime with
// "does not provide an export named 'Parser'" even though TypeScript accepts
// them at compile time. Use the default + destructure pattern instead.
import sqlParser from 'node-sql-parser';
import type { AST, Option } from 'node-sql-parser';
const { Parser } = sqlParser as unknown as {
  Parser: new () => {
    astify: (sql: string, opt?: Option) => AST | AST[];
    sqlify: (ast: AST | AST[], opt?: Option) => string;
  };
};

export class ParseError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

// ─── ClickHouse masking pre-/post-pass ────────────────────────────────────────
//
// node-sql-parser with the postgresql dialect (closest broad-coverage option)
// rejects several ClickHouse-specific constructs. The pre-pass replaces each
// with a syntactically valid postgresql placeholder; the post-pass restores the
// originals in the serialised output.
//
// Rules applied (in order):
//
//  1. ClickHouse param markers `{name:Type}` / `{name:Array(T)}` / `{n:UInt32}`
//     → `(__chparam_name__)` — wrapped in parens so `IN {x:Array(String)}`
//     becomes `IN (__chparam_x__)`, which is valid SQL.
//
//  2. Double-paren aggregates `quantile(0.5)(col)` — ClickHouse's higher-order
//     aggregate syntax. Replace with `__chq_0_5__(col)` (plain identifier).
//
//  3. `lagInFrame(` → `lag(` — `lagInFrame` is ClickHouse's frame-aware lag;
//     the postgresql parser recognises `lag` as a window function but chokes on
//     the camelCase run of `lagInFrame` followed by a space+`(`.
//
//  4. `CAST(NULL AS Nullable(...))` → `NULL` — Nullable is ClickHouse-only.
//
//  5. `ARRAY JOIN expr AS alias` — ClickHouse lateral array expansion; no
//     postgresql equivalent. Remove the clause entirely.
//
//  6. `INTERVAL ident UNIT` → `INTERVAL '1' UNIT` — ClickHouse allows an
//     identifier as the interval magnitude; postgresql requires a string literal.
//     Only triggered when the token after INTERVAL is an identifier (not a
//     quoted string or number).
//     Also handles WEEK/WEEKS unit → DAY (postgresql's parser does not know WEEK).
//
//  7. ClickHouse array literals `[...]` in expression context (e.g. the second
//     argument to `hasAny(arrayMap(x -> ..., col), ['bug','defect'])`) → replace
//     the `['bug','defect']` with a plain tuple `('bug','defect')` that the
//     parser accepts.
//     The `x ->` arrow lambda inside arrayMap is masked by rule 1 (if it contains
//     a param) or handled by turning the whole function call argument into a
//     masked placeholder.
//
//  8. `<table> [AS <alias>] FINAL` → `<table> [AS <alias>]` — ClickHouse's
//     ReplacingMergeTree dedup modifier. Stripped before parsing and re-attached
//     on serialise.

interface Mask {
  placeholder: string;
  original: string;
}

// ── Rule 0: LIMIT {name:Type} — param in LIMIT position must become a numeric literal
// because postgresql LIMIT only accepts an integer, not a subexpression.
const LIMIT_PARAM_RE = /\bLIMIT\s+\{([a-zA-Z_][a-zA-Z0-9_]*):([A-Za-z0-9()_, ]+?)\}/gi;

// ── Rule 1: {name:Type} parameter markers ─────────────────────────────────────
// Wrapped in parens so IN {x:Array(String)} → IN (__chparam_x__).
const PARAM_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*):([A-Za-z0-9()_, ]+?)\}/g;

// ── Rule 2: quantile(p)(col) double-paren aggregate ──────────────────────────
// e.g. quantile(0.5)(cycle_time_hours) — the (0.5) part is the aggregate
// parameter, (cycle_time_hours) is the value expression.
const QUANTILE_RE = /\bquantile\s*\(\s*([\d.]+)\s*\)/g;

// ── Rule 3: lagInFrame → lag ──────────────────────────────────────────────────
const LAG_IN_FRAME_RE = /\blagInFrame\s*\(/g;

// ── Rule 4: CAST(NULL AS Nullable(...)) ──────────────────────────────────────
const NULLABLE_CAST_RE = /CAST\s*\(\s*NULL\s+AS\s+Nullable\s*\([^)]+\)\s*\)/gi;

// ── Rule 5: ARRAY JOIN clause ─────────────────────────────────────────────────
// Match from ARRAY JOIN to end of that logical clause (up to GROUP/ORDER/LIMIT
// or end of string). A simple line-boundary works because our builders always
// put ARRAY JOIN on its own line before GROUP BY.
const ARRAY_JOIN_RE = /ARRAY\s+JOIN\s+[^\n]+/gi;

// ── Rule 6a: INTERVAL ident-or-number UNIT ────────────────────────────────────
// Fires when the token after INTERVAL is an identifier OR a bare integer/decimal
// (ClickHouse accepts both; postgresql requires a quoted string literal).
// Does NOT fire when the magnitude is already a quoted literal.
const INTERVAL_IDENT_RE = /\bINTERVAL\s+([a-zA-Z_][a-zA-Z0-9_]*|\d+(?:\.\d+)?)\s+(WEEK|WEEKS|DAY|DAYS|HOUR|HOURS|MINUTE|MINUTES|SECOND|SECONDS)/gi;

// ── Rule 6b: INTERVAL 'n' WEEK(S) — WEEK/WEEKS not known to postgresql parser.
//            Replace WEEK with DAY (the value is still a dummy so semantics
//            don't matter — we only care about parseability).
const INTERVAL_WEEK_RE = /\bINTERVAL\s+'([^']+)'\s+(WEEK|WEEKS)\b/gi;

// ── Rule 7: ClickHouse array literals ['a','b'] in expression position ────────
// Heuristic: match [ followed by quoted string(s), numbers, or identifiers,
// optionally with commas, ending with ]. Does not match SQL array subscripts
// because those are [integer].
const CH_ARRAY_LITERAL_RE = /\[\s*'[^']*'(?:\s*,\s*'[^']*')*\s*\]/g;

// ── Rule 8: `FINAL` table modifier ───────────────────────────────────────────
// ClickHouse-only. Appears either directly after the table
// (`FROM cockpit.github_issues FINAL`) or after an alias
// (`FROM cockpit.jira_issues AS ji FINAL`). The postgresql grammar has neither
// form: the bare one only *appeared* to work because the parser mistook FINAL
// for a table alias (silently polluting the alias set collectTableRefs walks),
// and the aliased one is a hard syntax error. Strip the modifier and record the
// table reference that carried it so restore can re-attach it — execute.ts runs
// serialize() output directly, so dropping FINAL would silently reintroduce the
// ReplacingMergeTree duplicate rows it exists to remove.
const FINAL_MODIFIER_RE =
  /((?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*(?:\s+AS\s+[A-Za-z_]\w*)?)\s+FINAL\b/gi;

// Turns a captured table reference ("cockpit.jira_issues AS ji") into a regex
// tolerant of the serialiser's identifier quoting, which may be double quotes
// ("cockpit"."jira_issues" AS "ji") or backticks depending on the dialect option.
function tableRefPattern(ref: string): string {
  const quote = '["`]?';
  return ref
    .trim()
    .split(/\s+/)
    .map((token) =>
      token
        .split('.')
        .map((seg) => quote + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + quote)
        .join('\\.')
    )
    .join('\\s+');
}

function buildMasks(sql: string): { masked: string; masks: Mask[] } {
  const masks: Mask[] = [];
  let out = sql;

  // Rule 0: LIMIT {param:Type} → LIMIT 1  (LIMIT only accepts integer literals)
  // We use approach B: each LIMIT param gets a unique indexed placeholder stored
  // in masks with prefix __chLimitParam; the restore pass finds LIMIT 1 occurrences
  // in the serialised output in FIFO order and substitutes the originals.
  out = out.replace(LIMIT_PARAM_RE, (_full, name: string, spec: string) => {
    const idx = masks.filter((m) => m.placeholder.startsWith('__chLimitParam')).length;
    const placeholder = `__chLimitParam${idx}__`;
    masks.push({ placeholder, original: `{${name}:${spec}}` });
    return `LIMIT 1`;
  });

  // Rule 1: param markers → (__chparam_name__)
  out = out.replace(PARAM_RE, (_full, name: string, _spec: string) => {
    // placeholder includes the surrounding parens so IN {x:Array(T)} is valid
    const placeholder = `__chparam_${name}__`;
    const full = _full;
    if (!masks.find((m) => m.placeholder === placeholder)) {
      masks.push({ placeholder, original: full });
    }
    return `(${placeholder})`;
  });

  // Rule 2: quantile(p)( → __chq_<p-as-ident>__(
  out = out.replace(QUANTILE_RE, (full, p: string) => {
    const safe = p.replace('.', '_');
    const placeholder = `__chq_${safe}__`;
    if (!masks.find((m) => m.placeholder === placeholder)) {
      masks.push({ placeholder, original: `quantile(${p})` });
    }
    return placeholder;
  });

  // Rule 3: lagInFrame( → lag(  (no mask needed — lag is semantically close)
  out = out.replace(LAG_IN_FRAME_RE, () => 'lag(');
  // Record a sentinel so serialize can restore it
  if (/\blag\s*\(/.test(out) && sql.includes('lagInFrame')) {
    masks.push({ placeholder: '__chLagInFrame_sentinel__', original: 'lagInFrame(' });
  }

  // Rule 4: CAST(NULL AS Nullable(...)) → CAST(NULL AS TEXT)
  // We emit a postgresql-valid CAST that the parser accepts. Each Nullable CAST
  // gets a unique index so the restore can match them in FIFO order.
  // Using CAST(NULL AS TEXT) avoids the global-NULL collision that a bare NULL
  // replacement would cause (e.g. IS NOT NULL / IS NULL checks).
  out = out.replace(NULLABLE_CAST_RE, (full) => {
    const idx = masks.filter((m) => m.placeholder.startsWith('__chNullable')).length;
    const placeholder = `__chNullable${idx}__`;
    masks.push({ placeholder, original: full });
    return `CAST(NULL AS TEXT)`;
  });

  // Rule 5: ARRAY JOIN ... → remove
  out = out.replace(ARRAY_JOIN_RE, (full) => {
    if (!masks.find((m) => m.original === full)) {
      masks.push({ placeholder: `__chArrayJoin__`, original: full });
    }
    return '';
  });

  // Rule 6a: INTERVAL ident UNIT → INTERVAL '1' DAY
  out = out.replace(INTERVAL_IDENT_RE, (full, ident: string, unit: string) => {
    const idx = masks.filter((m) => m.placeholder.startsWith('__chIntervalIdent')).length;
    const placeholder = `__chIntervalIdent${idx}__`;
    masks.push({ placeholder, original: full });
    // Map WEEK/WEEKS to DAY since postgresql parser doesn't know WEEK unit
    const safeUnit = /^WEEKS?$/i.test(unit) ? 'DAY' : unit.toUpperCase();
    return `INTERVAL '1' ${safeUnit}`;
  });

  // Rule 6b: INTERVAL 'n' WEEK(S) → INTERVAL 'n' DAY
  out = out.replace(INTERVAL_WEEK_RE, (full, val: string) => {
    const idx = masks.filter((m) => m.placeholder.startsWith('__chIntervalWeek')).length;
    const placeholder = `__chIntervalWeek${idx}__`;
    masks.push({ placeholder, original: full });
    return `INTERVAL '${val}' DAY`;
  });

  // Rule 7: CH array literals ['a','b'] → ('a','b')
  out = out.replace(CH_ARRAY_LITERAL_RE, (full) => {
    const idx = masks.filter((m) => m.placeholder.startsWith('__chArrLit')).length;
    const placeholder = `__chArrLit${idx}__`;
    masks.push({ placeholder, original: full });
    // Replace [ with ( and ] with ) for a valid SQL tuple
    return full.replace('[', '(').replace(']', ')');
  });

  // Rule 8: `<table> [AS <alias>] FINAL` → `<table> [AS <alias>]`
  // Runs last so the ARRAY JOIN clause (rule 5) is already gone and cannot be
  // scanned for a spurious FINAL.
  out = out.replace(FINAL_MODIFIER_RE, (_full, tableRef: string) => {
    const idx = masks.filter((m) => m.placeholder.startsWith('__chFinal')).length;
    masks.push({ placeholder: `__chFinal${idx}__`, original: tableRef });
    return tableRef;
  });

  return { masked: out, masks };
}

function restoreMasks(serialised: string, masks: Mask[], originalSql: string): string {
  let out = serialised;

  // Restore Rule 3 (lagInFrame): replace lag( back to lagInFrame( where the
  // original SQL used lagInFrame. Use the sentinel to detect this case.
  const lagSentinel = masks.find((m) => m.placeholder === '__chLagInFrame_sentinel__');
  if (lagSentinel && originalSql.includes('lagInFrame(')) {
    out = out.replace(/\blag\s*\(/g, 'lagInFrame(');
  }

  // Restore Rule 0 (LIMIT param) — FIFO queue.
  // The masked SQL had LIMIT 1; the serialised output also has LIMIT 1.
  // Replace each occurrence of LIMIT 1 in order with the original param marker.
  // NOTE: collisions with a literal LIMIT 1 in user SQL are theoretically
  // possible but accepted as the lesser evil over approach A (magic literal).
  const limitMasks = masks.filter((m) => m.placeholder.startsWith('__chLimitParam'));
  if (limitMasks.length > 0) {
    let idx = 0;
    out = out.replace(/\bLIMIT\s+1\b/gi, () => {
      const entry = limitMasks[idx];
      if (entry === undefined) return 'LIMIT 1';
      idx++;
      return `LIMIT ${entry.original}`;
    });
  }

  // Restore Rule 4 (Nullable CAST) — FIFO queue.
  // The masked SQL had CAST(NULL AS TEXT); find those patterns in order and
  // substitute the originals. This avoids clobbering IS NULL / IS NOT NULL.
  const nullableMasks = masks.filter((m) => m.placeholder.startsWith('__chNullable'));
  if (nullableMasks.length > 0) {
    let idx = 0;
    out = out.replace(/CAST\s*\(\s*NULL\s+AS\s+TEXT\s*\)/gi, () => {
      const entry = nullableMasks[idx];
      if (entry === undefined) return 'CAST(NULL AS TEXT)';
      idx++;
      return entry.original;
    });
  }

  // Restore Rule 6a/6b (INTERVAL) — FIFO queue per substituted form.
  // The masked SQL had INTERVAL '1' <unit> (or INTERVAL '<n>' DAY for week).
  // Find those patterns in the serialised output in order and restore originals.
  const intervalIdentMasks = masks.filter((m) => m.placeholder.startsWith('__chIntervalIdent'));
  if (intervalIdentMasks.length > 0) {
    let idx = 0;
    out = out.replace(/\bINTERVAL\s+'1'\s+(DAY|HOUR|HOURS|MINUTE|MINUTES|SECOND|SECONDS|YEAR|MONTH)\b/gi, () => {
      const entry = intervalIdentMasks[idx];
      if (entry === undefined) return "INTERVAL '1' DAY";
      idx++;
      return entry.original;
    });
  }

  const intervalWeekMasks = masks.filter((m) => m.placeholder.startsWith('__chIntervalWeek'));
  if (intervalWeekMasks.length > 0) {
    let idx = 0;
    out = out.replace(/\bINTERVAL\s+'([^']+)'\s+DAY\b/gi, () => {
      const entry = intervalWeekMasks[idx];
      if (entry === undefined) return "INTERVAL '1' DAY";
      idx++;
      return entry.original;
    });
  }

  // Restore Rule 8 (FINAL) — re-attach the modifier to each table reference that
  // carried it. Matched backtick-tolerantly because the serialiser quotes
  // identifiers; the negative lookahead keeps a re-run idempotent.
  for (const mask of masks.filter((m) => m.placeholder.startsWith('__chFinal'))) {
    const re = new RegExp(`(${tableRefPattern(mask.original)})(?!\\s+FINAL\\b)`, 'i');
    out = out.replace(re, '$1 FINAL');
  }

  for (const { placeholder, original } of masks) {
    if (placeholder === '__chLagInFrame_sentinel__') continue;
    if (placeholder.startsWith('__chLimitParam')) continue;
    if (placeholder.startsWith('__chNullable')) continue;
    if (placeholder.startsWith('__chIntervalIdent')) continue;
    if (placeholder.startsWith('__chIntervalWeek')) continue;
    if (placeholder.startsWith('__chFinal')) continue;

    if (placeholder === '__chArrayJoin__') {
      // ARRAY JOIN was stripped; re-insert before GROUP BY / ORDER BY / end
      const groupMatch = out.match(/\s+(GROUP\s+BY|ORDER\s+BY|LIMIT\b)/i);
      if (groupMatch && groupMatch.index !== undefined) {
        out = out.slice(0, groupMatch.index) + '\n' + original + out.slice(groupMatch.index);
      } else {
        out = out + '\n' + original;
      }
      continue;
    }

    if (placeholder.startsWith('__chArrLit')) {
      // Restore [ ] from ( )
      const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), original);
      // Also restore the ( ) form that was substituted
      const tuple = original.replace('[', '(').replace(']', ')');
      const tupleEscaped = tuple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(tupleEscaped, 'g'), original);
      continue;
    }

    if (placeholder.startsWith('__chq_')) {
      // Restore quantile(p)( from __chq_p__(
      const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // The serialiser may backtick the identifier
      out = out.replace(new RegExp(`\`?${escaped}\`?`, 'g'), original);
      continue;
    }

    // Rule 1: param markers. Placeholder is __chparam_name__, was emitted as
    // (__chparam_name__). After serialisation the parens are kept by the parser
    // (it's an IN-list or subexpr). Restore the original {name:Type} without
    // the surrounding parens.
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\(\`?${escaped}\`?\\)`, 'g'), original);
    // Also handle the case where the parens were stripped or it appears bare
    out = out.replace(new RegExp(`\`?${escaped}\`?`, 'g'), original);
  }

  return out;
}

// ─── Parser instance ────────────────────────────────────────────────────────

const _parser = new Parser();
const _opts: Option = { database: 'PostgresQL' };

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ParseResult {
  ast: AST | AST[];
  masks: Mask[];
  /** Original (pre-masking) SQL, needed during restore. */
  originalSql: string;
}

/**
 * Parse a SQL SELECT string (possibly containing ClickHouse-specific syntax).
 * Returns an AST plus the masking metadata needed to restore ClickHouse tokens
 * after serialisation.
 *
 * Throws `ParseError` if the SQL cannot be parsed even after masking.
 */
export function parseSelect(sql: string): ParseResult {
  const trimmed = sql.trim();
  if (!trimmed) throw new ParseError('Could not parse SQL: empty input');

  const { masked, masks } = buildMasks(trimmed);

  try {
    const ast = _parser.astify(masked, _opts);
    return { ast, masks, originalSql: trimmed };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new ParseError(`Could not parse SQL: ${m}`, err);
  }
}

/**
 * Serialise a `ParseResult` back to SQL, restoring ClickHouse-specific tokens.
 */
export function serialize({ ast, masks, originalSql }: ParseResult): string {
  const serialised = _parser.sqlify(ast, _opts);
  return restoreMasks(serialised, masks, originalSql);
}
