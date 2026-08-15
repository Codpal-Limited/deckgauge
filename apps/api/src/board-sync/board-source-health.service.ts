import type { PrismaClient } from '@deckgauge/db';
import type { BoardSourceHealth, SourceHealthState } from '@deckgauge/shared';

type Probe = (instanceId: string) => Promise<{ ok: boolean; error?: string }>;

export interface BoardSourceProbes {
  jira: Probe;
  github: Probe;
  ado: Probe;
  gitlab: Probe;
}

export interface BoardSourceHealthResult {
  sources: BoardSourceHealth[];
  /** True when any source is credential-blocked — `expired` OR `reauthorize`. */
  hasExpired: boolean;
}

type Provider = 'jira' | 'github' | 'ado' | 'gitlab';

// A provider federated to an external IdP relays that IdP's error verbatim on a
// 403 when the credential's SSO session needs interactive re-auth — an Entra
// `AADSTS…` code, or GitHub's own SAML-enforcement copy. The token itself is
// still good in that case, so calling it "expired" sends the user off to
// re-issue a credential that was never the problem.
const SSO_REAUTH = /AADSTS\d+|SAML enforcement|single[- ]sign[- ]on|Configure SSO/i;

// 401/403 means the credential cannot do the job (actionable). Everything else
// is treated as a transient reachability problem so we never falsely tell the
// user their token expired — and so sync still attempts those instances.
function classify(result: { ok: boolean; error?: string }): SourceHealthState {
  if (result.ok) return 'valid';
  const e = result.error ?? '';
  if (!/\b(401|403)\b/.test(e)) return 'unreachable';
  return SSO_REAUTH.test(e) ? 'reauthorize' : 'expired';
}

/**
 * Both credential-blocked states are equally unable to sync, so callers that
 * decide what to skip must treat them alike — only the user-facing copy differs.
 */
export function isCredentialBlocked(state: SourceHealthState): boolean {
  return state === 'expired' || state === 'reauthorize';
}

export class BoardSourceHealthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly probes: BoardSourceProbes,
  ) {}

  async probe(boardId: string): Promise<BoardSourceHealthResult> {
    const [jira, github, ado, gitlab] = await Promise.all([
      this.prisma.boardJiraSource.findMany({
        where: { boardId },
        include: { jiraProjectSync: { include: { jiraInstance: true } } },
      }) as unknown as Promise<
        Array<{ jiraProjectSync: { jiraInstance: { id: string; name?: string | null } } }>
      >,
      this.prisma.boardGitHubSource.findMany({
        where: { boardId },
        include: { gitHubRepoSync: { include: { githubInstance: true } } },
      }) as unknown as Promise<
        Array<{
          gitHubRepoSync: { githubInstance: { id: string; org?: string | null; baseUrl?: string | null } };
        }>
      >,
      this.prisma.boardAdoSource.findMany({
        where: { boardId },
        include: { azureDevOpsProjectSync: { include: { azureDevOpsInstance: true } } },
      }) as unknown as Promise<
        Array<{
          azureDevOpsProjectSync: {
            azureDevOpsInstance: { id: string; name?: string | null; orgUrl?: string | null };
          };
        }>
      >,
      this.prisma.boardGitLabSource.findMany({
        where: { boardId },
        include: { gitlabProjectSync: { include: { gitlabInstance: true } } },
      }) as unknown as Promise<
        Array<{
          gitlabProjectSync: { gitlabInstance: { id: string; name?: string | null; baseUrl?: string | null } };
        }>
      >,
    ]);

    // Collect distinct instances per provider with a human label.
    const distinct = new Map<string, { provider: Provider; instanceId: string; label: string }>();
    const add = (provider: Provider, instanceId: string, label: string) => {
      const k = `${provider}:${instanceId}`;
      if (!distinct.has(k)) distinct.set(k, { provider, instanceId, label });
    };
    for (const r of jira) {
      add('jira', r.jiraProjectSync.jiraInstance.id, r.jiraProjectSync.jiraInstance.name ?? 'Jira');
    }
    for (const r of github) {
      add(
        'github',
        r.gitHubRepoSync.githubInstance.id,
        r.gitHubRepoSync.githubInstance.org ?? r.gitHubRepoSync.githubInstance.baseUrl ?? 'GitHub',
      );
    }
    for (const r of ado) {
      add(
        'ado',
        r.azureDevOpsProjectSync.azureDevOpsInstance.id,
        r.azureDevOpsProjectSync.azureDevOpsInstance.name ??
          r.azureDevOpsProjectSync.azureDevOpsInstance.orgUrl ??
          'Azure DevOps',
      );
    }
    for (const r of gitlab) {
      add(
        'gitlab',
        r.gitlabProjectSync.gitlabInstance.id,
        r.gitlabProjectSync.gitlabInstance.name ?? r.gitlabProjectSync.gitlabInstance.baseUrl ?? 'GitLab',
      );
    }

    const sources = await Promise.all(
      Array.from(distinct.values(), async ({ provider, instanceId, label }) => {
        const result = await this.runProbe(provider, instanceId);
        const state = classify(result);
        return {
          provider,
          instanceId,
          label,
          state,
          ...(state === 'valid' ? {} : { error: result.error }),
        } satisfies BoardSourceHealth;
      }),
    );

    return { sources, hasExpired: sources.some((s) => isCredentialBlocked(s.state)) };
  }

  // A probe throwing (instead of resolving `{ ok: false, error }`) must not
  // sink the whole Promise.all — one bad instance should degrade to
  // 'unreachable', not lose health status for every other source on the board.
  private async runProbe(
    provider: Provider,
    instanceId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      return await this.probes[provider](instanceId);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
