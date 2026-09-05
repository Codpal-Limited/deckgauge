import { AzureDevOpsPort } from './azure-devops-port.js';
import { AzureDevOpsWorkItem } from './azure-devops-schemas.js';
import { AdoWorkItemRevision } from './ado-work-item-revision.js';

const PROJECT_A = 'ProjectAlpha';
const PROJECT_B = 'ProjectBeta';

// Fake timestamps are static so test snapshots stay stable. Real adapter pulls
// these from System.CreatedDate / System.ChangedDate / Microsoft.VSTS.Common.ClosedDate.
const FAKE_CREATED = new Date('2026-03-01T08:00:00Z');
const FAKE_CHANGED = new Date('2026-04-01T08:00:00Z');
const FAKE_CLOSED = new Date('2026-04-15T08:00:00Z');

function wi(
  partial: Omit<AzureDevOpsWorkItem, 'createdAt' | 'changedAt' | 'closedAt'>,
): AzureDevOpsWorkItem {
  return {
    ...partial,
    createdAt: FAKE_CREATED,
    changedAt: FAKE_CHANGED,
    closedAt: partial.state === 'Closed' ? FAKE_CLOSED : null,
  };
}

const SEED_WORK_ITEMS: Record<string, AzureDevOpsWorkItem[]> = {
  [PROJECT_A]: [
    wi({
      adoId: 100,
      adoParentId: null,
      type: 'Epic',
      title: 'Platform Modernization',
      state: 'Active',
      assignedTo: 'Alice',
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 1`,
      description: 'Modernize the platform architecture',
      fields: { 'Microsoft.VSTS.Scheduling.Effort': 13 },
    }),
    wi({
      adoId: 101,
      adoParentId: 100,
      type: 'Feature',
      title: 'API Gateway',
      state: 'Active',
      assignedTo: 'Bob',
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 1`,
      description: 'Implement API gateway',
      fields: {},
    }),
    wi({
      adoId: 102,
      adoParentId: 100,
      type: 'Feature',
      title: 'Auth Service',
      state: 'New',
      assignedTo: null,
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 2`,
      description: null,
      fields: {},
    }),
    wi({
      adoId: 103,
      adoParentId: 101,
      type: 'User Story',
      title: 'Rate limiting middleware',
      state: 'Active',
      assignedTo: 'Bob',
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 1`,
      description: 'Add rate limiting',
      fields: { 'Microsoft.VSTS.Scheduling.Effort': 5 },
    }),
    wi({
      adoId: 104,
      adoParentId: 101,
      type: 'User Story',
      title: 'Request logging',
      state: 'Closed',
      assignedTo: 'Charlie',
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 1`,
      description: 'Log all requests',
      fields: {},
    }),
    wi({
      adoId: 105,
      adoParentId: 101,
      type: 'User Story',
      title: 'Health check endpoint',
      state: 'Active',
      assignedTo: 'Alice',
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 1`,
      description: null,
      fields: {},
    }),
    wi({
      adoId: 106,
      adoParentId: 103,
      type: 'Task',
      title: 'Write rate limiter tests',
      state: 'Active',
      assignedTo: 'Bob',
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 1`,
      description: null,
      fields: {},
    }),
    wi({
      adoId: 107,
      adoParentId: 103,
      type: 'Task',
      title: 'Implement sliding window',
      state: 'New',
      assignedTo: 'Bob',
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 1`,
      description: null,
      fields: {},
    }),
    wi({
      adoId: 108,
      adoParentId: 101,
      type: 'Bug',
      title: 'Gateway timeout on large payloads',
      state: 'Active',
      assignedTo: 'Charlie',
      areaPath: `${PROJECT_A}\\Backend`,
      iterationPath: `${PROJECT_A}\\Sprint 1`,
      description: 'Requests > 5MB cause 504',
      fields: { 'Microsoft.VSTS.Common.Priority': 1 },
    }),
  ],
  [PROJECT_B]: [
    wi({
      adoId: 200,
      adoParentId: null,
      type: 'Epic',
      title: 'Mobile App v2',
      state: 'Active',
      assignedTo: 'Dana',
      areaPath: PROJECT_B,
      iterationPath: `${PROJECT_B}\\Iteration 1`,
      description: 'Second major version of mobile app',
      fields: {},
    }),
    wi({
      adoId: 201,
      adoParentId: null,
      type: 'Epic',
      title: 'Analytics Dashboard',
      state: 'New',
      assignedTo: null,
      areaPath: PROJECT_B,
      iterationPath: `${PROJECT_B}\\Iteration 2`,
      description: 'Build analytics dashboard',
      fields: {},
    }),
    wi({
      adoId: 202,
      adoParentId: 200,
      type: 'User Story',
      title: 'Push notifications',
      state: 'Active',
      assignedTo: 'Dana',
      areaPath: PROJECT_B,
      iterationPath: `${PROJECT_B}\\Iteration 1`,
      description: 'Enable push notifications',
      fields: {},
    }),
    wi({
      adoId: 203,
      adoParentId: 200,
      type: 'User Story',
      title: 'Offline mode',
      state: 'New',
      assignedTo: null,
      areaPath: PROJECT_B,
      iterationPath: `${PROJECT_B}\\Iteration 1`,
      description: null,
      fields: {},
    }),
    wi({
      adoId: 204,
      adoParentId: 201,
      type: 'User Story',
      title: 'Daily active users chart',
      state: 'New',
      assignedTo: 'Eve',
      areaPath: PROJECT_B,
      iterationPath: `${PROJECT_B}\\Iteration 2`,
      description: 'Show DAU chart on dashboard',
      fields: {},
    }),
    wi({
      adoId: 205,
      adoParentId: 201,
      type: 'User Story',
      title: 'Export to CSV',
      state: 'New',
      assignedTo: null,
      areaPath: PROJECT_B,
      iterationPath: `${PROJECT_B}\\Iteration 2`,
      description: null,
      fields: {},
    }),
  ],
};

