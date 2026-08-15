'use client';

import { useAdvisor } from './AdvisorProvider';
import { AdvisorTeaser } from './AdvisorTeaser';

/**
 * The Advisor's standing entry point: one bubble, bottom-right, on every
 * route.
 *
 * Replaces `AdvisorDock`, which existed only in `mode === 'docked'` and was
 * gated off every non-board route — between them, those two conditions left
 * the Advisor with no affordance at all most of the time.
 *
 * Sits above the Toaster's offset (see `app/layout.tsx`) so sonner's toasts
 * stack on top of it rather than through it.
 */
export function AdvisorLauncher() {
  const advisor = useAdvisor();
  const { state, pageContext } = advisor;

  // The drawer covers this corner; the card is anchored above it and leaves
  // the launcher visible on purpose, so the thing you clicked stays put.
  if (state.mode === 'open' && advisor.panelSize === 'drawer') return null;

  const isLive = state.mode === 'docked' && Boolean(state.boardId);
  const label = isLive ? 'Ask the Advisor — continue conversation' : 'Ask the Advisor';
  const status = state.isAsking
    ? 'answering…'
    : state.hasUnseenAnswer
      ? 'answer ready'
      : null;

  const openAdvisor = () => {
    // Off-board there is no board to open onto — raise the panel and let it
    // run in product-help mode.
    if (advisor.routeBoardId) advisor.open({ boardId: advisor.routeBoardId });
    else advisor.raise();
  };

  // The teaser is a first-visit nudge, so it is suppressed while the panel is
  // open AND while a conversation is live. Without the second half, letting the
  // teaser lapse (rather than dismissing it) and then asking a question meant
  // that collapsing the panel popped "New here? Ask me how any part of
  // Deckgauge works" back up beside a conversation already in progress — every
  // time, indefinitely, because a lapsed teaser never wrote its flag.
  const isTeaserAllowed = state.mode !== 'open' && state.messages.length === 0;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-end gap-2">
      {isTeaserAllowed && (
        <AdvisorTeaser
          pageKey={pageContext.key}
          teaser={pageContext.teaser}
          onAsk={openAdvisor}
        />
      )}

      <div className="flex flex-col items-end gap-1">
        {status && (
          // `surface-1`, not `surface-0`: `surface-0` IS the page background, so
          // this pill — which has no border and only `shadow-sm` — was invisible
          // against it in dark mode. The ring gives it an edge in both themes.
          <span className="flex items-center gap-1.5 rounded-full bg-surface-1 px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-slate-200 shadow-sm">
            {state.isAsking && (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500"
              />
            )}
            {state.hasUnseenAnswer && !state.isAsking && (
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            )}
            {status}
          </span>
        )}
        <button
          type="button"
          onClick={openAdvisor}
          aria-label={label}
          title={label}
          className="relative flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500 text-lg text-white shadow-lg transition-colors hover:bg-indigo-600"
        >
          <span aria-hidden="true">✦</span>
          {state.isAsking && (
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-pulse rounded-full ring-2 ring-indigo-300"
            />
          )}
          {state.hasUnseenAnswer && !state.isAsking && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-surface-0 bg-emerald-500"
            />
          )}
        </button>
      </div>
    </div>
  );
}
