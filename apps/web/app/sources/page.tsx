import { IntelligenceSyncTrigger } from '../components/IntelligenceSyncTrigger';
import { JiraConnectionsPanel } from '../components/connections/JiraConnectionsPanel';
import { GitHubConnectionsPanel } from '../components/connections/GitHubConnectionsPanel';
import { AzureDevOpsConnectionsPanel } from '../components/connections/AzureDevOpsConnectionsPanel';
import { GitLabConnectionsPanel } from '../components/connections/GitLabConnectionsPanel';
import { InstancesPanel } from '../components/connections/InstancesPanel';
import { AddConnectionPanel } from '../components/connections/AddConnectionPanel';
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
import { getBootstrapState } from '../actions/organization';
import { isOrganizationAdmin } from '../lib/org-role';
import {
  ORG_ADMIN_REQUIRED,
  MEMBERSHIP_SUSPENDED_MESSAGE,
  NO_ORGANIZATION_MESSAGE,
} from '../lib/connection-permission';

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

function Refusal({ message }: { message: string }) {
  return (
    <main className="space-y-6 px-6 py-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Sources</h1>
      </header>
      <p className="text-sm text-slate-600">{message}</p>
    </main>
  );
}

export default async function SourcesPage() {
  // This screen renders two different kinds of thing, and the API gates them
  // differently, so the gate is per-section rather than per-page.
  //
  // Admin-only — the 21 routes Task 7 moved to orgRole(ADMIN) are all
  // instance-level: create, edit, delete, test and refresh-token per provider,
  // plus the ADO production-deploy config. Those back AddConnectionPanel and the
  // four InstancesPanels.
  //
  // Member-level — project-sync management (POST/PATCH/DELETE
  // /project-syncs/*, orgRole(MEMBER); the GET reads are `authenticated`) and
  // retired projects (orgRole(MEMBER), VIEWER to read). Those back the four
  // *ConnectionsPanels, which despite the name manage project syncs, and
  // RetiredProjectsPanel. Refusing a member the whole page took capability away
  // that the API still grants — a regression, not a tightening.
  const state = await getBootstrapState();

  // No active membership means no role to read: the policy gate answers
  // NO_ORGANIZATION (or the auth plugin answers MEMBERSHIP_SUSPENDED) on the
  // project-sync mutations too, so nothing on this screen is reachable. Distinct
  // copy, because telling a suspended member to become an administrator is a
  // lie about what is wrong.
  if (state.state !== 'MEMBER') {
    return (
      <Refusal
        message={
          state.state === 'SUSPENDED' ? MEMBERSHIP_SUSPENDED_MESSAGE : NO_ORGANIZATION_MESSAGE
        }
      />
    );
  }

  const canManageConnections = isOrganizationAdmin(state);

  const [jiraSyncs, githubSyncs, adoSyncs, gitlabSyncs, retiredProjects] = await Promise.all([
    listJiraProjectSyncs().catch(() => []),
    listGitHubRepoSyncs().catch(() => []),
    listAdoProjectSyncs().catch(() => []),
    listGitLabProjectSyncs().catch(() => []),
    listRetiredProjects().catch(() => []),
  ]);

  // The instance catalog feeds nothing but the admin-only InstancesPanels, so a
  // member never issues these four requests. They would not 403 today (the list
  // reads stayed on orgRole(MEMBER)) but fetching a catalog to render nothing is
  // four round-trips of waste, and if the reads ever tighten this is already
  // right.
  const [jiraInstances, githubInstances, adoInstances, gitlabInstances] = canManageConnections
    ? await Promise.all([
        listJiraInstances().catch(() => []),
        listGitHubInstances().catch(() => []),
        listAdoInstances().catch(() => []),
        listGitLabInstances().catch(() => []),
      ])
    : [[], [], [], []];

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

      {canManageConnections ? (
        <>
          <AddConnectionPanel />

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
        </>
      ) : (
        <p className="rounded-lg border border-slate-200 bg-white px-6 py-4 text-sm text-slate-600">
          {ORG_ADMIN_REQUIRED} You can still manage the project syncs below.
        </p>
      )}

      <JiraConnectionsPanel initialSyncs={jiraSyncs} />
      <RetiredProjectsPanel initial={retiredProjects} knownProjectKeys={knownProjectKeys} />
      <GitHubConnectionsPanel initialSyncs={githubSyncs} />
      {/* canManageConnections: this panel manages project syncs (member-level),
          but one cell of it — the production-deploy allow-lists — writes through
          an orgRole(ADMIN) endpoint. Passing the role stops a member being shown
          inputs whose save is refused halfway through. */}
      <AzureDevOpsConnectionsPanel
        initialSyncs={adoSyncs}
        canManageConnections={canManageConnections}
      />
      <GitLabConnectionsPanel initialSyncs={gitlabSyncs} />
    </main>
  );
}
