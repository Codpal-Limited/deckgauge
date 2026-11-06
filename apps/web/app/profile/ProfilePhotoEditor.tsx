'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_AVATAR_BYTES } from '@deckgauge/shared';

/** Fired on `window` after the photo changes, so the header avatar can refresh. */
export const AVATAR_CHANGED_EVENT = 'deckgauge:avatar-changed';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

function initialsOf(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]![0]!.toUpperCase();
  return (email[0] ?? '?').toUpperCase();
}

export function ProfilePhotoEditor({
  name,
  email,
  avatarUrl,
}: {
  name: string;
  email: string;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(avatarUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  function changed(next: string | null) {
    setUrl(next);
    setBroken(false);
    window.dispatchEvent(new CustomEvent(AVATAR_CHANGED_EVENT, { detail: { avatarUrl: next } }));
    router.refresh();
  }

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_AVATAR_BYTES) {
      setError('That photo is larger than 5 MB. Please choose a smaller one.');
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const res = await fetch('/api/me/avatar', { method: 'PUT', body });
      if (!res.ok) {
        setError(
          res.status === 413
            ? 'That photo is larger than 5 MB. Please choose a smaller one.'
            : res.status === 400
              ? 'That file is not a supported image. Use PNG, JPEG, GIF or WebP.'
              : 'The photo could not be saved. Please try again.',
        );
        return;
      }
      const { avatarUrl: next } = (await res.json()) as { avatarUrl: string };
      changed(next);
    } catch {
      setError('The photo could not be saved. Please try again.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/me/avatar', { method: 'DELETE' });
      if (!res.ok) {
        setError('The photo could not be removed. Please try again.');
        return;
      }
      changed(null);
    } catch {
      setError('The photo could not be removed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-5">
      {url && !broken ? (
        <img
          src={url}
          alt="Your profile photo"
          onError={() => setBroken(true)}
          className="h-24 w-24 rounded-full object-cover ring-2 ring-slate-200"
        />
      ) : (
        <span
          role="img"
          aria-label="No profile photo"
          className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-purple-600 text-2xl font-semibold text-white"
        >
          {initialsOf(name, email)}
        </span>
      )}
      <div className="flex flex-col items-center gap-2 sm:items-start">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="min-h-11 rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50 md:min-h-0"
          >
            {busy ? 'Saving…' : url ? 'Change photo' : 'Upload photo'}
          </button>
          {url && (
            <button
              type="button"
              disabled={busy}
              onClick={remove}
              className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 md:min-h-0"
            >
              Remove
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">PNG, JPEG, GIF or WebP, up to 5 MB.</p>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          aria-label="Choose a profile photo"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
    </div>
  );
}
