'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Open/close state for the mobile nav drawer, shared between the trigger (which
 * lives in `Header`) and the drawer itself (which wraps the sidebar inside
 * `AppChrome`). Those two are siblings, not parent and child, so the state has
 * to sit above both — hence a context rather than a `useState` in either one.
 */
interface MobileNavState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const MobileNavContext = createContext<MobileNavState | null>(null);

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  // Navigating closes the drawer. Without this, tapping a board in the drawer
  // loads the board BEHIND a drawer that is still covering it — the navigation
  // is client-side, so nothing unmounts the drawer on its own.
  //
  // The QUERY STRING is part of "navigating", and leaving it out made this
  // effect miss the exact case its own comment describes. Selecting a board
  // goes to `/?boardId=<id>` — same pathname, different board — so on a phone
  // the drawer stayed open over the board the user had just chosen, with the
  // body scroll lock still engaged. Measured at 390px before the fix: after
  // tapping a row the URL was `/?boardId=...`, the drawer was still visible and
  // `body` was still `overflow: hidden`.
  //
  // Every jsdom test passed throughout, and the drawer e2e spec passed too —
  // it opened and closed the drawer without ever selecting a board.
  // `e2e/mobile-touch.spec.ts` found it only because a swipe cannot scroll a
  // locked body.
  const search = searchParams?.toString() ?? '';
  useEffect(() => {
    setIsOpen(false);
  }, [pathname, search]);

  const value = useMemo(() => ({ isOpen, open, close, toggle }), [isOpen, open, close, toggle]);

  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>;
}

/**
 * Returns null outside a provider rather than throwing.
 *
 * `Header` is only ever rendered inside `AppChrome` (its single call site), and
 * `AppChrome` provides the context — so in the running app this is never null.
 * It stays nullable for two reasons: a component test can render `Header` alone
 * without wiring a provider, and a future render of the header outside the
 * chrome degrades to "no hamburger" instead of crashing the page.
 */
export function useMobileNav(): MobileNavState | null {
  return useContext(MobileNavContext);
}
