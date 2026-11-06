import { GitHubIssue, GitHubMilestone } from './github-schemas.js';

export interface GitHubPort {
  fetchMilestones(repoFullName: string): Promise<GitHubMilestone[]>;
  fetchIssues(
    repoFullName: string,
    opts?: { milestoneNumber?: number; state?: 'open' | 'closed' | 'all' },
  ): Promise<GitHubIssue[]>;
  fetchRepoLabels(repoFullName: string): Promise<string[]>;
  fetchOrgIssueTypes(orgLogin: string): Promise<string[]>;
  /**
   * One issue by number. `null` when GitHub answers 404 or the number is a
   * pull request (which is not a board item). Optional so test doubles keep
   * compiling.
   */
  fetchIssue?(repoFullName: string, number: number): Promise<GitHubIssue | null>;
}
