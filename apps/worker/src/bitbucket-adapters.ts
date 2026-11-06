// Bitbucket Cloud — the adapter bundle the bitbucket-sync handler consumes, one per
// instance per job. Real adapters share ONE client (sequential requests per
// instance, spec § Rate limits); USE_FAKE_BITBUCKET swaps in network-free fakes.
import {
  BitbucketClient,
  BitbucketPrAdapter,
  BitbucketCommitAdapter,
  BitbucketDeploymentAdapter,
  FakeBitbucketPrAdapter,
  FakeBitbucketCommitAdapter,
  FakeBitbucketDeploymentAdapter,
  bitbucketRepoPath,
  listBitbucketRepos,
} from '@deckgauge/shared';
import type { BitbucketAdapters, BitbucketFactoryConfig } from './bitbucket-sync.handler.js';

/**
 * Resolves a repository's main branch, listing each workspace at most once for the
 * resolver's lifetime (one instance, one job). A repository missing from the
 * listing, or a listing that fails, falls back to `GET /repositories/{full}` —
 * so one bad page cannot fail every repository's commit phase.
 */
export function createMainBranchResolver(
  client: BitbucketClient,
): (repoFullName: string) => Promise<string | null> {
  const listings = new Map<string, Promise<Map<string, string | null> | null>>();

  function listingFor(workspace: string) {
    let pending = listings.get(workspace);
    if (!pending) {
      pending = listBitbucketRepos(client, workspace)
        .then((repos) => new Map(repos.map((r) => [r.fullName, r.mainBranch] as const)))
        .catch(() => null);
      listings.set(workspace, pending);
    }
    return pending;
  }

  return async (repoFullName) => {
    const workspace = repoFullName.split('/')[0] ?? '';
    const listing = workspace ? await listingFor(workspace) : null;
    if (listing?.has(repoFullName)) return listing.get(repoFullName) ?? null;
    const repo = await client.get<{ mainbranch?: { name?: string } | null }>(
      bitbucketRepoPath(repoFullName),
    );
    return repo.mainbranch?.name ?? null;
  };
}

export function createBitbucketAdapters(
  cfg: BitbucketFactoryConfig,
  opts: { fake?: boolean } = {},
): BitbucketAdapters {
  if (opts.fake) {
    return {
      pr: new FakeBitbucketPrAdapter([]),
      commit: new FakeBitbucketCommitAdapter([]),
      deployment: new FakeBitbucketDeploymentAdapter([]),
      mainBranch: async () => 'main',
    };
  }
  const client = new BitbucketClient({ email: cfg.email, apiToken: cfg.apiToken });
  return {
    pr: new BitbucketPrAdapter({ client, instanceId: cfg.instanceId }),
    commit: new BitbucketCommitAdapter({ client, instanceId: cfg.instanceId }),
    deployment: new BitbucketDeploymentAdapter({ client, instanceId: cfg.instanceId }),
    mainBranch: createMainBranchResolver(client),
  };
}
