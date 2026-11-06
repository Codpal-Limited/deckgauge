'use client';

import { useSession, signOut } from 'next-auth/react';
import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { OrgSwitcher } from './OrgSwitcher';
import { fetchMyAvatarUrl } from '../actions/profile';
import { AVATAR_CHANGED_EVENT } from '../profile/ProfilePhotoEditor';

const LOGOUT_URL_ENDPOINT = '/api/logout-url';

// The end-session URL is assembled by the server, which knows the runtime Keycloak
// issuer. Building it here would mean NEXT_PUBLIC_KEYCLOAK_ISSUER, which Next inlines
// at build time — sending every self-hosted install to the build machine's Keycloak.
async function fetchLogoutUrl(fallbackUrl: string): Promise<string> {
  try {
    const res = await fetch(LOGOUT_URL_ENDPOINT);
    if (!res.ok) return fallbackUrl;
    const { url } = (await res.json()) as { url?: string };
    return url ?? fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0][0].toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return '?';
}

export function UserMenu() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const signedIn = !!session?.user;

  // The photo is not in the session (it changes without a new token), so it is
  // fetched once per sign-in and again whenever the profile page changes it.
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    fetchMyAvatarUrl()
      .then((u) => {
        if (live) {
          setAvatarUrl(u);
          setAvatarBroken(false);
        }
      })
      .catch(() => undefined);
    function onChanged(e: Event) {
      const next = (e as CustomEvent<{ avatarUrl: string | null }>).detail?.avatarUrl ?? null;
      setAvatarUrl(next);
      setAvatarBroken(false);
    }
    window.addEventListener(AVATAR_CHANGED_EVENT, onChanged);
    return () => {
      live = false;
      window.removeEventListener(AVATAR_CHANGED_EVENT, onChanged);
    };
  }, [signedIn]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!session?.user) return null;

  const initials = getInitials(session.user.name, session.user.email);

  // Federated (RP-initiated) logout: clear the local NextAuth session AND end the
  // Keycloak SSO session, so the next sign-in shows a fresh login/registration
  // screen instead of silently re-authenticating the same account.
  async function handleSignOut() {
    // Ask for the URL first: the server reads the id_token from the session cookie,
    // which signOut is about to delete.
    const logoutUrl = await fetchLogoutUrl(`${window.location.origin}/login`);
    await signOut({ redirect: false });
    window.location.href = logoutUrl;
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        aria-label="User menu"
        // 32 -> 44px on phones. Like ThemeToggle this changes the VISUAL: the
        // avatar becomes a 44px gradient circle. Deliberate, and it fits the
        // 56px header row.
        className="flex h-11 w-11 items-center justify-center rounded-full md:h-8 md:w-8
          bg-gradient-to-br from-violet-400 to-purple-600
          text-xs font-semibold text-white
          ring-2 ring-white/30
          transition-all hover:ring-white/50 overflow-hidden"
      >
        {avatarUrl && !avatarBroken ? (
          <img
            src={avatarUrl}
            alt=""
            onError={() => setAvatarBroken(true)}
            className="h-full w-full rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-56 rounded-lg bg-white py-1 shadow-dropdown animate-fade-in">
          <div className="px-4 py-2 text-xs text-slate-500 truncate">
            {session.user.email}
          </div>
          <div className="mx-2 border-t border-slate-100" />
          <Link
            href="/profile"
            onClick={() => setOpen(false)}
            className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 transition-colors"
          >
            My profile
          </Link>
          {/* Renders nothing unless the caller belongs to more than one
              organization, which is nobody under the one-organization cap. */}
          <OrgSwitcher />
          <button
            onClick={handleSignOut}
            aria-label="Sign out"
            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
