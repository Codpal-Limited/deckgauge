"use client";

import { useRef, useState, useEffect } from "react";

interface InlineAddRowProps {
  onAdd: (name: string) => void;
  onShiftEnterAdd?: (name: string) => void;
  isLoading?: boolean;
  groupColor?: string;
}

export function InlineAddRow({ onAdd, onShiftEnterAdd, isLoading, groupColor = '#6C6CFF' }: InlineAddRowProps) {
  const [isActive, setIsActive] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleActivate = () => {
    setIsActive(true);
  };

  const handleSubmit = (keepActive = true) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    onAdd(trimmed);
    setValue("");
    if (!keepActive) {
      setIsActive(false);
    }
  };

  const handleShiftEnterSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;

    (onShiftEnterAdd ?? onAdd)(trimmed);
    setValue("");
    setIsActive(false);
  };

  const handleCancel = () => {
    setIsActive(false);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        handleShiftEnterSubmit();
      } else {
        handleSubmit(true);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  useEffect(() => {
    if (isActive && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isActive]);

  if (!isActive) {
    return (
      <div
        className="grid items-center border-t border-slate-100"
        style={{ gridTemplateColumns: 'var(--board-grid-cols)' }}
      >
        <div className="sticky left-0 z-10 h-full rounded-bl-md" style={{ backgroundColor: groupColor, opacity: 0.4 }} />
        <div style={{ gridColumn: '2 / -1', left: 6 }} className="sticky z-10 bg-white">
          <button
            type="button"
            onClick={handleActivate}
            onFocus={handleActivate}
            disabled={isLoading}
            className="w-full text-left px-3 py-2 text-sm text-slate-400 hover:bg-slate-50 hover:text-slate-500 transition-colors disabled:opacity-50"
            aria-label="Add item"
          >
            + Add item
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid items-center border-t border-slate-100"
      style={{ gridTemplateColumns: 'var(--board-grid-cols)' }}
    >
      <div className="sticky left-0 z-10 h-full rounded-bl-md" style={{ backgroundColor: groupColor, opacity: 0.4 }} />
      <div style={{ gridColumn: '2 / -1', left: 6 }} className="sticky z-10 bg-white flex items-center gap-2 px-3 py-1.5">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Item name"
          disabled={isLoading}
          className="input-dark flex-1 py-1.5"
          autoComplete="off"
        />
        <button
          type="button"
          onClick={handleCancel}
          disabled={isLoading}
          className="btn-ghost text-xs"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => handleSubmit()}
          disabled={isLoading || !value.trim()}
          className="inline-flex min-h-11 items-center justify-center md:min-h-0 rounded-lg px-2 py-1 text-xs text-indigo-500 hover:bg-blue-50/50 disabled:text-slate-500 transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  );
}
