export type Provider = 'jira' | 'github' | 'ado' | 'gitlab' | 'bitbucket';

export interface RoleField {
  /** Maps 1:1 to the attach-action flag name. */
  key: string;
  label: string;
  default: boolean;
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  jira: 'Jira',
  github: 'GitHub',
  ado: 'Azure DevOps',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

// Role toggles shown in the wizard's review step. Keys + defaults must match
// the create schemas in packages/shared/src/connections-schemas.ts.
export const PROVIDER_ROLE_FIELDS: Record<Provider, RoleField[]> = {
  jira: [],
  github: [
    { key: 'syncIssuesToBoard', label: 'Feed issues to board', default: true },
    { key: 'useForIntelligence', label: 'Use for code intelligence', default: true },
  ],
  ado: [
    { key: 'syncWorkItemsToBoard', label: 'Feed work items to board', default: true },
    { key: 'useForIntelligence', label: 'Use for code intelligence', default: true },
  ],
  gitlab: [
    { key: 'syncIssuesToBoard', label: 'Feed issues to board', default: false },
    { key: 'syncMrsToBoard', label: 'Feed MRs to board', default: false },
  ],
  // Bitbucket never writes board rows — tasks come from Jira; Bitbucket feeds
  // code intelligence only (spec 2026-11-03 non-goals).
  bitbucket: [],
};

export function defaultRoleFlags(provider: Provider): Record<string, boolean> {
  return Object.fromEntries(
    PROVIDER_ROLE_FIELDS[provider].map((f) => [f.key, f.default]),
  );
}
