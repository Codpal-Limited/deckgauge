'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { readLastBoardCookie } from '../../app/utils/last-board-cookie';
import { resolveAdvisorBoardId } from './advisor-route';

interface AdvisorRouteBinderProps {
  onBoardChange(boardId: string | null): void;
}

/**
 * Reports the board of the current route to the provider. Renders nothing.
 *
 * A separate component, rather than router hooks inside `AdvisorProvider`
 * itself, for two reasons: `useSearchParams` needs a Suspense boundary and the
 * provider wraps the entire app (it cannot be the thing that suspends), and
 * keeping the hooks out of the provider leaves the provider's own tests free
 * of router mocks.
 */
export function AdvisorRouteBinder({ onBoardChange }: AdvisorRouteBinderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const boardIdParam = searchParams?.get('boardId') ?? null;

  useEffect(() => {
    // Read the cookie inside the effect: it is written by the board page on
    // navigation, so reading it during render could use a value from before
    // that write.
    onBoardChange(resolveAdvisorBoardId(pathname, boardIdParam, readLastBoardCookie()));
  }, [pathname, boardIdParam, onBoardChange]);

  return null;
}
