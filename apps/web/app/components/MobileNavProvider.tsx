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
import { usePathname } from 'next/navigation';

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

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  // Navigating closes the drawer. Without this, tapping a board in the drawer
  // loads the board BEHIND a drawer that is still covering it — the navigation
  // is client-side, so nothing unmounts the drawer on its own.
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

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
