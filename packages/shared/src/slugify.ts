/** Matches BootstrapOrganizationSchema's slug rule. */
const MAX_SLUG_LENGTH = 50;
const FALLBACK = 'organization';

/**
 * Derives a URL slug from an organization name.
 *
 * The first-run screen asks only for a name, so this runs on operator-supplied
 * text and must ALWAYS return something `BootstrapOrganizationSchema` accepts
 * (`/^[a-z0-9-]+$/`, 1–50 chars). A name of pure punctuation or non-latin script
 * yields nothing usable, so it falls back rather than returning '' and turning
 * the first screen a new operator sees into a 400.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    // Strip combining marks left by NFKD, so "é" → "e" rather than being dropped.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Drop apostrophes and quotes entirely (not separators).
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    // Truncation can land on a hyphen; trim again after slicing.
    .replace(/-+$/g, '');

  return slug.length > 0 ? slug : FALLBACK;
}
