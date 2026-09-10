import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { Header } from './Header';
import { LastLocationTracker } from './LastLocationTracker';
import { MobileNavProvider } from './MobileNavProvider';
import { ResponsiveSidebar } from './ResponsiveSidebar';
import { BoardSidebarContainer } from './sidebar/BoardSidebarContainer';

/**
 * The authenticated application shell. Extracted from `layout.tsx` so `OrgGate`
 * can withhold it on the onboarding screens without those screens having to
 * live under a second root layout.
 *
 * `children` stay nested inside `<main>` exactly as before — moving them out
 * would drop the sidebar, padding and max-width from every page.
 *
 * Below `md` the sidebar moves into a drawer (`ResponsiveSidebar`) and the
 * header grows a hamburger. `MobileNavProvider` holds the open/close state
 * because the trigger and the drawer are siblings here, not parent and child.
 */
export function AppChrome({
  children,
  activeBoardId,
}: {
  children: ReactNode;
  activeBoardId: string | null;
}) {
  return (
    <MobileNavProvider>
      <Suspense fallback={null}>
        <Header />
      </Suspense>
      <Suspense fallback={null}>
        <LastLocationTracker />
      </Suspense>
      <div className="flex">
        {/* The sidebar is server-rendered and passed through as children, so
            moving it into the drawer costs no extra request and no duplicate
            subtree. */}
        <ResponsiveSidebar>
          <Suspense fallback={null}>
            <BoardSidebarContainer activeBoardId={activeBoardId} />
          </Suspense>
        </ResponsiveSidebar>
        {/* `min-w-0` is load-bearing, not tidiness: a flex child defaults to
            `min-width: auto` and so refuses to shrink below its content's
            intrinsic width. Without it a single wide table or long unbroken
            string pushes `<main>` past the viewport and the whole PAGE scrolls
            sideways — which is the exact failure the mobile e2e helper asserts
            against. */}
        <main className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-6">
          <div className="mx-auto max-w-[1400px]">{children}</div>
        </main>
      </div>
    </MobileNavProvider>
  );
}
