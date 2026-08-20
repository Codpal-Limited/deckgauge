// In-memory TTL cache with inflight dedup, used by board-source dynamic
// discovery (issue types, work-item types, labels). Provider APIs are
// rate-limited; caching their type lists for ~60s lets the web status-mapping
// editor render distinct values without hammering Jira/ADO on every keystroke.
//
// The key shape is opaque to callers — they pass a structured `TypeCacheKey`
// and the cache stringifies internally so we can expose `invalidate({...})`
// symmetrically to `getOrFetch({...}, loader)`.

export interface TypeCacheKey {
  /**
   * The tenant whose connection the values were discovered through.
   *
   * The key was once provider|kind|resource, with no tenant in it. A resource
   * name is NOT unique across organizations — a Jira project key, a GitHub org
   * login and an ADO project name are all attacker- or coincidence-choosable —
   * so two organizations discovering a same-named resource collided on one
   * entry and, for the whole TTL, one tenant was served the other's discovered
   * values.
   */
  organizationId: string;
  /**
   * The specific connection the values came from. Strictly finer-grained than
   * `organizationId` (an instance belongs to exactly one organization), and
   * carried as well as it rather than instead of it: it additionally separates
   * two connections WITHIN one organization — two Jira sites can both expose a
   * project called "PLATFORM", and their issue-type lists are not the same
   * list.
   */
  instanceId: string;
  provider: 'jira' | 'github' | 'ado';
  // 'issue-types' | 'work-item-types' | 'labels' | 'org-issue-types' — kept
  // open as `string` so new discovery kinds can be added without churn here.
  kind: string;
  // projectKey, repoFullName, orgLogin, etc.
  resource: string;
}

export interface TypeCache {
  getOrFetch<T>(key: TypeCacheKey, loader: () => Promise<T>): Promise<T>;
  invalidate(key: TypeCacheKey): void;
}

export interface TypeCacheOptions {
  ttlMs: number;
  now?: () => number;
}

interface Entry {
  expiresAt: number;
  inflight?: Promise<unknown>;
  value?: unknown;
}

export function createTypeCache(opts: TypeCacheOptions): TypeCache {
  const now = opts.now ?? (() => Date.now());
  const store = new Map<string, Entry>();
  // Tenant and connection lead the key so that no combination of the
  // caller-influenced tail (provider/kind/resource) can reach another tenant's
  // entry. Both are opaque cuid/uuid ids, so no separator escaping is needed.
  const k = (key: TypeCacheKey): string =>
    `${key.organizationId}|${key.instanceId}|${key.provider}|${key.kind}|${key.resource}`;

  return {
    async getOrFetch<T>(key: TypeCacheKey, loader: () => Promise<T>): Promise<T> {
      const cacheKey = k(key);
      const existing = store.get(cacheKey);
      if (existing) {
        if (existing.inflight) return existing.inflight as Promise<T>;
        if (existing.expiresAt > now()) return existing.value as T;
      }
      const inflight = loader().then(
        (value) => {
          store.set(cacheKey, { value, expiresAt: now() + opts.ttlMs });
          return value;
        },
        (err) => {
          store.delete(cacheKey);
          throw err;
        },
      );
      store.set(cacheKey, { inflight, expiresAt: 0 });
      return inflight;
    },
    invalidate(key: TypeCacheKey): void {
      store.delete(k(key));
    },
  };
}
