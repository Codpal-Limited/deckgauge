import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { Header } from './Header';
import { LastLocationTracker } from './LastLocationTracker';
import { BoardSidebarContainer } from './sidebar/BoardSidebarContainer';

/**
 * The authenticated application shell. Extracted from `layout.tsx` so `OrgGate`
 * can withhold it on the onboarding screens without those screens having to
 * live under a second root layout.
 *
 * `children` stay nested inside `<main>` exactly as before — moving them out
 * would drop the sidebar, padding and max-width from every page.
 */
export function AppChrome({
  children,
  activeBoardId,
}: {
  children: ReactNode;
  activeBoardId: string | null;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <Header />
      </Suspense>
      <Suspense fallback={null}>
        <LastLocationTracker />
      </Suspense>
      <div className="flex">
        <Suspense fallback={null}>
          <BoardSidebarContainer activeBoardId={activeBoardId} />
        </Suspense>
        <main className="flex-1 px-6 py-6">
          <div className="mx-auto max-w-[1400px]">{children}</div>
        </main>
      </div>
    </>
  );
}
