'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDownIcon } from './icons';

export interface ToolbarMenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** Renders in the danger tone and sits below a divider. */
  danger?: boolean;
}

interface ToolbarMenuProps {
  /** Accessible name of the trigger. */
  label: string;
  items: ToolbarMenuItem[];
  /** Visual content of the trigger; defaults to a chevron. */
  trigger?: ReactNode;
  triggerClassName?: string;
  align?: 'left' | 'right';
}

const TRIGGER_BASE =
  'inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40';

/**
 * The one dropdown used by the board action bar — the board menu behind the
 * title and any overflow menu share this shell so keyboard and dismiss
 * behaviour cannot drift apart between them.
 *
 * An empty `items` renders nothing: callers filter by permission, so a viewer
 * with no permitted action gets no trigger rather than a trigger that opens an
 * empty panel.
 */
export function ToolbarMenu({
  label,
  items,
  trigger,
  triggerClassName,
  align = 'left',
}: ToolbarMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  if (items.length === 0) return null;

  const safeItems = items.filter((item) => !item.danger);
  const dangerItems = items.filter((item) => item.danger);

  const renderItem = (item: ToolbarMenuItem) => (
    <button
      key={item.label}
      type="button"
      role="menuitem"
      onClick={() => {
        setIsOpen(false);
        item.onSelect();
      }}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
        item.danger
          ? 'text-rose-600 hover:bg-rose-50'
          : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      {item.icon && (
        <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center opacity-70">
          {item.icon}
        </span>
      )}
      {item.label}
    </button>
  );

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className={triggerClassName ?? TRIGGER_BASE}
      >
        {trigger ?? <ChevronDownIcon />}
      </button>

      {isOpen && (
        <div
          role="menu"
          className={`absolute top-full z-50 mt-1.5 w-52 overflow-hidden rounded-xl border border-slate-200 bg-surface-1 py-1 shadow-dropdown animate-fade-in ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {safeItems.map(renderItem)}
          {dangerItems.length > 0 && safeItems.length > 0 && (
            <div className="my-1 border-t border-slate-200" />
          )}
          {dangerItems.map(renderItem)}
        </div>
      )}
    </div>
  );
}
