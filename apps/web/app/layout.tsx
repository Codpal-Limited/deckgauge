import type { Metadata } from "next";
import "./globals.css";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { Header } from "./components/Header";
import { LastLocationTracker } from "./components/LastLocationTracker";
import { Providers } from "./components/Providers";
import { SessionExpiredOverlay } from "./components/SessionExpiredOverlay";
import { BoardSidebarContainer } from "./components/sidebar/BoardSidebarContainer";
import { LAST_BOARD_COOKIE } from "./utils/last-board-cookie";
import { Toaster } from "sonner";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Deckgauge",
  description: "Open-source development intelligence — see how your software really gets built",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The layout has no ?boardId (search params aren't available here), so the sidebar
  // highlights the last-viewed board from the cookie; the board page keeps that cookie
  // current on every navigation via setLastBoardCookie.
  const activeBoardId = cookies().get(LAST_BOARD_COOKIE)?.value ?? null;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme class before first paint to avoid a light→dark flash.
            Honours a saved choice, else the OS preference. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();",
          }}
        />
      </head>
      <body className="min-h-screen bg-slate-50">
        <Providers>
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
          <SessionExpiredOverlay />
          <Toaster position="bottom-right" richColors closeButton offset={80} />
        </Providers>
      </body>
    </html>
  );
}
