// Narrow to the shared read shape so a per-request `ChScopedReader` can be
// passed here (tenancy §11 precondition 8). This function already took its client
// as a parameter, so the only thing that was missing was a type that admits a
// scoped reader rather than only the raw client.
import type { ChReadClient } from '../../analytics/ch-read-scope.js';
import { parseSelect, serialize, ParseError } from './parser.js';
import { validateStatement, ValidationError } from './validate.js';
import { rewriteWithScope, ScopeError } from './rewrite.js';
import { assertEveryRefIsScoped, AssertError } from './assert.js';
import type { ResolvedScope } from './resolve-scope.js';

export const ROW_CAP = 10_000;
export const MAX_EXECUTION_TIME_SECONDS = 15;
export const MAX_ROWS_TO_READ = 1_000_000;

export interface ExecuteResult {
  rows: unknown[];
  ms: number;
  scope: ResolvedScope;
  truncated: boolean;
  /** The post-rewrite SQL actually sent to ClickHouse — for audit logging. */
  executedSql: string;
}

export class ConsoleError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ConsoleError';
  }
}

/**
 * Pipeline: parse → validate → rewrite → assert → execute.
 *
 * The dedicated `ch` argument lets tests mock without touching env vars or
 * the real DB. Production callers pass `getConsoleClickhouse()` from
 * `./console-clickhouse.ts`.
 */
export async function executeUserSql(
  sql: string,
  scope: ResolvedScope,
  ch: ChReadClient,
): Promise<ExecuteResult> {
  let parsed;
  try {
    parsed = parseSelect(sql.trim());
  } catch (e) {
    if (e instanceof ParseError) {
      throw new ConsoleError(e.message, 'PARSE', 400);
    }
    throw e;
  }

  try {
    validateStatement(parsed.ast);
    rewriteWithScope(parsed.ast, scope);
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new ConsoleError(e.message, e.code, 400);
    }
    if (e instanceof ScopeError) {
      throw new ConsoleError(e.message, e.code, 400);
    }
    throw e;
  }

  const executedSql = serialize(parsed);

  try {
    assertEveryRefIsScoped(executedSql);
  } catch (e) {
    if (e instanceof AssertError) {
      // Generic message — don't leak which check tripped.
      throw new ConsoleError(e.message, 'ASSERT', 500);
    }
    throw e;
  }

  const t0 = Date.now();
  const queryResult = await ch.query({
    query: executedSql,
    format: 'JSONEachRow',
    clickhouse_settings: {
      readonly: '1',
      max_execution_time: MAX_EXECUTION_TIME_SECONDS,
      max_rows_to_read: String(MAX_ROWS_TO_READ),
    },
  });
  const json = (await queryResult.json()) as unknown[];
  const truncated = json.length > ROW_CAP;
  return {
    rows: truncated ? json.slice(0, ROW_CAP) : json,
    ms: Date.now() - t0,
    scope,
    truncated,
    executedSql,
  };
}
