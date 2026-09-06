'use client';
import { useMemo, useState, type ReactNode } from 'react';

export interface ColumnDef<T> {
  key: keyof T;
  label: string;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right';
}

interface Props<T> {
  rows: T[];
  columns: ColumnDef<T>[];
  defaultSortKey: keyof T;
  defaultSortDir?: 'asc' | 'desc';
  drillDownHref?: (row: T) => string;
  // onRowClick wins over drillDownHref when both are provided. Used by
  // CH-backed widgets to route into the intelligence console instead of
  // navigating to a board-internal page via window.location.
  onRowClick?: (row: T) => void;
}

// `object`, not `Record<string, unknown>`: T is only ever reached through
// `keyof T` and `row[sortKey]`, which any object type supports. The Record
// constraint additionally demanded a string index signature, which a plain
// `interface Row { … }` does not have — so every caller's row type failed to
// satisfy it (three widgets plus this component's own tests).
export function SortableTable<T extends object>({
  rows, columns, defaultSortKey, defaultSortDir = 'desc', drillDownHref, onRowClick,
}: Props<T>) {
  const [sortKey, setSortKey] = useState<keyof T>(defaultSortKey);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSortDir);
  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
      const as = String(av ?? ''), bs = String(bv ?? '');
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return out;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: keyof T) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            {columns.map((c) => (
              <th
                key={String(c.key)}
                className={`px-2 py-1.5 ${c.align === 'right' ? 'text-right' : ''} ${c.sortable ? 'cursor-pointer hover:text-slate-900' : ''}`}
                onClick={() => c.sortable && toggleSort(c.key)}
              >
                {c.label}
                {sortKey === c.key ? <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => {
            const href = drillDownHref?.(row);
            const clickable = !!onRowClick || !!href;
            const handleClick = () => {
              if (onRowClick) onRowClick(row);
              else if (href) window.location.href = href;
            };
            return (
              <tr
                key={i}
                className={`border-b border-slate-100 ${clickable ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                onClick={clickable ? handleClick : undefined}
              >
                {columns.map((c) => (
                  <td key={String(c.key)} className={`px-2 py-1.5 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                    {c.render ? c.render(row) : String(row[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
