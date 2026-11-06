'use server';

import { MyProfileSchema, type MyProfile } from '@deckgauge/shared';
import { authFetch } from './api';

/** The signed-in person's profile, or `null` when it cannot be loaded. Never throws. */
export async function fetchMyProfile(): Promise<MyProfile | null> {
  try {
    const res = await authFetch('/me/profile', { cache: 'no-store' });
    if (!res.ok) return null;
    const parsed = MyProfileSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Just the photo URL, for the header avatar. `null` = no photo or not loadable. */
export async function fetchMyAvatarUrl(): Promise<string | null> {
  return (await fetchMyProfile())?.avatarUrl ?? null;
}
