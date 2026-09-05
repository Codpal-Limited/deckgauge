import { GitHubIssue, GitHubMilestone } from './github-schemas.js';

export interface GitHubPort {
  fetchMilestones(repoFullName: string): Promise<GitHubMilestone[]>;
  fetchIssues(
    repoFullName: string,
    opts?: { milestoneNumber?: number; state?: 'open' | 'closed' | 'all' },
  ): Promise<GitHubIssue[]>;
  fetchRepoLabels(repoFullName: string): Promise<string[]>;
  fetchOrgIssueTypes(orgLogin: string): Promise<string[]>;
}
