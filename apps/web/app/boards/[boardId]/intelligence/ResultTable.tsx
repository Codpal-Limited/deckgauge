'use client';

import { FixedSizeList } from 'react-window';
import type {
  RunIntelligenceQueryErr,
  RunIntelligenceQueryOk,
} from '../../../actions/intelligence-query';

interface Props {
  result: RunIntelligenceQueryOk | null;
  error: RunIntelligenceQueryErr | null;
  running: boolean;
}

const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT = 28;
const TABLE_HEIGHT = 320;

export function ResultTable({ result, error, running }: Props) {
  if (running && !result && !error) {
    return <div className="p-6 text-slate-500 text-sm">Running…</div>;
  }
  if (error) {
    return (
      <div className="p-4 border-t border-rose-200 bg-rose-50 text-rose-700 text-sm">
        <div className="font-semibold">Query error ({error.code})</div>
        <div className="mt-1 whitespace-pre-wrap break-words">{error.error}</div>
      </div>
    );
  }
  if (!result) {
    return <div className="p-6 text-slate-400 text-sm">Run a query to see results.</div>;
  }

  const rows = result.rows as Record<string, unknown>[];
  const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
  const scopeSummary = formatScope(result.scope);

  return (
    <div className="flex flex-col h-full border-t border-slate-200">
      {result.truncated && (
        <div className="px-4 py-2 bg-amber-50 text-amber-800 text-xs border-b border-amber-200">
          Result truncated to first {rows.length.toLocaleString()} rows.
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="p-6 text-slate-500 text-sm">No rows returned.</div>
        ) : rows.length > VIRTUALIZE_THRESHOLD ? (
          <VirtualizedTable rows={rows} columns={columns} />
        ) : (
          <PlainTable rows={rows} columns={columns} />
        )}
      </div>
      <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 text-xs text-slate-600 flex items-center gap-3">
        <span>
          {rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'}
        </span>
        <span>·</span>
        <span>{result.ms} ms</span>
        <span>·</span>
        <span>Scope: {scopeSummary}</span>
      </div>
    </div>
  );
}

function formatScope(scope: RunIntelligenceQueryOk['scope']): string {
  const parts: string[] = [];
  if (scope.github.length) parts.push(`${scope.github.length} GitHub`);
  if (scope.jira.length) parts.push(`${scope.jira.length} Jira`);
  if (scope.ado.length) parts.push(`${scope.ado.length} ADO`);
  if (scope.gitlab.length) parts.push(`${scope.gitlab.length} GitLab`);
  if (scope.bitbucket?.length) parts.push(`${scope.bitbucket.length} Bitbucket`);
  return parts.join(', ') || 'none';
}

interface TableBodyProps {
  rows: Record<string, unknown>[];
  columns: string[];
}

function PlainTable({ rows, columns }: TableBodyProps) {
  return (
    <table className="text-xs w-full">
      <thead className="sticky top-0 bg-slate-100 text-left">
        <tr>
          {columns.map((c) => (
            <th key={c} className="px-3 py-1.5 font-semibold text-slate-700 whitespace-nowrap">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="even:bg-slate-50">
            {columns.map((c) => (
              <td key={c} className="px-3 py-1 text-slate-800 whitespace-nowrap">
                {renderCell(row[c])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VirtualizedTable({ rows, columns }: TableBodyProps) {
  return (
    <div>
      <div className="sticky top-0 bg-slate-100 flex">
        {columns.map((c) => (
          <div
            key={c}
            className="px-3 py-1.5 text-xs font-semibold text-slate-700 flex-1 min-w-[120px]"
          >
            {c}
          </div>
        ))}
      </div>
      <FixedSizeList height={TABLE_HEIGHT} itemCount={rows.length} itemSize={ROW_HEIGHT} width="100%">
        {({ index, style }) => {
          const row = rows[index] as Record<string, unknown>;
          return (
            <div style={style} className={`flex text-xs ${index % 2 ? 'bg-slate-50' : ''}`}>
              {columns.map((c) => (
                <div
                  key={c}
                  className="px-3 py-1 text-slate-800 flex-1 min-w-[120px] truncate"
                >
                  {renderCell(row[c])}
                </div>
              ))}
            </div>
          );
        }}
      </FixedSizeList>
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
