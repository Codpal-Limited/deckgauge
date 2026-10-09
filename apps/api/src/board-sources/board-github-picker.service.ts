import type { PrismaClient } from '@deckgauge/db';
import type { Octokit } from '@octokit/rest';
import type { PickerResponse } from '@deckgauge/shared';
import { matchesGlob } from './github-glob.js';

const PAGE_SIZE = 50;

export interface ListReposArgs {
  prisma: PrismaClient;
  octokit: Octokit;
  boardId: string;
  instanceId: string;
  org: string;
  pattern: string;
  page: number;
  includeArchived: boolean;
}

interface OrgRepo {
  full_name: string;
  name: string;
  archived: boolean;
  default_branch: string;
  language: string | null;
  topics?: string[];
  pushed_at: string | null;
  open_issues_count: number;
}

/**
 * The repositories the picker offers.
 *
 * A connection with an org lists that org's repositories. A connection WITHOUT
 * one — the default, since `GitHubInstance.org` is `@default("")` and until
 * issue #3 nothing could set it — lists what the token itself can see, which is
 * the same answer `GitHubService.discoverRepos` gives. Interpolating the empty
 * org produced `GET /orgs//repos`, a 404 that the route reported as a transient
 * "try again shortly" failure on every attempt.
 */
async function fetchCandidateRepos(octokit: Octokit, org: string): Promise<OrgRepo[]> {
  const trimmed = org.trim();
  if (trimmed.length === 0) {
    return (await octokit.paginate('GET /user/repos', {
      affiliation: 'owner,collaborator,organization_member',
      per_page: 100,
    } as never)) as OrgRepo[];
  }
  return (await octokit.paginate('GET /orgs/{org}/repos', {
    org: trimmed,
    per_page: 100,
    type: 'all',
  } as never)) as OrgRepo[];
}

export async function listRepos(args: ListReposArgs): Promise<PickerResponse> {
  const all = await fetchCandidateRepos(args.octokit, args.org);

  const sources = (await args.prisma.boardGitHubSource.findMany({
    where: { boardId: args.boardId },
    select: { gitHubRepoSync: { select: { repoFullName: true, disabledAt: true } } },
  })) as Array<{ gitHubRepoSync: { repoFullName: string; disabledAt: Date | null } }>;

  const enabledFullNames = new Set(
    sources
      .filter((s) => s.gitHubRepoSync.disabledAt === null)
      .map((s) => s.gitHubRepoSync.repoFullName),
  );

  const filtered = all
    .filter((r) => args.includeArchived || !r.archived)
    .filter((r) => matchesGlob(r.name, args.pattern));

  const pageItems = filtered.slice((args.page - 1) * PAGE_SIZE, args.page * PAGE_SIZE);
  const nextPage = filtered.length > args.page * PAGE_SIZE ? args.page + 1 : null;

  return {
    repos: pageItems.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      language: r.language ?? null,
      topics: r.topics ?? [],
      archived: r.archived,
      lastPushedAt: r.pushed_at,
      openIssuesCount: r.open_issues_count ?? 0,
      enabled: enabledFullNames.has(r.full_name),
    })),
    totalMatched: filtered.length,
    nextPage,
  };
}
