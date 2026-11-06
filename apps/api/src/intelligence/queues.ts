import { Queue } from 'bullmq';

export interface IntelligenceQueues {
  // Intelligence-sync queues (write to ClickHouse for analytics).
  jira: Queue;
  github: Queue;
  ado: Queue;
  gitlab: Queue;
  // Bitbucket, like GitLab, has ONE queue: it feeds intelligence only (no board
  // rows), so there is no promote pipeline to pair it with. The name must match
  // the worker's (apps/worker/src/index.ts).
  bitbucket: Queue;
  // Legacy promote queues (write to Postgres Project rows for the board view).
  // gitlab uses the same `gitlab-sync` queue for both pipelines, so no separate ref.
  jiraSync: Queue;
  githubSync: Queue;
  adoSync: Queue;
}

export function buildIntelligenceQueues(redisUrl: string | undefined): IntelligenceQueues | null {
  if (!redisUrl) return null;
  const connection = { url: redisUrl };
  return {
    jira: new Queue('jira-intelligence-sync', { connection }),
    github: new Queue('github-intelligence-sync', { connection }),
    ado: new Queue('ado-intelligence-sync', { connection }),
    gitlab: new Queue('gitlab-sync', { connection }),
    bitbucket: new Queue('bitbucket-sync', { connection }),
    jiraSync: new Queue('jira-sync', { connection }),
    githubSync: new Queue('github-sync', { connection }),
    adoSync: new Queue('azure-devops-sync', { connection }),
  };
}
