import type { Provider } from './roles';

export interface ConnectionField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select';
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
}

// Fields map 1:1 to the create-instance action inputs.
export const PROVIDER_CONNECTION_FIELDS: Record<Provider, ConnectionField[]> = {
  jira: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'atlassianUrl', label: 'Atlassian URL', type: 'url', required: true, placeholder: 'https://acme.atlassian.net' },
    { key: 'email', label: 'Email', type: 'text', required: true },
    { key: 'apiToken', label: 'API token', type: 'password', required: true },
  ],
  github: [
    { key: 'baseUrl', label: 'API base URL (optional)', type: 'url', required: false, placeholder: 'https://api.github.com' },
    { key: 'accessToken', label: 'Personal access token', type: 'password', required: true },
    // Which org the board repo picker lists. Empty lists every repo the token
    // can see — the only behaviour before this field existed (issue #3).
    { key: 'org', label: 'Organization (optional)', type: 'text', required: false, placeholder: 'acme — empty lists every repo the token can see' },
  ],
  ado: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'orgUrl', label: 'Organization URL', type: 'url', required: true, placeholder: 'https://dev.azure.com/acme' },
    {
      key: 'authMethod',
      label: 'Auth method',
      type: 'select',
      required: true,
      options: [
        { value: 'PAT', label: 'Personal access token' },
        { value: 'BASIC', label: 'Basic (username + token)' },
      ],
    },
    { key: 'accessToken', label: 'Access token', type: 'password', required: true },
    { key: 'username', label: 'Username (Basic auth only)', type: 'text', required: false },
  ],
  gitlab: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'baseUrl', label: 'API base URL (optional)', type: 'url', required: false, placeholder: 'https://gitlab.com/api/v4' },
    { key: 'accessToken', label: 'Access token', type: 'password', required: true },
  ],
};

export function requiredKeys(provider: Provider): string[] {
  return PROVIDER_CONNECTION_FIELDS[provider].filter((f) => f.required).map((f) => f.key);
}
