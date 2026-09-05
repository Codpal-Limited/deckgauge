import { GitHubProject, GitHubProjectStatusOption } from './github-schemas.js';

export interface GitHubProjectItem {
  itemId: string;
  issue: {
    repoFullName: string;
    number: number;
    nodeId: string;
    state: 'open' | 'closed';
    title: string;
    body: string | null;
    assigneeLogin: string | null;
    labels: string[];
    type: string | null;
    updatedAt: Date;
  } | null;
  statusName: string | null;
}

export interface GitHubProjectsPort {
  listAccessibleProjects(): Promise<GitHubProject[]>;
  fetchProjectStatusOptions(projectNodeId: string): Promise<GitHubProjectStatusOption[]>;
  fetchProjectItems(projectNodeId: string): Promise<GitHubProjectItem[]>;
}
