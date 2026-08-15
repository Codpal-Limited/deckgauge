'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WIDGET_HELP } from './widgetHelp';
import WidgetHelpPopover from './WidgetHelpPopover';

interface Props {
  widgetType: string;
  title: string;
}

// The `?` help affordance shared by every widget header (dashboard cards and the
// comparison view). Renders nothing when no help exists for the type. The popover
// is portaled to document.body so it is never clipped by an ancestor's
// `overflow-hidden` or trapped by a transformed react-grid-layout item.
export default function WidgetHelpButton({ widgetType, title }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClickAway = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickAway);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickAway);
    };
  }, [open]);

  if (!WIDGET_HELP[widgetType]) return null;

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next && buttonRef.current) {
        const r = buttonRef.current.getBoundingClientRect();
        setCoords({ top: r.bottom + 4, right: window.innerWidth - r.right });
      }
      return next;
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        ref={buttonRef}
        aria-label="How to read this widget"
        aria-expanded={open}
        className="p-1 text-slate-400 hover:text-slate-600 rounded transition-colors"
        onClick={toggle}
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="12" cy="12" r="9" />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5"
          />
          <circle cx="12" cy="17" r="0.5" fill="currentColor" />
        </svg>
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={`How to read: ${title}`}
            className="fixed w-80 max-h-96 overflow-auto bg-white rounded-lg shadow-lg border border-slate-200 p-3 z-50"
            style={{ top: coords.top, right: coords.right }}
          >
            <WidgetHelpPopover widgetType={widgetType} />
          </div>,
          document.body
        )}
    </div>
  );
}
