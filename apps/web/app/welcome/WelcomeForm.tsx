'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { slugify } from '@deckgauge/shared';
import { createOrganization } from '../actions/organization';

const MESSAGES: Record<string, string> = {
  ORGANIZATION_EXISTS: 'This Deckgauge already has an organization.',
  SLUG_TAKEN: 'That name is already taken. Try a different one.',
  NETWORK_ERROR: 'Could not reach the server. Check your connection and try again.',
  // Only the FIRST user to sign in on an empty deployment is granted the
  // instance-admin flag, so a second early arrival is refused here. Without this
  // message they read "Forbidden", cannot reach any other page (the gate
  // redirects every path back to /welcome), and are stuck for good.
  Forbidden:
    'Only the first person to sign in can create the organization. Ask them to finish setup, then sign in again.',
};

export function WelcomeForm() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const trimmed = name.trim();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createOrganization(trimmed);
    setBusy(false);
    if (result.ok) {
      router.push('/');
      router.refresh();
      return;
    }
    // The action RETURNS its error, so a real message is available here rather
    // than an opaque digest.
    setError(MESSAGES[result.error] ?? `Could not create the organization (${result.error}).`);
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto mt-24 max-w-md space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Welcome to Deckgauge</h1>
      <p className="text-sm text-slate-600">
        Name the organization this Deckgauge belongs to. You will be its administrator.
      </p>

      <label htmlFor="org-name" className="block text-sm font-medium">
        Organization name
      </label>
      <input
        id="org-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Acme Engineering"
        className="w-full rounded border border-slate-300 px-3 py-2"
      />
      {trimmed.length > 0 && (
        <p className="text-xs text-slate-500">
          URL identifier: <span className="font-mono">{slugify(trimmed)}</span>
        </p>
      )}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={trimmed.length === 0 || busy}
        className="rounded bg-teal-600 px-4 py-2 text-white disabled:opacity-50"
      >
        Create organization
      </button>

      {/* The gate redirects every other path back here, so without this a user
          who cannot create the organization has no way to switch accounts. */}
      <a href="/api/auth/signout" className="block text-xs text-slate-500 underline">
        Sign out
      </a>
    </form>
  );
}
