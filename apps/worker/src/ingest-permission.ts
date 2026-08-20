import type { WorkerEditionModule } from './edition-loader.js';

export interface IngestPermission {
  allowed(): Promise<boolean>;
}

/**
 * Whether an organization may ingest, according to the loaded edition module.
 *
 * Memoised per instance: it is consulted from the ClickHouse write path, which runs
 * many times per job, so resolving per write would put a round trip in front of
 * every batch insert.
 *
 * **Community (no module, or no hook) always allows ingest.** The free product has
 * no such restriction at all, rather than a disabled one.
 *
 * When a module IS present and its hook throws, this fails CLOSED. The asymmetry
 * against the request path is deliberate: refusing to ingest is recoverable — the
 * next sync catches up — while ingesting for an organization that should not be is
 * not.
 */
export function createIngestPermission(
  organizationId: string,
  edition: WorkerEditionModule | null,
  log: (message: string) => void = console.warn,
): IngestPermission {
  let cached: boolean | null = null;
  return {
    async allowed(): Promise<boolean> {
      if (cached !== null) return cached;
      if (!edition?.allowIngest) {
        cached = true;
        return cached;
      }
      try {
        cached = await edition.allowIngest(organizationId);
      } catch (err) {
        log(
          `[edition] allowIngest failed for organization ${organizationId}; pausing ingest: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        cached = false;
      }
      return cached;
    },
  };
}
