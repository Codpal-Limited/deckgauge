import { GitHubProjectsPort, GitHubProjectItem } from './github-projects-port.js';
import { GitHubProject, GitHubProjectStatusOption } from './github-schemas.js';

export class GitHubProjectsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubProjectsAuthError';
  }
}

type FetchFn = typeof fetch;
type DelayFn = (ms: number) => Promise<void>;

interface AdapterConfig {
  accessToken: string;
  baseUrl?: string;
}

const MAX_RETRIES = 4;

const STATUS_OPTIONS_QUERY = `
query StatusOptions($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      field(name: "Status") {
        ... on ProjectV2SingleSelectField {
          __typename
          options { id name }
        }
      }
    }
  }
}`;

const PROJECT_ITEMS_QUERY = `
query ProjectItems($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        nodes {
          id
          content {
            __typename
            ... on Issue {
              number id state title body updatedAt
              repository { nameWithOwner }
              assignees(first: 1) { nodes { login } }
              labels(first: 50) { nodes { name } }
              issueType { name }
            }
          }
          fieldValueByName(name: "Status") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const LIST_PROJECTS_QUERY = `
query ListProjects($userCursor: String, $orgCursor: String) {
  viewer {
    projectsV2(first: 50, after: $userCursor) {
      nodes { id number title owner { ... on User { login __typename } ... on Organization { login __typename } } }
      pageInfo { hasNextPage endCursor }
    }
    organizations(first: 25, after: $orgCursor) {
      nodes {
        login
        projectsV2(first: 50) {
          nodes { id number title owner { ... on User { login __typename } ... on Organization { login __typename } } }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ORG_PROJECTS_QUERY = `
query OrgProjects($login: String!, $cursor: String) {
  organization(login: $login) {
    projectsV2(first: 50, after: $cursor) {
      nodes { id number title owner { ... on User { login __typename } ... on Organization { login __typename } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export class GitHubProjectsGraphQLAdapter implements GitHubProjectsPort {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchFn: FetchFn;
  private readonly delayFn: DelayFn;

  constructor(
    config: AdapterConfig,
    fetchFn: FetchFn = fetch,
    delayFn: DelayFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.baseUrl = config.baseUrl ?? 'https://api.github.com';
    this.accessToken = config.accessToken;
    this.fetchFn = fetchFn;
    this.delayFn = delayFn;
  }

  async listAccessibleProjects(): Promise<GitHubProject[]> {
    const projects: GitHubProject[] = [];
    // Tracks orgs whose inner projectsV2 page hit hasNextPage; we drain them after the outer loop.
    const orgsWithMore = new Map<string, string>(); // login -> next cursor

    // Paginate user projects
    let userCursor: string | null = null;
    let orgCursor: string | null = null;
    let firstPage = true;
    let userDone = false;
    let orgDone = false;

    // We need at least one pass; then we continue while there are more pages
    while (firstPage || !userDone || !orgDone) {
      firstPage = false;

      const variables: Record<string, unknown> = {};
      if (userCursor != null) variables.userCursor = userCursor;
      if (orgCursor != null) variables.orgCursor = orgCursor;

      const data = await this.runQuery<{ viewer: ListProjectsViewer }>(
        LIST_PROJECTS_QUERY,
        variables,
      );

      // Collect user projects from this page
      for (const p of data.viewer.projectsV2.nodes) {
        projects.push(this.mapProject(p));
      }

      // Collect org projects from this page; remember orgs with more pages
      for (const org of data.viewer.organizations.nodes) {
        for (const p of org.projectsV2.nodes) {
          projects.push(this.mapProject(p));
        }
        if (org.projectsV2.pageInfo.hasNextPage && org.projectsV2.pageInfo.endCursor) {
          orgsWithMore.set(org.login, org.projectsV2.pageInfo.endCursor);
        }
      }

      // Determine next cursors
      const userPageInfo = data.viewer.projectsV2.pageInfo;
      const orgPageInfo = data.viewer.organizations.pageInfo;

      userDone = !userPageInfo.hasNextPage;
      orgDone = !orgPageInfo.hasNextPage;

      if (!userDone) {
        userCursor = userPageInfo.endCursor;
      }
      if (!orgDone) {
        orgCursor = orgPageInfo.endCursor;
      }

      // If both done, stop
      if (userDone && orgDone) break;
    }

    // Drain each org that had more pages of projectsV2 beyond the first 50.
    type OrgProjectsPage = {
      organization: {
        projectsV2: { nodes: RawProject[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } | null;
    };
    for (const [login, startCursor] of orgsWithMore) {
      let cursor: string | null = startCursor;
      while (cursor != null) {
        const data: OrgProjectsPage = await this.runQuery<OrgProjectsPage>(ORG_PROJECTS_QUERY, { login, cursor });
        if (!data.organization) break;
        for (const p of data.organization.projectsV2.nodes) {
          projects.push(this.mapProject(p));
        }
        cursor = data.organization.projectsV2.pageInfo.hasNextPage
          ? data.organization.projectsV2.pageInfo.endCursor
          : null;
      }
    }

    return projects;
  }

  async fetchProjectStatusOptions(projectNodeId: string): Promise<GitHubProjectStatusOption[]> {
    const data = await this.runQuery<{
      node: { field: { options: Array<{ id: string; name: string }> } | null };
    }>(STATUS_OPTIONS_QUERY, { id: projectNodeId });
    if (!data.node.field) return [];
    return data.node.field.options.map((o) => ({ optionId: o.id, name: o.name }));
  }

  async fetchProjectItems(projectNodeId: string): Promise<GitHubProjectItem[]> {
    type ProjectItemsPage = {
      node: {
        items: {
          nodes: Array<RawProjectItem>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    const results: GitHubProjectItem[] = [];
    let cursor: string | null = null;
    while (true) {
      const data: ProjectItemsPage = await this.runQuery<ProjectItemsPage>(
        PROJECT_ITEMS_QUERY,
        { id: projectNodeId, cursor },
      );
      for (const node of data.node.items.nodes) {
        results.push(this.mapItem(node));
      }
      if (!data.node.items.pageInfo.hasNextPage) break;
      cursor = data.node.items.pageInfo.endCursor;
    }
    return results;
  }

  private mapItem(raw: RawProjectItem): GitHubProjectItem {
    const issue =
      raw.content?.__typename === 'Issue'
        ? {
            repoFullName: raw.content.repository.nameWithOwner,
            number: raw.content.number,
            nodeId: raw.content.id,
            state: (raw.content.state.toLowerCase() === 'closed' ? 'closed' : 'open') as
              | 'open'
              | 'closed',
            title: raw.content.title,
            body: raw.content.body ?? null,
            assigneeLogin: raw.content.assignees.nodes[0]?.login ?? null,
            labels: raw.content.labels.nodes.map((l) => l.name),
            type: raw.content.issueType?.name ?? null,
            updatedAt: new Date(raw.content.updatedAt),
          }
        : null;
    const statusName =
      raw.fieldValueByName?.__typename === 'ProjectV2ItemFieldSingleSelectValue'
        ? raw.fieldValueByName.name
        : null;
    return { itemId: raw.id, issue, statusName };
  }

  private async runQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await this.fetchFn(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 401 || response.status === 403) {
        throw new GitHubProjectsAuthError(`GitHub Projects auth failed (${response.status})`);
      }

      if (response.status >= 500) {
        lastError = new Error(`GitHub GraphQL error: ${response.status}`);
        if (attempt < MAX_RETRIES) {
          await this.delayFn(Math.pow(2, attempt) * 1000);
        }
        continue;
      }

      if (!response.ok) {
        throw new Error(`GitHub GraphQL error: ${response.status}`);
      }

      const payload = (await response.json()) as {
        data: T | null;
        errors?: Array<{ message: string }>;
      };

      if (payload.errors && payload.errors.length > 0) {
        throw new Error(`GitHub GraphQL error: ${payload.errors[0]?.message}`);
      }

      if (payload.data == null) {
        throw new Error('GitHub GraphQL response missing data');
      }

      return payload.data;
    }

    throw lastError ?? new Error('GitHub GraphQL request failed after retries');
  }

  private mapProject(raw: RawProject): GitHubProject {
    return {
      nodeId: raw.id,
      owner: raw.owner.login,
      number: raw.number,
      title: raw.title,
      ownerType: raw.owner.__typename === 'Organization' ? 'org' : 'user',
    };
  }
}

interface RawProject {
  id: string;
  number: number;
  title: string;
  owner: { login: string; __typename: 'User' | 'Organization' };
}

interface ListProjectsViewer {
  projectsV2: { nodes: RawProject[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  organizations: {
    nodes: Array<{
      login: string;
      projectsV2: { nodes: RawProject[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

type RawProjectItem = {
  id: string;
  content:
    | {
        __typename: 'Issue';
        number: number;
        id: string;
        state: string;
        title: string;
        body: string | null;
        updatedAt: string;
        repository: { nameWithOwner: string };
        assignees: { nodes: Array<{ login: string }> };
        labels: { nodes: Array<{ name: string }> };
        issueType: { name: string } | null;
      }
    | { __typename: 'DraftIssue' }
    | { __typename: 'PullRequest' }
    | null;
  fieldValueByName:
    | { __typename: 'ProjectV2ItemFieldSingleSelectValue'; name: string }
    | null;
};
