"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "./NotificationBell";
import { ThemeToggle } from "./ThemeToggle";
import { DeckgaugeMark } from "./DeckgaugeMark";
import { NAV_ITEMS } from "./nav-items";
import { useHomeHref } from "../hooks/useHomeHref";
import { useMobileNav } from "./MobileNavProvider";

/**
 * The nav bar. Below `md` the primary nav row is hidden and a hamburger takes
 * its place — the same `NAV_ITEMS` are rendered inside the drawer by
 * `ResponsiveSidebar`, so the two lists cannot drift.
 *
 * The icons and the nav list used to be declared inline here; they moved to
 * `nav-items.tsx` when the drawer became a second renderer of them, and the
 * "Home resumes the last workspace location" logic moved to `useHomeHref` for
 * the same reason.
 */
export function Header() {
  const pathname = usePathname();
  const homeHref = useHomeHref();
  const nav = useMobileNav();

  // Login page renders its own nav bar — hide the shared header
  if (pathname === "/login") return null;

  return (
    <nav className="sticky top-0 z-30 border-b border-white/10 bg-gradient-to-r from-teal-800 via-teal-700 to-emerald-600 shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_2px_8px_rgba(49,46,129,0.25)]">
      <div className="flex h-14 items-center gap-2 px-4 sm:gap-4 sm:px-6">
        {/* Drawer trigger. Only below `md`, where the sidebar is not in the
            flow. 44px square to clear the touch-target floor the mobile e2e
            helper asserts. */}
        {nav && (
          <button
            type="button"
            data-testid="mobile-nav-trigger"
            onClick={nav.toggle}
            // A disclosure button keeps ONE accessible name and communicates its
            // state through `aria-expanded`. Flipping the name to "Close…" made
            // it collide with the drawer's own close button, leaving two visible
            // controls with the same name on a phone.
            aria-label="Navigation menu"
            aria-expanded={nav.isOpen}
            className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/80 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 md:hidden"
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
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}

        {/* Brand lockup */}
        <Link
          href={homeHref}
          aria-label="Deckgauge home"
          className="group flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-teal-600 shadow-sm ring-1 ring-black/5 transition-transform duration-200 group-hover:scale-105">
            <DeckgaugeMark className="h-6 w-6" />
          </span>
          <span className="hidden text-[15px] leading-none text-white sm:block">
            <span className="font-semibold tracking-tight">Deck</span>
            <span className="font-light text-white/85">gauge</span>
          </span>
        </Link>

        {/* Divider */}
        <span className="hidden h-6 w-px bg-white/15 sm:block" aria-hidden="true" />

        {/* Primary navigation. Hidden below `md`; the drawer renders the same
            items there. */}
        <div className="hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => {
            const active = item.isActive(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.resume ? homeHref : item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "relative flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium",
                  "outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-white/60",
                  active
                    ? "bg-white/15 text-white ring-1 ring-inset ring-white/10"
                    : "text-white/70 hover:bg-white/10 hover:text-white",
                ].join(" ")}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
                {active && (
                  <span
                    className="absolute -bottom-[9px] left-3 right-3 h-0.5 rounded-full bg-white"
                    aria-hidden="true"
                  />
                )}
              </Link>
            );
          })}
        </div>

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-2">
          {/* Renders nothing at all while there is nothing unread, so the header
              does not grow a permanently-empty control. */}
          <NotificationBell />
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </nav>
  );
}
