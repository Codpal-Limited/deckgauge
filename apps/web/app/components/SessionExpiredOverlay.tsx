'use client';

import { signIn } from 'next-auth/react';
import { useSessionExpired } from './SessionExpiredContext';

export function SessionExpiredOverlay() {
  const { isSessionExpired } = useSessionExpired();

  if (!isSessionExpired) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 shadow-sm">
          <span className="text-xl font-bold text-white">V</span>
        </div>

        <h2 className="text-lg font-semibold text-slate-800">
          Your session has expired
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Please sign in again to continue
        </p>

        <div className="mt-6 space-y-3">
          <button
            onClick={() => signIn('keycloak')}
            className="btn-primary w-full"
          >
            Continue with Keycloak
          </button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-white px-2 text-slate-400">or</span>
            </div>
          </div>

          {/* Routed through the provider, like the login page: a hand-built
              /registrations link hard-codes the build-time issuer and skips the
              PKCE verifier + state NextAuth needs for the callback to validate. */}
          <button
            onClick={() => signIn('keycloak-register')}
            className="btn-secondary w-full"
          >
            Create an account
          </button>
        </div>
      </div>
    </div>
  );
}
