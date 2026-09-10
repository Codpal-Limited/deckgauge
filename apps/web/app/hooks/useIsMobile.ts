'use client';

import { useEffect, useState } from 'react';

/**
 * The phone/tablet line, one pixel below Tailwind's `md`.
 *
 * `apps/web/tailwind.config.ts` extends `theme` only — it adds no `screens`
 * override — so `md` is Tailwind's default `768px` and the phone range ends at
 * `767px`. Exported so a caller never has to restate the number, and so the
 * test can pin it: a hook that agrees with the CSS breakpoint is the whole
 * point, and a silent drift between the two produces a layout that is mobile
 * by class and desktop by behaviour (or the reverse) in a 1px band.
 */
export const MOBILE_MEDIA_QUERY = '(max-width: 767px)';

/**
 * `true` when the viewport is at or below 767px — but never on the first
 * render.
 *
 * **The first render always reports `false`, deliberately.** There is no
 * viewport during server render, so any value derived from `matchMedia` there
 * is a guess; returning one would make the server's HTML disagree with the
 * client's first render and React would discard the hydrated tree (and warn).
 * `app/layout.tsx:28-33` faces the same hazard for the theme and answers it the
 * other way — a pre-paint inline script that sets the `dark` class before React
 * exists — because a class on `<html>` is not part of the hydrated tree. A hook
 * return value is, so it cannot use that trick: it has to start at the desktop
 * default and correct in an effect.
 *
 * Consequence for callers: mobile-only chrome mounts one paint late. Render the
 * desktop shape as the fallback, not a spinner, or the phone gets a flash of
 * nothing.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // jsdom does not implement `matchMedia`, and neither does any non-browser
    // consumer. Absent rather than throwing, so a plain `typeof` check is
    // enough — and without it every component test that mounts a caller would
    // crash on an unrelated assertion.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const list = window.matchMedia(MOBILE_MEDIA_QUERY);
    // Read once on mount: the `change` event only fires on a *transition*, so a
    // page loaded at 390px would otherwise never hear anything.
    setIsMobile(list.matches);

    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
