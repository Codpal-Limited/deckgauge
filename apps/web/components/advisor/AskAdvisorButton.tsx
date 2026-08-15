'use client';

import { useAdvisor } from './AdvisorProvider';

interface AskAdvisorButtonProps {
  boardId: string;
  widgetType?: string;
  variant: 'header' | 'chip';
}

/**
 * Entry point that raises the Ask-the-Advisor panel.
 *
 * Holds no state and mounts no panel — the panel lives once at layout level
 * (see `AdvisorProvider`), which is what lets a conversation survive being
 * closed, docked, or navigated away from. Clicking here on a board that already
 * has a live conversation RAISES it rather than replacing it.
 *
 * `variant="header"` renders a labelled button for the board header.
 * `variant="chip"` renders a compact icon-only affordance for a widget card's
 * header row, scoping the next question to that widget.
 */
export function AskAdvisorButton({ boardId, widgetType, variant }: AskAdvisorButtonProps) {
  const advisor = useAdvisor();
  const onClick = () => advisor.open({ boardId, widgetType });

  if (variant === 'header') {
    return (
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600 transition-colors"
      >
        <span aria-hidden="true">✦</span>
        Ask the Advisor
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Ask the Advisor about this widget"
      className="rounded p-1 text-indigo-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
    >
      <span aria-hidden="true">✦</span>
    </button>
  );
}
