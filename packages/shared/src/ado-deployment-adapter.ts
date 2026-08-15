// Real Azure DevOps deployment records — the source DORA's deploy frequency
// reads instead of the merged-PR proxy.
//
// Reads classic Release pipeline deployments from the Release Management host
// (vsrm.dev.azure.com, NOT dev.azure.com — a different host for the same org).
// That is the mechanism real orgs actually use: probing the live API found 5
// release definitions in one org and 4 in another, with real deployment records
// carrying deploymentStatus / startedOn / completedOn.
//
// Two mechanisms deliberately NOT read here:
//   - Multi-stage YAML pipeline deployments (distributedtask/environments/{id}/
//     environmentdeploymentrecords). The current PAT lacks Environment (read)
//     scope — that endpoint answers with an auth redirect instead of JSON. The
//     ado_deployments table already carries kind='environment' so this source can
//     be added without a migration or a re-sync.
//   - Build/pipeline runs (/_apis/build/builds). A build succeeding is not a
//     deploy; a single large org can carry 55k+ builds, so counting them would
//     inflate deploy frequency far worse than the proxy this replaces.
import { chDateTime } from './clickhouse-datetime';
import { resilientFetchJson } from './resilient-fetch';
import type { Throttle } from './request-throttle';

export interface AdoDeploymentFetchOpts {
  project: string;
  /** Incremental watermark — only deployments started at/after this. */
  since?: Date;
  pageSize?: number;
  maxPages?: number;
}

export interface AdoDeploymentRow {
  id: string;
  deployment_id: number;
  kind: 'release' | 'environment';
  org_url: string;
  project: string;
  instance_id: string;
  definition_id: number;
  definition_name: string;
  release_id: number;
  release_name: string;
  environment: string;
  status: string;
  requested_by: string | null;
  source_branch: string | null;
  source_sha: string | null;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface AdoDeploymentPort {
  fetchDeployments(opts: AdoDeploymentFetchOpts): Promise<AdoDeploymentRow[]>;
}

interface AdoDeploymentAdapterConfig {
  orgUrl: string;
  authMethod: 'PAT' | 'BASIC';
  accessToken: string;
  username?: string;
  instanceId: string;
  fetchFn?: typeof fetch;
  throttle?: Throttle;
}

interface RawIdentity {
  displayName?: string;
  uniqueName?: string;
}

interface RawArtifact {
  definitionReference?: {
    branch?: { id?: string; name?: string };
    sourceVersion?: { id?: string; name?: string };
  };
}

interface RawDeployment {
  id: number;
  deploymentStatus?: string;
  release?: { id?: number; name?: string; artifacts?: RawArtifact[] };
  releaseDefinition?: { id?: number; name?: string };
  releaseEnvironment?: { id?: number; name?: string };
  requestedBy?: RawIdentity;
  queuedOn?: string;
  startedOn?: string;
  completedOn?: string;
}

// Which stage names count as production is deliberately NOT decided here.
//
// There is no "is production" flag on an ADO release environment, so the answer
// is a heuristic — and a deployment row is fetched exactly once (the watermark
// never re-reads it), so any verdict stored at ingest could never be revised.
// The rule therefore lives entirely in the query, in deploymentsUnion
// (apps/api/src/widgets/unions.ts), where it is re-evaluated on every read from
// the raw `environment` / `definition_name` / `source_branch` columns and can be
// overridden per project. Re-introducing an ingest-time flag here would give the
// heuristic a second home, free to drift from the one that actually decides.

function authHeader(cfg: AdoDeploymentAdapterConfig): string {
  const raw =
    cfg.authMethod === 'BASIC' ? `${cfg.username ?? ''}:${cfg.accessToken}` : `:${cfg.accessToken}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

/**
 * Release Management lives on a different host from the rest of the ADO API:
 * https://dev.azure.com/{org} → https://vsrm.dev.azure.com/{org}. Hitting the
 * normal host returns HTML, not JSON.
 */
export function releaseHost(orgUrl: string): string {
  const trimmed = orgUrl.replace(/\/+$/, '');
  return trimmed.replace('://dev.azure.com/', '://vsrm.dev.azure.com/');
}

export class AdoDeploymentAdapter implements AdoDeploymentPort {
  private readonly cfg: AdoDeploymentAdapterConfig;
  private readonly orgUrl: string;
  private readonly vsrmUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: AdoDeploymentAdapterConfig) {
    this.cfg = cfg;
    this.orgUrl = cfg.orgUrl.replace(/\/+$/, '');
    this.vsrmUrl = releaseHost(cfg.orgUrl);
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async fetchDeployments(opts: AdoDeploymentFetchOpts): Promise<AdoDeploymentRow[]> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? 50;
    const projectEnc = encodeURIComponent(opts.project);

    const rows: AdoDeploymentRow[] = [];
    let continuationToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        'api-version': '7.1',
        $top: String(pageSize),
        queryOrder: 'descending',
      });
      if (opts.since) params.set('minStartedTime', opts.since.toISOString());
      if (continuationToken) params.set('continuationToken', continuationToken);

      const url = `${this.vsrmUrl}/${projectEnc}/_apis/release/deployments?${params.toString()}`;
      await this.cfg.throttle?.acquire();
      const r = await resilientFetchJson<{ value?: RawDeployment[] }>(
        this.doFetch,
        url,
        { headers: { Authorization: authHeader(this.cfg), Accept: 'application/json' } },
        { onThrottled: ({ waitMs }) => this.cfg.throttle?.backOff(waitMs) },
      );
      if (!r.ok) throw new Error(`ADO ${r.status} ${r.statusText} for ${url}`);

      const batch = r.data?.value ?? [];
      if (batch.length === 0) break;
      for (const raw of batch) rows.push(this.transform(opts.project, raw));

      // ADO pages the Release API with a response header, not a body field.
      continuationToken = r.headers?.get('x-ms-continuationtoken') ?? undefined;
      if (!continuationToken || batch.length < pageSize) break;
    }
    return rows;
  }

  private transform(project: string, raw: RawDeployment): AdoDeploymentRow {
    const environment = raw.releaseEnvironment?.name ?? '';
    const artifact = raw.release?.artifacts?.[0]?.definitionReference;
    return {
      id: `${this.orgUrl}/${project}#release#${raw.id}`,
      deployment_id: raw.id,
      kind: 'release',
      org_url: this.orgUrl,
      project,
      instance_id: this.cfg.instanceId,
      definition_id: raw.releaseDefinition?.id ?? 0,
      definition_name: raw.releaseDefinition?.name ?? '',
      release_id: raw.release?.id ?? 0,
      release_name: raw.release?.name ?? '',
      environment,
      status: raw.deploymentStatus ?? 'unknown',
      requested_by: raw.requestedBy?.uniqueName ?? raw.requestedBy?.displayName ?? null,
      source_branch: artifact?.branch?.name ?? null,
      source_sha: artifact?.sourceVersion?.id ?? null,
      queued_at: chDateTime(raw.queuedOn ?? null),
      started_at: chDateTime(raw.startedOn ?? null),
      completed_at: chDateTime(raw.completedOn ?? null),
    };
  }
}

export class FakeAdoDeploymentAdapter implements AdoDeploymentPort {
  constructor(private readonly seed: AdoDeploymentRow[]) {}
  async fetchDeployments(_opts: AdoDeploymentFetchOpts): Promise<AdoDeploymentRow[]> {
    return this.seed;
  }
}
