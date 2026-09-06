'use client';

import type { JSX } from 'react';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface NewMenuItem {
  /** Full label — no truncation, shown in the list and as the preview heading. */
  label: string;
  /** One-line explanation of what this option creates. Shown in the preview pane. */
  description: string;
  icon: JSX.Element;
  /** Group heading the item is listed under (e.g. "Boards"). */
  section: string;
  onSelect?: () => void;
  /** Shown greyed with a hint when the feature isn't wired yet. */
  disabled?: boolean;
  hint?: string;
}

interface SidebarNewMenuProps {
  items: NewMenuItem[];
}

/** Group items by section, preserving first-seen section and item order. */
function groupBySection(items: NewMenuItem[]): { section: string; items: NewMenuItem[] }[] {
  const order: string[] = [];
  const bucket = new Map<string, NewMenuItem[]>();
  for (const item of items) {
    if (!bucket.has(item.section)) {
      bucket.set(item.section, []);
      order.push(item.section);
    }
    bucket.get(item.section)!.push(item);
  }
  return order.map((section) => ({ section, items: bucket.get(section)! }));
}

/**
 * Two-pane "Create" flyout: a categorized list on the left, a live preview of
 * the highlighted option (icon, full title, description, Create button) on the
 * right. Hovering or focusing a row updates the preview; clicking it — or the
 * Create button — commits. Wider than the sidebar so template names never clip.
 */
export function SidebarNewMenu({ items }: SidebarNewMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const enabledItems = useMemo(() => items.filter((i) => !i.disabled), [items]);
  const sections = useMemo(() => groupBySection(items), [items]);

  // The option shown in the preview pane. Defaults to the first enabled item.
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const preview = useMemo(
    () => items.find((i) => i.label === previewLabel) ?? enabledItems[0] ?? items[0] ?? null,
    [items, enabledItems, previewLabel],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    setPreviewLabel(null); // reset to first item each time the flyout opens
    setOpen((v) => !v);
  };

  const select = (item: NewMenuItem | null) => {
    if (!item || item.disabled) return;
    setOpen(false);
    item.onSelect?.();
  };

  return (
    <div ref={rootRef} className="relative border-t border-slate-200 px-3 py-2.5">
      {open && (
        <div
          role="menu"
          aria-label="Create"
          className="absolute bottom-full left-3 z-50 mb-2 flex w-[420px] max-w-[calc(100vw-5rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
        >
          {/* Left — categorized list */}
          <div className="w-[190px] shrink-0 border-r border-slate-100 p-1.5">
            {sections.map((group) => (
              <div key={group.section} className="mb-1 last:mb-0">
                <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {group.section}
                </p>
                {group.items.map((item) => {
                  const isActive = preview?.label === item.label;
                  return (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      onClick={() => select(item)}
                      onMouseEnter={() => !item.disabled && setPreviewLabel(item.label)}
                      onFocus={() => !item.disabled && setPreviewLabel(item.label)}
                      title={item.disabled ? item.hint : undefined}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                        item.disabled
                          ? 'cursor-not-allowed text-slate-400'
                          : isActive
                            ? 'bg-indigo-50 text-indigo-600'
                            : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                          item.disabled
                            ? 'bg-slate-100 text-slate-400'
                            : isActive
                              ? 'bg-indigo-100 text-indigo-600'
                              : 'bg-slate-100 text-slate-500'
                        }`}
                        aria-hidden="true"
                      >
                        {item.icon}
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.disabled && item.hint && (
                        <span className="text-[10px] font-semibold uppercase text-slate-400">
                          {item.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Right — live preview of the highlighted option */}
          {preview && (
            <div className="flex flex-1 flex-col p-4">
              <span
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 [&>svg]:h-5 [&>svg]:w-5"
                aria-hidden="true"
              >
                {preview.icon}
              </span>
              <h3 className="mt-3 text-sm font-semibold text-slate-800">{preview.label}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{preview.description}</p>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => select(preview)}
                disabled={preview.disabled}
                className="mt-3 inline-flex items-center justify-center gap-1.5 self-start rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition enabled:hover:from-indigo-600 enabled:hover:to-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-3.5 w-3.5"
                  aria-hidden="true"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-500/30 transition hover:from-indigo-600 hover:to-violet-600"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        New
      </button>
    </div>
  );
}
