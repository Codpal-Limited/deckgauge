import type { PrismaClient } from '@deckgauge/db';

/** The URL a stored profile photo is served at. The upload id makes it cache-safe. */
export function userAvatarUrl(uploadId: string): string {
  return `/api/user-avatars/${uploadId}`;
}

/**
 * Self-chosen profile photos for the people on one organization's org chart,
 * keyed by lowercased email.
 *
 * Only ACTIVE members of `organizationId` count. That scoping is the whole
 * point: an org chart belongs to one tenant, and a user who happens to share an
 * email with a row on ANOTHER tenant's chart must not put their face on it.
 */
export async function userAvatarsByEmail(
  prisma: PrismaClient,
  organizationId: string,
  emails: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(emails.flatMap((e) => (e && e.trim() ? [e.trim().toLowerCase()] : [])))];
  if (wanted.length === 0) return new Map();
  const memberships = await prisma.orgMembership.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      user: { avatarUploadId: { not: null }, email: { in: wanted, mode: 'insensitive' } },
    },
    select: { user: { select: { email: true, avatarUploadId: true } } },
  });
  const out = new Map<string, string>();
  for (const m of memberships) {
    if (m.user?.avatarUploadId) out.set(m.user.email.toLowerCase(), userAvatarUrl(m.user.avatarUploadId));
  }
  return out;
}
