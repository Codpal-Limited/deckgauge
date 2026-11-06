import { sniffImageType, type ImageMimeType } from '../uploads/image-sniff.js';

/**
 * Downloads an employee photo named in an org-chart import.
 *
 * Why download at all: BambooHR's photo URLs are CloudFront-signed and expire
 * 30 days after export, so storing the URL would show photos for a month and
 * then break everywhere. The import stores the bytes instead (spec
 * docs/superpowers/specs/2026-11-04-org-employee-photos-design.md).
 *
 * Why this is careful: the URL comes from an uploaded file, i.e. from anyone
 * with EDITOR on any tree. Fetching it server-side would otherwise turn the
 * api into a proxy onto the internal network (Postgres, ClickHouse, Keycloak,
 * cloud metadata). So:
 *   - https only, no credentials, default port only;
 *   - the host must be an allowlisted suffix — an allowlist rather than an IP
 *     blocklist, because a resolve-then-check is defeated by DNS rebinding;
 *   - redirects are refused rather than followed (the target could be anywhere);
 *   - bounded time and size;
 *   - the bytes must PROVE an image type, and the stored type is the proven one,
 *     so nothing a browser would execute (SVG, HTML) is ever stored or served.
 *
 * Every outcome is a value; nothing here throws. One bad photo must never fail
 * an import.
 */

export type PhotoMimeType = ImageMimeType;

export type PhotoFetchResult =
  | { kind: 'ok'; mimeType: PhotoMimeType; buffer: Buffer }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

export type OrgPhotoFetcher = (url: string) => Promise<PhotoFetchResult>;

const DEFAULT_ALLOWED_HOSTS = ['bamboohr.com'];
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** BambooHR's generic grey silhouette, exported for everyone without a photo. */
const BAMBOO_PLACEHOLDER = /^\/images\/photo_person_/;

/** Allowed host suffixes: BambooHR always, plus `ORG_PHOTO_ALLOWED_HOSTS` (comma-separated). */
export function parseAllowedHosts(env: NodeJS.ProcessEnv): string[] {
  const extra = (env['ORG_PHOTO_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])];
}

/**
 * The URL without its query string. A signed URL's query changes on every
 * export while its path (BambooHR: `/<company>/photos/<person>-<version>-4.jpg`)
 * identifies the photo, so this is what "same photo as last import" compares.
 */
export function photoSourceOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function hostAllowed(hostname: string, allowed: string[]): boolean {
  return allowed.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createOrgPhotoFetcher(opts: {
  allowedHosts: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): OrgPhotoFetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowed = opts.allowedHosts.map((h) => h.toLowerCase());

  return async (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: 'failed', reason: 'not a valid URL' };
    }
    if (url.protocol !== 'https:') return { kind: 'failed', reason: 'only https photo links are accepted' };
    if (url.username || url.password) return { kind: 'failed', reason: 'photo link carries credentials' };
    if (url.port !== '') return { kind: 'failed', reason: 'photo link uses a non-default port' };
    if (!hostAllowed(url.hostname, allowed)) {
      return { kind: 'failed', reason: `photo host ${url.hostname} is not allowed` };
    }
    if (BAMBOO_PLACEHOLDER.test(url.pathname)) return { kind: 'skipped', reason: 'placeholder image' };

    try {
      const res = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        return { kind: 'failed', reason: 'photo link redirects' };
      }
      if (!res.ok) return { kind: 'failed', reason: `HTTP ${res.status}` };
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        return { kind: 'failed', reason: 'photo too large' };
      }
      const buffer = await readCapped(res, maxBytes);
      if (!buffer) return { kind: 'failed', reason: 'photo too large' };
      const mimeType = sniffImageType(buffer);
      if (!mimeType) return { kind: 'failed', reason: 'not a JPEG, PNG, GIF or WebP image' };
      return { kind: 'ok', mimeType, buffer };
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'failed', reason: 'download timed out' };
      return { kind: 'failed', reason: `download failed: ${(err as Error)?.message ?? 'unknown error'}` };
    }
  };
}
