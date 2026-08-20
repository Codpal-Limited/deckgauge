'use client';

import { useAdvisor } from './AdvisorProvider';
import { SparkleIcon } from '../../app/components/board-header/icons';

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
 * `variant="header"` renders the board action bar's primary button.
 * `variant="chip"` renders a compact icon-only affordance for a widget card's
 * header row, scoping the next question to that widget.
 */
export function AskAdvisorButton({ boardId, widgetType, variant }: AskAdvisorButtonProps) {
  const advisor = useAdvisor();
  const onClick = () => advisor.open({ boardId, widgetType });

  if (variant === 'header') {
    // Trimmed to one word for the board action bar. The accessible name keeps
    // the full phrase and contains the visible label, so screen-reader and
    // voice-control users still reach it by what they see (WCAG 2.5.3).
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label="Ask the Advisor"
        title="Ask the Advisor"
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-teal-600 px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"
      >
        <SparkleIcon className="h-4 w-4" />
        Advisor
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