const WORK_ITEM_TYPES: Record<string, string[]> = {
  [PROJECT_A]: ['Epic', 'Feature', 'User Story', 'Task', 'Bug'],
  [PROJECT_B]: ['Epic', 'Feature', 'User Story', 'Task', 'Bug'],
};

export class FakeAzureDevOpsAdapter implements AzureDevOpsPort {
  /**
   * Optional override for tests that need queryMatchingIds to return a specific
   * subset for a given wiqlFilter. Returns the IDs that should pass the WIQL
   * clause for tests. Real production WIQL evaluation is delegated to ADO.
   */
  wiqlIdHook?: (project: string, wiqlFilter: string) => Set<number>;

  async fetchWorkItems(project: string): Promise<AzureDevOpsWorkItem[]> {
    return SEED_WORK_ITEMS[project] ?? [];
  }

  async *streamWorkItemRevisions(
    _project: string,
    _since?: Date,
  ): AsyncGenerator<AdoWorkItemRevision[]> {
    // No seeded revisions in the fake by default.
  }

  async *streamWorkItems(project: string): AsyncGenerator<AzureDevOpsWorkItem[]> {
    const items = SEED_WORK_ITEMS[project] ?? [];
    if (items.length > 0) {
      yield items;
    }
  }

  async queryMatchingIds(
    project: string,
    allowedTypes: string[],
    wiqlFilter: string | null,
  ): Promise<Set<number>> {
    let candidates = SEED_WORK_ITEMS[project] ?? [];
    if (allowedTypes.length > 0) {
      candidates = candidates.filter((i) => allowedTypes.includes(i.type));
    }
    // The fake adapter treats `wiqlFilter` as opaque — production WIQL parsing
    // is out of scope. Tests using WIQL drive ID set membership via a hook.
    if (wiqlFilter && this.wiqlIdHook) {
      const allowed = this.wiqlIdHook(project, wiqlFilter);
      candidates = candidates.filter((i) => allowed.has(i.adoId));
    }
    return new Set(candidates.map((i) => i.adoId));
  }

  async fetchWorkItemTypes(project: string): Promise<string[]> {
    return WORK_ITEM_TYPES[project] ?? [];
  }
}
