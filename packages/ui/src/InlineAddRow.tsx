"use client";

import { useRef, useState, useEffect } from "react";

export type AddFromLinkResult = { ok: true } | { ok: false; error: string };

interface InlineAddRowProps {
  onAdd: (name: string) => void;
  onShiftEnterAdd?: (name: string) => void;
  /**
   * Offered only on a board with a connected source. When the "Source link"
   * field is filled, Add loads that item from the source into this group and
   * the item name is disregarded.
   */
  onAddFromLink?: (url: string) => Promise<AddFromLinkResult>;
  isLoading?: boolean;
  groupColor?: string;
}

export function InlineAddRow({
  onAdd,
  onShiftEnterAdd,
  onAddFromLink,
  isLoading,
  groupColor = '#6C6CFF',
}: InlineAddRowProps) {
  const [isActive, setIsActive] = useState(false);
  const [value, setValue] = useState("");
  const [link, setLink] = useState("");
  const [linkPending, setLinkPending] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = !!isLoading || linkPending;
  const hasLink = !!onAddFromLink && link.trim().length > 0;

  const handleActivate = () => {
    setIsActive(true);
  };

  const submitLink = async () => {
    if (!onAddFromLink) return;
    const url = link.trim();
    if (!url || linkPending) return;
    setLinkPending(true);
    setLinkError(null);
    try {
      const result = await onAddFromLink(url);
      if (result.ok) {
        setLink("");
        setValue("");
      } else {
        setLinkError(result.error);
      }
    } catch {
      setLinkError("Couldn't load the item from its source.");
    } finally {
      setLinkPending(false);
    }
  };

  const handleSubmit = (keepActive = true) => {
    // A source link wins: the item's name comes from the source.
    if (hasLink) {
      void submitLink();
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) return;

    onAdd(trimmed);
    setValue("");
    if (!keepActive) {
      setIsActive(false);
    }
  };

  const handleShiftEnterSubmit = () => {
    if (hasLink) {
      void submitLink();
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) return;

    (onShiftEnterAdd ?? onAdd)(trimmed);
    setValue("");
    setIsActive(false);
  };

  const handleCancel = () => {
    setIsActive(false);
    setValue("");
    setLink("");
    setLinkError(null);
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
      <div style={{ gridColumn: '2 / -1', left: 6 }} className="sticky z-10 bg-white px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Item name"
            aria-label="Item name"
            disabled={busy || hasLink}
            className="input-dark min-w-[10rem] flex-1 py-1.5 disabled:opacity-50"
            autoComplete="off"
          />
          {onAddFromLink && (
            <input
              type="url"
              inputMode="url"
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                if (linkError) setLinkError(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="or paste a source link (Jira, GitHub, Azure DevOps)"
              aria-label="Source link"
              aria-invalid={linkError ? true : undefined}
              aria-describedby={linkError ? 'inline-add-link-error' : undefined}
              disabled={busy}
              className="input-dark min-w-[10rem] flex-1 py-1.5"
              autoComplete="off"
            />
          )}
          <button
            type="button"
            onClick={handleCancel}
            disabled={busy}
            className="btn-ghost text-xs"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={busy || (!value.trim() && !hasLink)}
            className="inline-flex min-h-11 items-center justify-center md:min-h-0 rounded-lg px-2 py-1 text-xs text-indigo-500 hover:bg-blue-50/50 disabled:text-slate-500 transition-colors"
          >
            {linkPending ? 'Loading…' : 'Add'}
          </button>
        </div>
        {linkError && (
          <p id="inline-add-link-error" role="alert" className="mt-1 text-xs text-red-500">
            {linkError}
          </p>
        )}
      </div>
    </div>
  );
}
