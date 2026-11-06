// Bitbucket Cloud REST 2.0 client — the single HTTP seam every Bitbucket
// adapter goes through.
//
// Auth is HTTP Basic `email:apiToken` with an Atlassian API token CREATED WITH
// BITBUCKET SCOPES. A plain Atlassian token (the default "Create API token"
// button) authenticates against nothing here: Bitbucket answers
//   401 {"type":"error","error":{"message":"API Token provided has no Bitbucket scopes."}}
// That is the most likely onboarding mistake, so it gets its own error kind
// rather than collapsing into "invalid credentials".
//
// Behaviour the adapters rely on:
//   - pagination follows the top-level `next` URL (never computes page numbers);
//   - redirects are followed (`/diffstat` answers 302);
//   - 429 / 5xx / network failures retry up to 5 times, honouring Retry-After
//     (Bitbucket sends none on normal responses, but may on a 429);
//   - credentials are only ever sent to the configured API origin — a `next`
//     link pointing anywhere else is refused rather than followed;
//   - no error message ever contains the token.
//
// Deliberately free of `node:*` imports and `Buffer`: the root barrel of this
// package reaches client components in apps/web.

export const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0';

export type BitbucketAuthErrorKind = 'no-bitbucket-scopes' | 'invalid' | 'forbidden';

export class BitbucketAuthError extends Error {
  readonly kind: BitbucketAuthErrorKind;
  readonly status: number;
  constructor(kind: BitbucketAuthErrorKind, status: number, message: string) {
    super(message);
    this.name = 'BitbucketAuthError';
    this.kind = kind;
    this.status = status;
  }
}

export class BitbucketApiError extends Error {
  readonly status: number;
  /** Path + query of the failing request (never carries credentials). */
  readonly path: string;
  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = 'BitbucketApiError';
    this.status = status;
    this.path = path;
  }
}

export interface BitbucketClientConfig {
  email: string;
  apiToken: string;
  /** Defaults to https://api.bitbucket.org/2.0 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable delay — tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries AFTER the first attempt. Default 5. */
  maxRetries?: number;
  /** Base backoff; attempt N waits backoffMs * 2^N. Default 500. */
  backoffMs?: number;
  /** Cap on a server-supplied Retry-After. Default 120000. */
  maxRetryAfterMs?: number;
  /** Per-attempt timeout covering headers AND body read. Default 30000. */
  timeoutMs?: number;
}

/** The envelope every Bitbucket 2.0 list endpoint returns. */
export interface BitbucketPage<T> {
  values: T[];
  next?: string;
  pagelen?: number;
  page?: number;
  size?: number;
}

export interface BitbucketPaginateOpts {
  /** Hard stop on pages fetched. Default 1000. */
  maxPages?: number;
}

/** `acme/web-app` → `/repositories/acme/web-app`, each segment URL-encoded. */
export function bitbucketRepoPath(repoFullName: string): string {
  const [workspace, slug, ...rest] = repoFullName.split('/');
  if (!workspace || !slug || rest.length > 0) {
    throw new Error(`Bitbucket: expected "workspace/repo", got "${repoFullName}"`);
  }
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

const defaultSleep =(ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const NO_SCOPES_RE = /no bitbucket scopes/i;

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

async function readErrorMessage(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: { message?: string } } | null;
    return body?.error?.message ?? '';
  } catch {
    return '';
  }
}

export class BitbucketClient {
  private readonly base: URL;
  private readonly authorization: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly timeoutMs: number;

  constructor(cfg: BitbucketClientConfig) {
    this.base = new URL((cfg.baseUrl ?? BITBUCKET_API_BASE).replace(/\/+$/, ''));
    this.authorization = `Basic ${base64(`${cfg.email}:${cfg.apiToken}`)}`;
    this.doFetch = cfg.fetchImpl ?? fetch;
    this.sleep = cfg.sleep ?? defaultSleep;
    this.maxRetries = cfg.maxRetries ?? 5;
    this.backoffMs = cfg.backoffMs ?? 500;
    this.maxRetryAfterMs = cfg.maxRetryAfterMs ?? 120_000;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  /** Resolve `/user` or an absolute `next` URL; refuse foreign origins. */
  private resolve(pathOrUrl: string, params?: Record<string, string>): URL {
    let url: URL;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      url = new URL(pathOrUrl);
      if (url.origin !== this.base.origin) {
        throw new Error(`Bitbucket: refusing to send credentials to ${url.origin}`);
      }
    } else {
      const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
      url = new URL(`${this.base.href.replace(/\/+$/, '')}${path}`);
    }
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
    return url;
  }

  async get<T>(pathOrUrl: string, params?: Record<string, string>): Promise<T> {
    const url = this.resolve(pathOrUrl, params);
    const display = url.pathname + url.search;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let resp: Response;
      try {
        resp = await this.doFetch(url.href, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Authorization: this.authorization, Accept: 'application/json' },
        });
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs * 2 ** attempt);
          continue;
        }
        throw new BitbucketApiError(0, display, `Bitbucket request failed for ${display}`);
      }

      try {
        if (resp.ok) return (await resp.json()) as T;

        const retryable = resp.status === 429 || resp.status >= 500;
        if (retryable && attempt < this.maxRetries) {
          const ra = parseRetryAfter(resp.headers.get('Retry-After'));
          await this.sleep(ra !== null ? Math.min(ra, this.maxRetryAfterMs) : this.backoffMs * 2 ** attempt);
          continue;
        }

        const message = await readErrorMessage(resp);
        if (resp.status === 401) {
          if (NO_SCOPES_RE.test(message)) {
            throw new BitbucketAuthError(
              'no-bitbucket-scopes',
              401,
              'The API token has no Bitbucket scopes (a plain Atlassian API token).',
            );
          }
          throw new BitbucketAuthError('invalid', 401, 'Bitbucket rejected the email / API token.');
        }
        if (resp.status === 403) {
          throw new BitbucketAuthError(
            'forbidden',
            403,
            `Bitbucket denied access to ${display}${message ? `: ${message}` : ''}`,
          );
        }
        throw new BitbucketApiError(
          resp.status,
          display,
          `Bitbucket ${resp.status} for ${display}${message ? `: ${message}` : ''}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    // Unreachable: the loop returns or throws.
    throw lastErr instanceof Error ? lastErr : new BitbucketApiError(0, display, 'Bitbucket: retries exhausted');
  }

  /** Yields each page's `values`, following `next` until it is absent. */
  async *paginate<T>(
    path: string,
    params: Record<string, string> = {},
    opts: BitbucketPaginateOpts = {},
  ): AsyncGenerator<T[]> {
    const maxPages = opts.maxPages ?? 1000;
    let page = await this.get<BitbucketPage<T>>(path, params);
    for (let n = 1; ; n++) {
      yield page.values ?? [];
      if (!page.next || n >= maxPages) return;
      page = await this.get<BitbucketPage<T>>(page.next);
    }
  }
}
