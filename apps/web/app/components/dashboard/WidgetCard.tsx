'use client';

import { useState, useTransition } from 'react';
import { deleteWidget } from '../../actions/widgets';
import WidgetHelpButton from './WidgetHelpButton';
import { AskAdvisorButton } from '../../../components/advisor/AskAdvisorButton';

interface WidgetCardProps {
  boardId: string;
  viewId: string;
  widgetId: string;
  title: string;
  widgetType: string;
  canEdit: boolean;
  onConfigure?: () => void;
  // The board owns the widget list in client state, so a successful delete has
  // to be reported back — otherwise the removed card sits on the canvas until a
  // full page reload remounts the board and refetches the list.
  onRemoved?: () => void;
  children: React.ReactNode;
}

export default function WidgetCard({
  boardId,
  viewId,
  widgetId,
  title,
  widgetType,
  canEdit,
  onConfigure,
  onRemoved,
  children,
}: WidgetCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleDelete = () => {
    if (!confirm('Remove this widget?')) return;
    startTransition(async () => {
      await deleteWidget(boardId, viewId, widgetId);
      onRemoved?.();
    });
  };

  return (
    <div className="h-full flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-700 truncate">{title}</h3>
        {/*
          Touch floor NOT applied here, deliberately — see plan Task 3.0d.
          Measured in Chromium at 390px, border-box:

            help (p-1 + w-4 h-4 svg)   24.0 x 24.0
            chip (p-1 + a text glyph)  32.0 x 20.7   <-- fails AA on width
            More options (p-1 + svg)   24.0 x 24.0
            this header                53.0px  (20px py-2.5 + 32px tallest
                                               child + 1px border-b)

          The row is NOT uniform: the chip carries no `w-4 h-4`, just a `✦` in
          a span, so it takes a 16 x 1.5 = 24px line box plus 8px of padding.
          At 20.7px wide it fails WCAG 2.5.8 (AA, 24px) — the other two meet AA
          exactly and only fail 2.5.5 (AAA, 44px). So the chip is the worst
          control here, not an equal member of a tidy set.

          Note the same component's `header` variant IS floored
          (`AskAdvisorButton.tsx:38`, `h-11 … md:h-9`), so its two variants
          differ until 3.0d lands. That is deliberate, not an oversight.

          Why it is still not a one-line floor: the header is ALREADY 53px, so
          flooring the controls to 44px takes it to 65px against
          `DashboardCanvas`'s `rowHeight={80}` — most of a grid row, on every
          widget, re-tuning saved layouts rather than enlarging three buttons.
          That belongs to the dashboard group, not the shell sweep.
        */}
        <div className="flex items-center gap-1">
          <WidgetHelpButton widgetType={widgetType} title={title} />
          <AskAdvisorButton boardId={boardId} widgetType={widgetType} variant="chip" />
          {canEdit && (
            <div className="relative">
              <button
                type="button"
                aria-label="More options"
                className="p-1 text-slate-400 hover:text-slate-600 rounded transition-colors"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="5" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="12" cy="19" r="1.5" />
                </svg>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 w-36 bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-50">
                  {onConfigure && (
                    <button
                      className="w-full text-left px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                      onClick={() => {
                        onConfigure();
                        setMenuOpen(false);
                      }}
                    >
                      Configure
                    </button>
                  )}
                  <button
                    className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                    onClick={() => {
                      handleDelete();
                      setMenuOpen(false);
                    }}
                    disabled={isPending}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 p-4 overflow-auto">{children}</div>
    </div>
  );
}
