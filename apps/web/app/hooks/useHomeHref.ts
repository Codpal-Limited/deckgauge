'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isResumableLocation, readLastLocationCookie } from '../utils/last-location-cookie';

/**
 * Resolves where "Home" points, extracted from `Header` when the mobile nav
 * drawer became a second renderer of the primary nav.
 *
 * "Home" covers the whole workspace, so it resumes the last workspace location:
 * while already in one that is the current URL (making Home a no-op re-entry),
 * and on a chrome page (Settings/Sources) it is the last recorded location,
 * falling back to "/" which opens the last board.
 *
 * The cookie read is deliberately in an effect rather than during render —
 * `document.cookie` does not exist on the server, and reading it during render
 * would make the first client render disagree with the server's.
 */
export function useHomeHref(): string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [homeHref, setHomeHref] = useState('/');

  useEffect(() => {
    if (pathname && isResumableLocation(pathname)) {
      const qs = searchParams?.toString();
      setHomeHref(qs ? `${pathname}?${qs}` : pathname);
    } else {
      setHomeHref(readLastLocationCookie() ?? '/');
    }
  }, [pathname, searchParams]);

  return homeHref;
}
