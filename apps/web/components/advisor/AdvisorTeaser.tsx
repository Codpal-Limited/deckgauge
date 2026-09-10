'use client';

import { useEffect, useRef, useState } from 'react';
import { dismissTeaser, isTeaserDismissed } from './advisor-prefs';

/** Delay before speaking, so the teaser does not compete with page render. */
const APPEAR_AFTER_MS = 1500;
/** How long it stays up if ignored. */
const VISIBLE_FOR_MS = 12000;

interface AdvisorTeaserProps {
  /** Page-context key — the dismissal is stored against this. */
  pageKey: string;
  teaser: string;
  onAsk: () => void;
}

/**
 * The first-visit nudge next to the launcher.
 *
 * This is the one part of the facelift that can annoy, so its rules are
 * strict: once per page key ever, delayed, self-collapsing, and dismissed by
 * either button — asking also writes the flag, so it never reappears behind
 * an open panel.
 */
export function AdvisorTeaser({ pageKey, teaser, onAsk }: AdvisorTeaserProps) {
  const [isVisible, setIsVisible] = useState(false);
  // Held outside the effect so an early `close()` can cancel the auto-collapse
  // timer — otherwise it stays live until it fires (harmlessly re-setting
  // already-false state), a timer outstanding for no reason.
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isTeaserDismissed(pageKey)) return;
    const appear = setTimeout(() => setIsVisible(true), APPEAR_AFTER_MS);
    collapseTimer.current = setTimeout(() => {
      // Persist, exactly as the two buttons do. Letting the window elapse is
      // still "the user has now seen this once", so it has to write the flag —
      // otherwise the docstring's "once per page key ever" was only true of the
      // two paths that clicked, and an ignored teaser came back on every visit.
      dismissTeaser(pageKey);
      setIsVisible(false);
    }, APPEAR_AFTER_MS + VISIBLE_FOR_MS);
    return () => {
      clearTimeout(appear);
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
    };
  }, [pageKey]);

  if (!isVisible) return null;

  const close = () => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    dismissTeaser(pageKey);
    setIsVisible(false);
  };

  return (
    <div className="flex max-w-[16rem] items-start gap-1 rounded-xl rounded-br-sm border border-indigo-100 bg-surface-1 px-3 py-2 shadow-lg animate-slide-up">
      <button
        type="button"
        onClick={() => {
          close();
          onAsk();
        }}
        // min-h-11 below `md`: this teaser sits on every route, so its 33px
        // height was three of the remaining sub-44px controls app-wide.
        className="min-h-11 text-left text-xs leading-snug text-indigo-800 hover:underline md:min-h-0"
      >
        {teaser}
      </button>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss advisor suggestion"
        // 16x28 before. `-m-1` grows the hit box to 44px without moving the ✕
        // or changing the teaser's height. NOT `-m-2`, which was the first
        // attempt and measured a 4px tap overlap onto the teaser button beside
        // it — `-m-1` is 4px against the container's 4px `gap-1`, so the two
        // boxes abut at exactly 0px.
        className="flex h-11 w-11 -m-1 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 md:h-auto md:w-auto md:m-0 md:p-0.5"
      >
        ✕
      </button>
    </div>
  );
}
