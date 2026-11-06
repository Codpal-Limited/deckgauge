// Bitbucket Cloud discovery: who the token belongs to, which workspaces it can
// see, and which repositories each workspace holds.
//
// `/user/workspaces` is the live endpoint — `/user/permissions/workspaces`
// answers 404 since Atlassian retired it, so do not "fix" this back.
import type { BitbucketClient } from './bitbucket-api.js';

export interface BitbucketCurrentUser {
  uuid: string;
  nickname: string;
  displayName: string | null;
  accountId: string | null;
}

export interface BitbucketWorkspace {
  slug: string;
  name: string;
  uuid: string;
}

export interface BitbucketRemoteRepo {
  fullName: string;
  slug: string;
  isPrivate: boolean;
  updatedOn: string | null;
  mainBranch: string | null;
  projectKey: string | null;
  projectName: string | null;
}

export interface BitbucketRepoProjectGroup {
  projectKey: string | null;
  projectName: string | null;
  repos: BitbucketRemoteRepo[];
}

interface RawUser {
  uuid: string;
  nickname: string;
  display_name?: string | null;
  account_id?: string | null;
}

interface RawWorkspaceAccess {
  workspace: { slug: string; name: string; uuid: string };
}

interface RawRepo {
  full_name: string;
  slug: string;
  is_private?: boolean;
  updated_on?: string | null;
  mainbranch?: { name?: string } | null;
  project?: { key?: string; name?: string } | null;
}

export async function getBitbucketCurrentUser(client: BitbucketClient): Promise<BitbucketCurrentUser> {
  const u = await client.get<RawUser>('/user');
  return {
    uuid: u.uuid,
    nickname: u.nickname,
    displayName: u.display_name ?? null,
    accountId: u.account_id ?? null,
  };
}

export async function listBitbucketWorkspaces(client: BitbucketClient): Promise<BitbucketWorkspace[]> {
  const out: BitbucketWorkspace[] = [];
  for await (const page of client.paginate<RawWorkspaceAccess>('/user/workspaces', { pagelen: '50' })) {
    for (const v of page) out.push({ slug: v.workspace.slug, name: v.workspace.name, uuid: v.workspace.uuid });
  }
  return out;
}

export async function listBitbucketRepos(
  client: BitbucketClient,
  workspace: string,
): Promise<BitbucketRemoteRepo[]> {
  const out: BitbucketRemoteRepo[] = [];
  const path = `/repositories/${encodeURIComponent(workspace)}`;
  for await (const page of client.paginate<RawRepo>(path, { pagelen: '100' })) {
    for (const r of page) {
      out.push({
        fullName: r.full_name,
        slug: r.slug,
        isPrivate: r.is_private ?? true,
        updatedOn: r.updated_on ?? null,
        mainBranch: r.mainbranch?.name ?? null,
        projectKey: r.project?.key ?? null,
        projectName: r.project?.name ?? null,
      });
    }
  }
  return out;
}

/** Picker shape: one group per Bitbucket project, project-less repos last. */
export function groupBitbucketReposByProject(repos: BitbucketRemoteRepo[]): BitbucketRepoProjectGroup[] {
  const byKey = new Map<string | null, BitbucketRepoProjectGroup>();
  for (const r of repos) {
    let g = byKey.get(r.projectKey);
    if (!g) {
      g = { projectKey: r.projectKey, projectName: r.projectName, repos: [] };
      byKey.set(r.projectKey, g);
    }
    g.repos.push(r);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return groups.sort((a, b) => {
    if (a.projectKey === null) return 1;
    if (b.projectKey === null) return -1;
    return (a.projectName ?? a.projectKey).localeCompare(b.projectName ?? b.projectKey);
  });
}
