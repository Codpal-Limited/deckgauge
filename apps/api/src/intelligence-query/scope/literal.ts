/**
 * Escape a value for a ClickHouse single-quoted literal.
 *
 * `rewrite.ts` needs it because sqlify emits `single_quote_string` values
 * VERBATIM — there is no escaping pass — and `assert.ts` needs THE SAME function
 * because node-sql-parser reports a literal's text verbatim too: `'it''s'`
 * parses back to `it''s` and `'a\\b'` to `a\\b`, still escaped. So the
 * second-line value comparison runs on escaped forms on both sides, and it has
 * to be this exact escaping or every ADO area path (backslash separated) would
 * be refused. Shared here rather than exported from `rewrite.ts` so that the
 * coupling is the point of the module instead of an accident.
 *
 * Both halves are needed. The backslash half only became reachable with the ADO
 * area paths (`Platform\Compliance`) the console now injects — no other scope
 * identifier contains one. ClickHouse interprets escape sequences inside a
 * string literal, so a bare `'Platform\nightly'` arrives as `Platform` + LF +
 * `ightly` and matches nothing; measured against ClickHouse 25.8, an UNKNOWN
 * sequence such as `\C` is preserved, which is why `Platform\Compliance`
 * happened to work and why relying on that would have been luck.
 *
 * The two passes are independent — doubling `'` introduces no backslash and
 * doubling `\` introduces no quote — so their order does not matter.
 */
export function escapeChLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}
