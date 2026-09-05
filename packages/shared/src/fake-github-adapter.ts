import { GitHubPort } from './github-port.js';
import { GitHubIssue, GitHubMilestone } from './github-schemas.js';

const REPO_A = 'owner/repo-a';
const REPO_B = 'owner/repo-b';

const SEED_MILESTONES: Record<string, GitHubMilestone[]> = {
  [REPO_A]: [
    {
      id: `${REPO_A}#1`,
      repoFullName: REPO_A,
      number: 1,
      title: 'v1.0 Launch',
      state: 'open',
      dueOn: new Date('2026-06-01T00:00:00Z'),
      createdAt: new Date('2026-03-01T10:00:00Z'),
      updatedAt: new Date('2026-04-01T10:00:00Z'),
      closedAt: null,
    },
    {
      id: `${REPO_A}#2`,
      repoFullName: REPO_A,
      number: 2,
      title: 'v1.1 Hotfixes',
      state: 'closed',
      dueOn: null,
      createdAt: new Date('2026-02-15T12:00:00Z'),
      updatedAt: new Date('2026-03-15T12:00:00Z'),
      closedAt: new Date('2026-03-15T12:00:00Z'),
    },
  ],
  [REPO_B]: [
    {
      id: `${REPO_B}#1`,
      repoFullName: REPO_B,
      number: 1,
      title: 'Beta Release',
      state: 'open',
      dueOn: null,
      createdAt: new Date('2026-03-10T09:00:00Z'),
      updatedAt: new Date('2026-04-10T09:00:00Z'),
      closedAt: null,
    },
  ],
};

const SEED_ISSUES: Record<string, GitHubIssue[]> = {
  [REPO_A]: [
    {
      id: `${REPO_A}#10`,
      repoFullName: REPO_A,
      number: 10,
      milestoneId: `${REPO_A}#1`,
      title: 'Add OAuth2 login',
      body: 'Implement OAuth2 login flow with GitHub and Google providers.',
      state: 'open',
      assigneeLogin: 'alice',
      labels: ['feature', 'auth'],
      type: 'Epic',
      createdAt: new Date('2026-04-01T08:00:00Z'),
      updatedAt: new Date('2026-04-20T08:00:00Z'),
      closedAt: null,
    },
    {
      id: `${REPO_A}#11`,
      repoFullName: REPO_A,
      number: 11,
      milestoneId: `${REPO_A}#1`,
      title: 'Fix signup validation',
      body: 'Email validation rejects valid addresses with + characters.',
      state: 'open',
      assigneeLogin: 'bob',
      labels: ['bug'],
      type: null,
      createdAt: new Date('2026-04-05T14:30:00Z'),
      updatedAt: new Date('2026-04-19T14:30:00Z'),
      closedAt: null,
    },
    {
      id: `${REPO_A}#12`,
      repoFullName: REPO_A,
      number: 12,
      milestoneId: null,
      title: 'Update README',
      body: null,
      state: 'closed',
      assigneeLogin: null,
      labels: ['documentation'],
      type: null,
      createdAt: new Date('2026-04-10T11:00:00Z'),
      updatedAt: new Date('2026-04-18T11:00:00Z'),
      closedAt: new Date('2026-04-18T11:00:00Z'),
    },
  ],
  [REPO_B]: [
    {
      id: `${REPO_B}#20`,
      repoFullName: REPO_B,
      number: 20,
      milestoneId: `${REPO_B}#1`,
      title: 'Performance benchmarks',
      body: 'Run and document p95 latency benchmarks for the API.',
      state: 'open',
      assigneeLogin: 'charlie',
      labels: ['performance'],
      type: null,
      createdAt: new Date('2026-04-15T16:00:00Z'),
      updatedAt: new Date('2026-04-21T16:00:00Z'),
      closedAt: null,
    },
  ],
};

export class FakeGitHubAdapter implements GitHubPort {
  public fixtureLabelsByRepo: Record<string, string[]> = {};
  public fixtureIssueTypesByOrg: Record<string, string[]> = {};

  async fetchMilestones(repoFullName: string): Promise<GitHubMilestone[]> {
    return SEED_MILESTONES[repoFullName] ?? [];
  }

  async fetchIssues(repoFullName: string): Promise<GitHubIssue[]> {
    return SEED_ISSUES[repoFullName] ?? [];
  }

  async fetchRepoLabels(repoFullName: string): Promise<string[]> {
    return this.fixtureLabelsByRepo[repoFullName] ?? [];
  }

  async fetchOrgIssueTypes(orgLogin: string): Promise<string[]> {
    return this.fixtureIssueTypesByOrg[orgLogin] ?? [];
  }
}
