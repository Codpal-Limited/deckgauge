import { IntelligenceSyncTrigger } from '../components/IntelligenceSyncTrigger';
import { JiraConnectionsPanel } from '../components/connections/JiraConnectionsPanel';
import { GitHubConnectionsPanel } from '../components/connections/GitHubConnectionsPanel';
import { AzureDevOpsConnectionsPanel } from '../components/connections/AzureDevOpsConnectionsPanel';
import { GitLabConnectionsPanel } from '../components/connections/GitLabConnectionsPanel';
import { InstancesPanel } from '../components/connections/InstancesPanel';
import { RetiredProjectsPanel } from '../components/connections/RetiredProjectsPanel';
import {
  listJiraProjectSyncs,
  listGitHubRepoSyncs,
  listAdoProjectSyncs,
  listGitLabProjectSyncs,
  listJiraInstances,
  listGitHubInstances,
  listAdoInstances,
  listGitLabInstances,
  refreshJiraToken,
  refreshGitHubToken,
  refreshAdoToken,
  refreshGitLabToken,
  testJiraConnection,
  testGitHubConnection,
  testAdoConnection,
  testGitLabConnection,
  deleteJiraInstance,
  deleteGitHubInstance,
  deleteAdoInstance,
  deleteGitLabInstance,
} from '../actions/connections';
import { listRetiredProjects } from '../actions/retired-projects';

export const dynamic = 'force-dynamic';

// Group project syncs by their owning instance id so each connection row can
// show how many syncs a delete would cascade through.
function countByInstance<T extends Record<K, string>, K extends keyof T>(
  rows: T[],
  key: K,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const id = row[key];
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export default async function SourcesPage() {
  const [
    jiraSyncs,
    githubSyncs,
    adoSyncs,
    gitlabSyncs,
    jiraInstances,
    githubInstances,
    adoInstances,
    gitlabInstances,
    retiredProjects,
  ] = await Promise.all([
    listJiraProjectSyncs().catch(() => []),
    listGitHubRepoSyncs().catch(() => []),
    listAdoProjectSyncs().catch(() => []),
    listGitLabProjectSyncs().catch(() => []),
    listJiraInstances().catch(() => []),
    listGitHubInstances().catch(() => []),
    listAdoInstances().catch(() => []),
    listGitLabInstances().catch(() => []),
    listRetiredProjects().catch(() => []),
  ]);

  const knownProjectKeys = Array.from(
    new Set(jiraSyncs.map((s) => s.jiraProjectKey.toUpperCase())),
  ).sort();

  return (
    <main className="space-y-6 px-6 py-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Sources</h1>
        <p className="mt-1 text-sm text-slate-600">
          Catalog of providers and project syncs, shared by all boards.
        </p>
      </header>
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <IntelligenceSyncTrigger />
      </section>

      <InstancesPanel
        provider="jira"
        title="Jira"
        instances={jiraInstances}
        syncCount={countByInstance(jiraSyncs, 'jiraInstanceId')}
        onTest={testJiraConnection}
        onRefresh={refreshJiraToken}
        onDelete={deleteJiraInstance}
      />
      <InstancesPanel
        provider="github"
        title="GitHub"
        instances={githubInstances}
        syncCount={countByInstance(githubSyncs, 'githubInstanceId')}
        onTest={testGitHubConnection}
        onRefresh={refreshGitHubToken}
        onDelete={deleteGitHubInstance}
      />
      <InstancesPanel
        provider="ado"
        title="Azure DevOps"
        instances={adoInstances}
        syncCount={countByInstance(adoSyncs, 'azureDevOpsInstanceId')}
        onTest={testAdoConnection}
        onRefresh={refreshAdoToken}
        onDelete={deleteAdoInstance}
      />
      <InstancesPanel
        provider="gitlab"
        title="GitLab"
        instances={gitlabInstances}
        syncCount={countByInstance(gitlabSyncs, 'gitlabInstanceId')}
        onTest={testGitLabConnection}
        onRefresh={refreshGitLabToken}
        onDelete={deleteGitLabInstance}
      />

      <JiraConnectionsPanel initialSyncs={jiraSyncs} />
      <RetiredProjectsPanel initial={retiredProjects} knownProjectKeys={knownProjectKeys} />
      <GitHubConnectionsPanel initialSyncs={githubSyncs} />
      <AzureDevOpsConnectionsPanel initialSyncs={adoSyncs} />
      <GitLabConnectionsPanel initialSyncs={gitlabSyncs} />
    </main>
  );
}
