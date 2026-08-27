"use client";

import type { BoardColumn } from "@deckgauge/shared";
import { splitMultiValue } from "@deckgauge/shared";

interface CustomColumnCellProps {
  column: BoardColumn;
  value: string;
  isEditing: boolean;
  onEdit: () => void;
  /** optional explicit value to save (used by selects to avoid a stale-state race) */
  onSave: (value?: string) => void;
  onCancel: () => void;
  fieldInputValue: string;
  onFieldInputChange: (value: string) => void;
}

export function CustomColumnCell({
  column,
  value,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  fieldInputValue,
  onFieldInputChange,
}: CustomColumnCellProps) {
  // CHECKBOX: single-click toggle
  if (column.type === "CHECKBOX") {
    return (
      <div
        className="flex items-center justify-center cursor-pointer"
        onClick={() => {
          onFieldInputChange(value === "true" ? "false" : "true");
          onEdit();
          setTimeout(() => onSave(), 0);
        }}
      >
        <input
          type="checkbox"
          checked={value === "true"}
          readOnly
          className="h-4 w-4 rounded border-white/20 bg-white/5 text-indigo-500 cursor-pointer focus:ring-indigo-500/20"
        />
      </div>
    );
  }

  if (isEditing) {
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };

    const inputClass =
      "w-full rounded-md bg-white border border-indigo-500 px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

    return (
      <div className="flex items-center gap-1">
        {column.type === "DATE" ? (
          <input
            type="date"
            value={fieldInputValue}
            onChange={(e) => onFieldInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => onSave()}
            className={inputClass}
            autoFocus
          />
        ) : column.type === "NUMBER" ? (
          <input
            type="number"
            value={fieldInputValue}
            onChange={(e) => onFieldInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => onSave()}
            className={`${inputClass} text-right`}
            autoFocus
          />
        ) : column.type === "DROPDOWN" || column.type === "STATUS" ? (
          <select
            value={fieldInputValue}
            onChange={(e) => {
              // Pass the value explicitly — relying on fieldInputValue state +
              // a deferred onSave() saved a stale (previous) value.
              const v = e.target.value;
              onFieldInputChange(v);
              onSave(v);
            }}
            className={inputClass}
            autoFocus
          >
            <option value="">-- Select --</option>
            {((column.config as Record<string, unknown> | null)?.options as string[] | undefined)?.map(
              (opt: string) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ),
            )}
          </select>
        ) : column.type === "LINK" ? (
          <input
            type="url"
            value={fieldInputValue}
            onChange={(e) => onFieldInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => onSave()}
            placeholder="https://..."
            className={inputClass}
            autoFocus
          />
        ) : (
          <input
            type="text"
            value={fieldInputValue}
            onChange={(e) => onFieldInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => onSave()}
            className={inputClass}
            autoFocus
          />
        )}
      </div>
    );
  }

  // Display mode
  const displayValue = value || "\u2014";

  // Multi-value columns store their values joined (percent-escaped, then
  // comma-joined) because that is what a plain-text read of the column
  // should show. Chip rendering is gated on `config.multiValue` alone: a
  // joined "backend, api" and a hand-typed "backend, api" are byte-identical
  // once stored, so the config flag is the only thing that can tell them
  // apart. Splitting unconditionally would turn any ordinary text column
  // containing a comma into chips.
  const isMultiValue = (column.config as Record<string, unknown> | null | undefined)?.multiValue === true;
  if (isMultiValue) {
    const values = splitMultiValue(value);
    if (values.length === 0) {
      // Empty for the entire window between attaching a Jira field and the
      // next sync populating it — that is the first thing a user sees after
      // using the field picker. Fall back to the same placeholder every other
      // column type uses so it reads as an empty cell, not a broken one, and
      // stays clickable into the editing branch.
      return (
        <div
          onClick={onEdit}
          className="text-xs text-slate-400 cursor-pointer hover:text-slate-700 rounded px-1 py-1 truncate transition-colors"
          title={displayValue}
        >
          {displayValue}
        </div>
      );
    }
    return (
      <div onClick={onEdit} className="flex flex-wrap items-center gap-1 cursor-pointer" title={value}>
        {values.map((entry, index) => (
          <span
            key={`${entry}-${index}`}
            data-testid="value-chip"
            className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
          >
            {entry}
          </span>
        ))}
      </div>
    );
  }

  if (column.type === "LINK" && value) {
    return (
      <div className="flex items-center gap-1">
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-indigo-500 hover:underline truncate"
          title={value}
        >
          {value.replace(/^https?:\/\//, "").slice(0, 20)}
        </a>
        <button
          type="button"
          onClick={onEdit}
          className="text-xs text-slate-500 hover:text-slate-600 transition-colors"
          aria-label="Edit link"
        >
          {"\u270E"}
        </button>
      </div>
    );
  }

  if (column.type === "NUMBER") {
    return (
      <div
        onClick={onEdit}
        className="text-xs text-slate-400 cursor-pointer hover:text-slate-700 rounded px-1 py-1 text-right transition-colors"
        title={displayValue}
      >
        {displayValue}
      </div>
    );
  }

  // STATUS custom columns render as a colored pill (like the board Status
  // column), using per-option colors from the column config when present.
  if (column.type === "STATUS" && value) {
    const optionColors = (column.config as Record<string, unknown> | null)?.optionColors as
      | Record<string, string>
      | undefined;
    const color = optionColors?.[value] ?? "#94a3b8";
    return (
      <div onClick={onEdit} className="cursor-pointer" title={value}>
        <span
          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
          style={{ backgroundColor: color, textShadow: "0 1px 1px rgba(0,0,0,0.25)" }}
        >
          {value}
        </span>
      </div>
    );
  }

  return (
    <div
      onClick={onEdit}
      className="text-xs text-slate-400 cursor-pointer hover:text-slate-700 rounded px-1 py-1 truncate transition-colors"
      title={displayValue}
    >
      {displayValue}
    </div>
  );
}
