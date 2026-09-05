import { AzureDevOpsPort } from './azure-devops-port.js';
import { AzureDevOpsWorkItem } from './azure-devops-schemas.js';
import { AdoWorkItemRevision } from './ado-work-item-revision.js';
import type { Throttle } from './request-throttle.js';

// ── Error Classes ─────────────────────────────────────────────────────────────

export class AzureDevOpsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzureDevOpsAuthError';
  }
}

export class AzureDevOpsCircuitOpenError extends Error {
  constructor() {
    super('Azure DevOps circuit breaker is open — too many consecutive failures');
    this.name = 'AzureDevOpsCircuitOpenError';
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

interface AzureDevOpsAdapterConfig {
  orgUrl: string;
  authMethod: 'PAT' | 'BASIC';
  accessToken: string;
  username?: string;
  /**
   * Optional client-side pacing, shared with the ADO PR/commit adapters so all
   * ADO traffic spends one account-wide budget. Omitted in tests.
   */
  throttle?: Throttle;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 200;
const MAX_RETRIES = 4;
const TIMEOUT_MS = 15_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Page size for keyset WIQL paging. Azure DevOps caps a single WIQL result at
 * 20,000 work items and returns HTTP 400 (VS402337) when the match set would
 * exceed it — so an unbounded `SELECT [System.Id] … WHERE [System.TeamProject]`
 * fails for any project with >20k items. We page by ascending `System.Id` and
 * pass `$top` below the cap so no individual query ever trips it. 19,000 leaves
 * headroom (empirically `$top=20000` still 400s; `$top=19000` returns 200).
 */
export const WIQL_PAGE_SIZE = 19_000;

/** Cap surfaced error bodies so a huge error payload can't bloat logs. */
const MAX_ERROR_BODY_CHARS = 500;

// ── Internal Types ────────────────────────────────────────────────────────────

type FetchFn = typeof fetch;
type DelayFn = (ms: number) => Promise<void>;

interface RawWorkItemRef {
  id: number;
}

interface RawRelation {
  rel: string;
  url: string;
}

interface RawWorkItemFields {
  'System.WorkItemType': string;
  'System.Title': string;
  'System.State': string;
  'System.AssignedTo': { displayName: string } | null;
  'System.AreaPath': string | null;
  'System.IterationPath': string | null;
  'System.Description': string | null;
  'System.CreatedDate'?: string;
  'System.ChangedDate'?: string;
  'Microsoft.VSTS.Common.ClosedDate'?: string | null;
  [key: string]: unknown;
}

interface RawWorkItem {
  id: number;
  fields: RawWorkItemFields;
  relations?: RawRelation[];
}

interface WiqlResponse {
  workItems: RawWorkItemRef[];
}

interface WorkItemBatchResponse {
  value: RawWorkItem[];
}

interface RawIdentityRef {
  displayName?: string;
}

interface RawRevision {
  id: number;
  rev: number;
  fields: {
    'System.WorkItemType'?: string;
    'System.State'?: string;
    'System.ChangedDate'?: string;
    'System.AssignedTo'?: RawIdentityRef | string | null;
    'System.ChangedBy'?: RawIdentityRef | string | null;
    [key: string]: unknown;
  };
}

interface ReportingRevisionsResponse {
  values: RawRevision[];
  continuationToken?: string;
  isLastBatch: boolean;
}

interface WorkItemTypesResponse {
  value: { name: string }[];
}

interface ProjectsResponse {
  value: { name: string }[];
}

// ── Adapter ───────────────────────────────────────────────────────────────────

function identityName(ref: { displayName?: string } | string | null | undefined): string | null {
  if (ref == null) return null;
  if (typeof ref === 'string') return ref.length > 0 ? ref : null;
  return ref.displayName && ref.displayName.length > 0 ? ref.displayName : null;
}

export class AzureDevOpsRestAdapter implements AzureDevOpsPort {
  private readonly orgUrl: string;
  private readonly authHeader: string;
  private readonly fetchFn: FetchFn;
  private readonly delayFn: DelayFn;
  private readonly wiqlPageSize: number;
  private readonly throttle?: Throttle;
  private consecutiveFailures = 0;

  constructor(
    config: AzureDevOpsAdapterConfig,
    fetchFn: FetchFn = fetch,
    delayFn: DelayFn = (ms) => new Promise((r) => setTimeout(r, ms)),
    wiqlPageSize: number = WIQL_PAGE_SIZE,
  ) {
    this.orgUrl = config.orgUrl.replace(/\/$/, '');
    this.fetchFn = fetchFn;
    this.delayFn = delayFn;
    this.wiqlPageSize = wiqlPageSize;
    this.throttle = config.throttle;

    if (config.authMethod === 'PAT') {
      const encoded = Buffer.from(`:${config.accessToken}`).toString('base64');
      this.authHeader = `Basic ${encoded}`;
    } else {
      const encoded = Buffer.from(`${config.username ?? ''}:${config.accessToken}`).toString(
        'base64',
      );
      this.authHeader = `Basic ${encoded}`;
    }
  }

  async fetchWorkItems(project: string): Promise<AzureDevOpsWorkItem[]> {
    // Collect the streaming fetch into one array. Kept for callers/tests that
    // want the whole set; the worker uses streamWorkItems to avoid buffering an
    // entire large project (e.g. 20k+ items) in memory at once.
    const all: AzureDevOpsWorkItem[] = [];
    for await (const batch of this.streamWorkItems(project)) {
      all.push(...batch);
    }
    return all;
  }

  /**
   * Stream every work item in the project as BATCH_SIZE-sized detail batches.
   *
   * Always unfiltered: yields every work item; per-board type/WIQL narrowing
   * happens in the worker. IDs are resolved up front via keyset WIQL paging
   * (so projects with >20k items don't trip ADO's WIQL cap, VS402337), then
   * details are fetched and yielded one batch at a time — the caller can
   * process and release each batch without ever holding the full set in memory.
   * See planning/SYNC-ARCHITECTURE.md §2.3.
   */
  async *streamWorkItems(project: string): AsyncGenerator<AzureDevOpsWorkItem[]> {
    const ids = await this.queryWorkItemIds(project, []);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const batchUrl = `${this.orgUrl}/_apis/wit/workitems?ids=${batch.join(',')}&$expand=relations&api-version=7.1`;
      const batchResponse = await this.makeRequest(batchUrl);
      const batchData = (await batchResponse.json()) as WorkItemBatchResponse;
      yield batchData.value.map((raw) => this.mapWorkItem(raw));
    }
  }

  /**
   * Stream the project's work-item revisions via the Reporting Work Item
   * Revisions endpoint. One cursor pass returns every revision for the whole
   * project (no per-item calls); we page on `continuationToken` until
   * `isLastBatch`. `since` maps to `startDateTime` for incremental runs.
   */
  async *streamWorkItemRevisions(
    project: string,
    since?: Date,
  ): AsyncGenerator<AdoWorkItemRevision[]> {
    const fields = [
      'System.Id',
      'System.WorkItemType',
      'System.State',
      'System.ChangedDate',
      'System.AssignedTo',
      'System.ChangedBy',
    ].join(',');

    let continuationToken: string | undefined;
    for (;;) {
      const params = new URLSearchParams({
        'api-version': '7.1',
        fields,
        includeIdentityRef: 'true',
      });
      if (since) params.set('startDateTime', since.toISOString());
      if (continuationToken) params.set('continuationToken', continuationToken);

      const url = `${this.orgUrl}/${encodeURIComponent(
        project,
      )}/_apis/wit/reporting/workitemrevisions?${params.toString()}`;
      const response = await this.makeRequest(url);
      const data = (await response.json()) as ReportingRevisionsResponse;

      const batch = (data.values ?? []).map((raw) => this.mapRevision(raw, project));
      if (batch.length > 0) yield batch;

      if (data.isLastBatch || !data.continuationToken) break;
      continuationToken = data.continuationToken;
    }
  }

  private mapRevision(raw: RawRevision, project: string): AdoWorkItemRevision {
    const f = raw.fields;
    const changedRaw = f['System.ChangedDate'];
    return {
      workItemId: raw.id,
      project,
      workItemType: f['System.WorkItemType'] ?? '',
      state: f['System.State'] ?? '',
      assignedTo: identityName(f['System.AssignedTo']),
      changedBy: identityName(f['System.ChangedBy']),
      changedAt: changedRaw ? new Date(changedRaw) : new Date(0),
    };
  }

  async queryMatchingIds(
    project: string,
    allowedTypes: string[],
    wiqlFilter: string | null,
  ): Promise<Set<number>> {
    const esc = (s: string) => s.replace(/'/g, "''");
    const extraClauses: string[] = [];
    if (allowedTypes.length > 0) {
      const typeList = allowedTypes.map((t) => `'${esc(t)}'`).join(',');
      extraClauses.push(`[System.WorkItemType] IN (${typeList})`);
    }
    if (wiqlFilter) {
      extraClauses.push(wiqlFilter);
    }

    const ids = await this.queryWorkItemIds(project, extraClauses);
    return new Set(ids);
  }

  /**
   * Resolve every matching work-item id via keyset WIQL paging.
   *
   * A single `SELECT [System.Id] … WHERE [System.TeamProject] = …` 400s once a
   * project has more than 20,000 matches (ADO error VS402337). We instead page
   * by ascending `System.Id`, carrying a `[System.Id] > lastId` lower bound and
   * a `$top=wiqlPageSize` cap (below 20,000) so no single query can trip the
   * limit. Paging ends when a page returns fewer rows than the page size.
   */
  private async queryWorkItemIds(
    project: string,
    extraClauses: string[],
  ): Promise<number[]> {
    const esc = (s: string) => s.replace(/'/g, "''");
    const wiqlUrl = `${this.orgUrl}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.1&$top=${this.wiqlPageSize}`;

    const ids: number[] = [];
    let lastId = 0;

    for (;;) {
      const clauses = [
        `[System.TeamProject] = '${esc(project)}'`,
        `[System.Id] > ${lastId}`,
        ...extraClauses,
      ];
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(
        ' AND ',
      )} ORDER BY [System.Id] ASC`;

      const response = await this.makeRequest(wiqlUrl, {
        method: 'POST',
        body: JSON.stringify({ query: wiql }),
      });
      const data = (await response.json()) as WiqlResponse;
      const pageIds = data.workItems.map((w) => w.id);
      ids.push(...pageIds);

      // A short page (or an empty one) is the last page. ORDER BY ASC
      // guarantees the final id is the page maximum, so it is a safe keyset
      // cursor for the next request.
      const cursor = pageIds.at(-1);
      if (cursor === undefined || pageIds.length < this.wiqlPageSize) {
        break;
      }
      lastId = cursor;
    }

    return ids;
  }

  async fetchWorkItemTypes(project: string): Promise<string[]> {
    const url = `${this.orgUrl}/${encodeURIComponent(project)}/_apis/wit/workitemtypes?api-version=7.1`;
    const response = await this.makeRequest(url);
    const data = (await response.json()) as WorkItemTypesResponse;
    return data.value.map((t) => t.name);
  }

  /** Lists every team project in the org. Used by the board-source wizard. */
  async listProjects(): Promise<string[]> {
    const url = `${this.orgUrl}/_apis/projects?$top=500&api-version=7.0`;
    const response = await this.makeRequest(url);
    const data = (await response.json()) as ProjectsResponse;
    return data.value.map((p) => p.name);
  }

  private async makeRequest(
    url: string,
    options: { method?: string; body?: string } = {},
  ): Promise<Response> {
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      throw new AzureDevOpsCircuitOpenError();
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.throttle?.acquire();
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: options.method ?? 'GET',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          body: options.body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          await this.delayFn(Math.pow(2, attempt) * 1000);
        }
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        this.consecutiveFailures++;
        throw new AzureDevOpsAuthError(
          `Azure DevOps authentication failed (${response.status})`,
        );
      }

      if (response.ok) {
        this.consecutiveFailures = 0;
        return response;
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
        // Propagate the backoff to the shared throttle so the PR/commit sync
        // slows down too — all ADO traffic spends one account budget.
        this.throttle?.backOff(waitMs);
        if (attempt < MAX_RETRIES) {
          await this.delayFn(waitMs);
        }
        lastError = new Error(`Azure DevOps API error: ${response.status}`);
        continue;
      }

      if (response.status >= 500) {
        lastError = new Error(`Azure DevOps API error: ${response.status}`);
        if (attempt < MAX_RETRIES) {
          await this.delayFn(Math.pow(2, attempt) * 1000);
        }
        continue;
      }

      // Non-retriable error (e.g. 400). Surface ADO's response body — it
      // carries actionable detail like VS402337 (result set > 20,000) that a
      // bare status code hides.
      this.consecutiveFailures++;
      throw new Error(await this.errorMessage(response));
    }

    this.consecutiveFailures++;
    throw lastError ?? new Error('Azure DevOps API request failed after retries');
  }

  /**
   * Build an error message that includes Azure DevOps' response body. ADO
   * returns a JSON `{ message: 'VS… …' }` envelope on errors; we surface that
   * message (or the raw text) alongside the status. Body reads are best-effort:
   * if the body can't be read or parsed, the status code alone is reported.
   */
  private async errorMessage(response: Response): Promise<string> {
    let detail = '';
    try {
      const text = await response.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { message?: unknown };
          detail = typeof parsed.message === 'string' ? parsed.message : text;
        } catch {
          detail = text;
        }
        detail = detail.slice(0, MAX_ERROR_BODY_CHARS);
      }
    } catch {
      // Body unreadable — fall back to the status code alone.
    }
    return `Azure DevOps API error: ${response.status}${detail ? ` — ${detail}` : ''}`;
  }

  private mapWorkItem(raw: RawWorkItem): AzureDevOpsWorkItem {
    const f = raw.fields;

    // Extract parent from relations
    let adoParentId: number | null = null;
    if (raw.relations) {
      const parentRelation = raw.relations.find(
        (r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse',
      );
      if (parentRelation) {
        const segments = parentRelation.url.split('/');
        const lastSegment = segments[segments.length - 1];
        const parsed = Number(lastSegment);
        if (!isNaN(parsed)) {
          adoParentId = parsed;
        }
      }
    }

    // Collect non-System.* fields. Microsoft.VSTS.Common.ClosedDate is hoisted
    // to closedAt below — drop it from the freeform bag so we don't carry a
    // duplicate that could drift from the typed field.
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(f)) {
      if (key.startsWith('System.')) continue;
      if (key === 'Microsoft.VSTS.Common.ClosedDate') continue;
      fields[key] = value;
    }

    const assignedTo = f['System.AssignedTo'];
    const createdRaw = f['System.CreatedDate'];
    const changedRaw = f['System.ChangedDate'];
    const closedRaw = f['Microsoft.VSTS.Common.ClosedDate'];

    return {
      adoId: raw.id,
      adoParentId,
      type: f['System.WorkItemType'],
      title: f['System.Title'],
      state: f['System.State'],
      assignedTo: assignedTo ? assignedTo.displayName : null,
      areaPath: f['System.AreaPath'] ?? null,
      iterationPath: f['System.IterationPath'] ?? null,
      description: f['System.Description'] ?? null,
      fields,
      createdAt: createdRaw ? new Date(createdRaw) : new Date(0),
      changedAt: changedRaw ? new Date(changedRaw) : new Date(0),
      closedAt: closedRaw ? new Date(closedRaw) : null,
    };
  }
}
