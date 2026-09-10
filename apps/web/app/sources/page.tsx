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
import { isOrganizationAdmin, canManageOwnConnections } from '../lib/org-role';
import {
  VIEWER_CANNOT_ADD_CONNECTIONS,
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
    <div className="space-y-6 py-2 md:px-6 md:py-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Sources</h1>
      </header>
      <p className="text-sm text-slate-600">{message}</p>
    </div>
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
  // Member-level now: only a VIEWER is refused. See canManageOwnConnections for
  // why this cannot read `state.membership`.
  const canAddConnections = canManageOwnConnections(state);

  const [jiraSyncs, githubSyncs, adoSyncs, gitlabSyncs, retiredProjects] = await Promise.all([
    listJiraProjectSyncs().catch(() => []),
    listGitHubRepoSyncs().catch(() => []),
    listAdoProjectSyncs().catch(() => []),
    listGitLabProjectSyncs().catch(() => []),
    listRetiredProjects().catch(() => []),
  ]);

  // Fetched for every member, not just administrators. The InstancesPanels are no
  // longer admin-only: a member manages their own connections and the
  // organization-wide ones, so an empty catalog would hide connections they are
  // entitled to see and manage. The API filters the list — organization-wide plus
  // the caller's own, everything for an admin — so this page does not decide who
  // sees what, which is the only place that decision belongs.
  const [jiraInstances, githubInstances, adoInstances, gitlabInstances] = await Promise.all([
    listJiraInstances().catch(() => []),
    listGitHubInstances().catch(() => []),
    listAdoInstances().catch(() => []),
    listGitLabInstances().catch(() => []),
  ]);

  const knownProjectKeys = Array.from(
    new Set(jiraSyncs.map((s) => s.jiraProjectKey.toUpperCase())),
  ).sort();

  return (
    <div className="space-y-6 py-2 md:px-6 md:py-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Sources</h1>
        <p className="mt-1 text-sm text-slate-600">
          Catalog of providers and project syncs, shared by all boards.
        </p>
      </header>
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <IntelligenceSyncTrigger />
      </section>

      {/* No longer admin-gated. Every member may add a connection and manage the
          ones they may use, which is the whole point of this phase — an
          administrator was the bottleneck for anyone wanting to pull their own
          project onto a board. What a member sees is decided by the API's
          filtering, not here. A VIEWER is still refused, by orgRole('MEMBER') on
          the routes, and sees the notice below. */}
      {canAddConnections ? (
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
          {VIEWER_CANNOT_ADD_CONNECTIONS} You can still manage the project syncs below.
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
    </div>
  );
}
