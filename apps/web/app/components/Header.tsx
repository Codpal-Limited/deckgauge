"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "./NotificationBell";
import { ThemeToggle } from "./ThemeToggle";
import { DeckgaugeMark } from "./DeckgaugeMark";
import { isResumableLocation, readLastLocationCookie } from "../utils/last-location-cookie";

type IconProps = SVGProps<SVGSVGElement>;

function HomeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 9.5 12 3l9 6.5" />
      <path d="M5 10v9a1 1 0 0 0 1 1h3v-6h6v6h3a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

function SourcesIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  );
}

function SettingsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<IconProps>;
  /** Whether this item is the active one for the given pathname. */
  isActive: (pathname: string) => boolean;
  /** Home resolves its href at runtime to the last workspace location. */
  resume?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  // "Home" covers the whole workspace (boards, roadmaps, org trees, timesheets),
  // so it's lit on any resumable location and its href resolves at runtime.
  { href: "/", label: "Home", icon: HomeIcon, resume: true, isActive: isResumableLocation },
  {
    href: "/sources",
    label: "Sources",
    icon: SourcesIcon,
    isActive: (p) => p === "/sources" || p.startsWith("/sources/"),
  },
  {
    href: "/settings/timesheet-statuses",
    label: "Settings",
    icon: SettingsIcon,
    isActive: (p) => p === "/settings" || p.startsWith("/settings/"),
  },
];

export function Header() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [homeHref, setHomeHref] = useState("/");

  // "Home" resumes the last workspace location. While already in one, that's the
  // current URL (so Home is a no-op re-entry); on a chrome page (Settings/Sources)
  // it's the last recorded location, falling back to "/" (which opens the last board).
  useEffect(() => {
    if (pathname && isResumableLocation(pathname)) {
      const qs = searchParams?.toString();
      setHomeHref(qs ? `${pathname}?${qs}` : pathname);
    } else {
      setHomeHref(readLastLocationCookie() ?? "/");
    }
  }, [pathname, searchParams]);

  // Login page renders its own nav bar — hide the shared header
  if (pathname === "/login") return null;

  return (
    <nav className="sticky top-0 z-30 border-b border-white/10 bg-gradient-to-r from-teal-800 via-teal-700 to-emerald-600 shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_2px_8px_rgba(49,46,129,0.25)]">
      <div className="flex h-14 items-center gap-4 px-4 sm:px-6">
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

        {/* Primary navigation */}
        <div className="flex items-center gap-1">
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
