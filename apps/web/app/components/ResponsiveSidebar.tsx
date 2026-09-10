'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useOverlayDismiss } from '@deckgauge/ui';
import { useIsMobile } from '../hooks/useIsMobile';
import { useHomeHref } from '../hooks/useHomeHref';
import { useMobileNav } from './MobileNavProvider';
import { NAV_ITEMS } from './nav-items';

/**
 * Decides whether the sidebar sits in the page flow or behind a hamburger.
 *
 * The sidebar is 296px of fixed chrome (a 56px rail plus a 240px panel). Beside
 * a 390px viewport that left 94px for the page, which is the single reason every
 * screen in this app looked broken on a phone.
 *
 * `children` is the server-rendered sidebar, passed through untouched. It is
 * rendered ONCE and relocated — not rendered twice with one copy hidden by CSS.
 * Two copies would mean two search inputs, two collapsed-group states and two
 * copies of every `data-testid` in the tree. The cost of relocating is that
 * crossing 768px remounts the sidebar and loses its transient state, which is a
 * fair trade for a boundary a real user crosses approximately never (only by
 * rotating a tablet).
 */
export function ResponsiveSidebar({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const nav = useMobileNav();
  const isOpen = nav?.isOpen ?? false;
  const close = nav?.close;

  // Escape-to-close and the body scroll lock. The lock is reference counted in
  // `packages/ui`, shared with every other overlay in the app, so closing this
  // drawer cannot unlock the page beneath one that is still open. Called
  // unconditionally because hooks cannot be conditional; it no-ops when shut.
  useOverlayDismiss(isMobile && isOpen, close ?? (() => {}));

  // Widening past `md` closes the drawer. Without this the open flag survives
  // the crossing, so rotating a tablet portrait -> landscape -> portrait brings
  // the drawer back unbidden.
  useEffect(() => {
    if (!isMobile && isOpen) close?.();
  }, [isMobile, isOpen, close]);

  // Desktop: the sidebar is part of the flex row, exactly as before.
  if (!isMobile) return <>{children}</>;

  // Phone, drawer shut: render nothing at all. Parking it offscreen instead
  // would leave its links in the tab order and in the accessibility tree.
  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 animate-fade-in md:hidden"
        onClick={close}
        aria-hidden="true"
      />
      <div
        data-testid="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="fixed inset-y-0 left-0 z-50 flex w-[88vw] max-w-[340px] flex-col bg-slate-50 shadow-xl md:hidden"
      >
        <MobileNavLinks onDismiss={close} />
        {/* `min-h-0` is required: without it this flex child refuses to shrink
            below its content height and the sidebar's own `overflow-y-auto`
            never engages, so the tree is unreachable past the fold. */}
        <div className="flex min-h-0 flex-1">{children}</div>
      </div>
    </>
  );
}

/**
 * The primary nav inside the drawer. Rendered from the same `NAV_ITEMS` array
 * the header uses, so the two lists cannot drift — the header hides its own row
 * below `md` and this takes over.
 */
function MobileNavLinks({ onDismiss }: { onDismiss?: () => void }) {
  const pathname = usePathname();
  const homeHref = useHomeHref();

  return (
    <nav className="flex shrink-0 flex-col gap-1 border-b border-slate-200 bg-white p-2">
      {/* An explicit close control. The backdrop and Escape both close the
          drawer, but neither is discoverable by touch, and the sidebar's own
          collapse chevron is hidden here (collapsing to a 56px rail inside an
          88vw drawer is meaningless). */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Close navigation menu"
        className="mb-1 flex h-11 w-11 items-center justify-center self-end rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      {NAV_ITEMS.map((item) => {
        const active = item.isActive(pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.resume ? homeHref : item.href}
            onClick={onDismiss}
            aria-current={active ? 'page' : undefined}
            // min-h-11 is 44px — the touch-target floor the mobile e2e helper
            // asserts on every visible control.
            className={[
              'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
              active
                ? 'bg-teal-50 text-teal-800'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
            ].join(' ')}
          >
            <Icon className="h-5 w-5 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
