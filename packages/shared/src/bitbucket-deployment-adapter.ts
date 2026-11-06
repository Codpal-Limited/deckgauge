// Bitbucket Pipelines deployments → cockpit.bitbucket_deployments — the source
// of REAL DORA deploy frequency for Bitbucket (GitLab only has the PR proxy).
//
// One row per Bitbucket deployment, raw. Deliberately NOT decided here:
//   - which environments count as production (the union filters on
//     environment_type = 'Production', re-evaluated on every read);
//   - de-duplication. One release fans out to many per-brand Production
//     environments, so the union counts one deploy per (repo, pipeline_uuid)
//     with ≥1 successful Production deployment. Collapsing at ingest would
//     lose the per-environment rows that rule needs.
//
// `/deployments` is read newest-started first and paging stops at the first
// row that started before `since`. Never-started placeholders (UNDEPLOYED,
// one per environment, no started_on) are skipped, not treated as the end.
import { chDateTime } from './clickhouse-datetime.js';
import { bitbucketRepoPath, type BitbucketClient } from './bitbucket-api.js';

export interface BitbucketDeploymentFetchOpts {
  repoFullName: string;
  /** Watermark — only deployments started at/after this. */
  since?: Date;
  pageLen?: number;
  maxPages?: number;
}

// Matches cockpit.bitbucket_deployments (73_bitbucket_deployments.sql): status,
// pipeline_uuid and commit_sha are non-null String DEFAULT '', so absence is ''.
export interface BitbucketDeploymentRow {
  /** `{repo_full_name}#{deployment_uuid}` */
  id: string;
  deployment_uuid: string;
  repo_full_name: string;
  instance_id: string;
  environment_uuid: string;
  environment_name: string;
  /** Bitbucket environment_type.name: Production | Staging | Test ('' if unresolved). */
  environment_type: string;
  /** state.name: COMPLETED | IN_PROGRESS | … */
  state: string;
  /** state.status.name: SUCCESSFUL | FAILED | STOPPED | … ('' until completed). */
  status: string;
  pipeline_uuid: string;
  commit_sha: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface BitbucketDeploymentPort {
  fetchDeployments(opts: BitbucketDeploymentFetchOpts): Promise<BitbucketDeploymentRow[]>;
}

export interface BitbucketDeploymentAdapterConfig {
  client: BitbucketClient;
  instanceId: string;
}

interface RawEnvironment {
  uuid: string;
  name: string;
  environment_type?: { name?: string } | null;
}

interface RawDeployment {
  uuid: string;
  state?: {
    name?: string;
    status?: { name?: string } | null;
    started_on?: string | null;
    completed_on?: string | null;
  } | null;
  environment?: { uuid?: string } | null;
  deployable?: {
    commit?: { hash?: string } | null;
    pipeline?: { uuid?: string } | null;
  } | null;
}

export class BitbucketDeploymentAdapter implements BitbucketDeploymentPort {
  private readonly client: BitbucketClient;
  private readonly instanceId: string;

  constructor(cfg: BitbucketDeploymentAdapterConfig) {
    this.client = cfg.client;
    this.instanceId = cfg.instanceId;
  }

  async fetchDeployments(opts: BitbucketDeploymentFetchOpts): Promise<BitbucketDeploymentRow[]> {
    const repoPath = bitbucketRepoPath(opts.repoFullName);
    const sinceMs = opts.since?.getTime();

    const envs = new Map<string, { name: string; type: string }>();
    for await (const page of this.client.paginate<RawEnvironment>(`${repoPath}/environments`, { pagelen: '100' })) {
      for (const e of page) envs.set(e.uuid, { name: e.name, type: e.environment_type?.name ?? '' });
    }

    const rows: BitbucketDeploymentRow[] = [];
    pages: for await (const page of this.client.paginate<RawDeployment>(
      `${repoPath}/deployments`,
      { sort: '-state.started_on', pagelen: String(opts.pageLen ?? 100) },
      { maxPages: opts.maxPages ?? 500 },
    )) {
      for (const d of page) {
        const startedOn = d.state?.started_on ?? null;
        if (!startedOn) continue;
        if (sinceMs !== undefined && Date.parse(startedOn) < sinceMs) break pages;
        const envUuid = d.environment?.uuid ?? '';
        const env = envs.get(envUuid);
        rows.push({
          id: `${opts.repoFullName}#${d.uuid}`,
          deployment_uuid: d.uuid,
          repo_full_name: opts.repoFullName,
          instance_id: this.instanceId,
          environment_uuid: envUuid,
          environment_name: env?.name ?? '',
          environment_type: env?.type ?? '',
          state: d.state?.name ?? '',
          status: d.state?.status?.name ?? '',
          pipeline_uuid: d.deployable?.pipeline?.uuid ?? '',
          commit_sha: d.deployable?.commit?.hash ?? '',
          started_at: chDateTime(startedOn),
          completed_at: chDateTime(d.state?.completed_on ?? null),
        });
      }
    }
    return rows;
  }
}

export class FakeBitbucketDeploymentAdapter implements BitbucketDeploymentPort {
  constructor(private readonly seed: BitbucketDeploymentRow[]) {}
  async fetchDeployments(_opts: BitbucketDeploymentFetchOpts) {
    return this.seed;
  }
}
