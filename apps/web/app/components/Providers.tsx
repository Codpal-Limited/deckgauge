'use client';

import { SessionProvider } from 'next-auth/react';
import { SessionExpiredProvider } from './SessionExpiredContext';
import { AdvisorProvider } from '../../components/advisor/AdvisorProvider';
import { AdvisorPanel } from '../../components/advisor/AdvisorPanel';
import { AdvisorLauncher } from '../../components/advisor/AdvisorLauncher';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider refetchInterval={4 * 60}>
      <SessionExpiredProvider>
        <AdvisorProvider>
          {children}
          {/* Rendered once, above the page tree, so a conversation survives
              route navigation and keeps streaming while docked. */}
          <AdvisorPanel />
          <AdvisorLauncher />
        </AdvisorProvider>
      </SessionExpiredProvider>
    </SessionProvider>
  );
}
