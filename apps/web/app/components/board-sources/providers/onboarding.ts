import type { Provider } from './roles';

/**
 * Per-provider "how to get a token" guidance shown inside the connection form.
 * The goal is that a non-technical user can create a working token without
 * leaving the wizard: a deep-link straight to the provider's token page (with
 * name + scopes pre-filled where the provider supports query params), the exact
 * scopes to tick, and a short numbered walkthrough.
 */
export interface OnboardingGuide {
  /** Deep link to the provider's token-creation page. */
  tokenUrl: string;
  /** Text for the link button, e.g. "Open GitHub's token page". */
  linkLabel: string;
  /**
   * Minimum scopes to grant, shown as a checklist. `null` when the provider's
   * tokens have no scope selection at all (Jira API tokens).
   */
  scopes: string[] | null;
  /** Short numbered walkthrough, rendered as an ordered list. */
  steps: string[];
  /** Optional clarifying note shown under the steps. */
  note?: string;
}

// Scopes are the single source of truth for the providers whose token pages
// accept a pre-filled `scopes` query param — the deep-link URL is derived from
// the same array the user is told to tick, so the two can never drift apart.
const GITHUB_SCOPES = ['repo', 'read:org', 'read:user'];
const GITLAB_SCOPES = ['read_api', 'read_repository', 'read_user'];

export const PROVIDER_ONBOARDING: Record<Provider, OnboardingGuide> = {
  github: {
    tokenUrl: `https://github.com/settings/tokens/new?description=Deckgauge&scopes=${GITHUB_SCOPES.join(
      ',',
    )}`,
    linkLabel: "Open GitHub's token page",
    scopes: GITHUB_SCOPES,
    steps: [
      "Open GitHub's token page — the name and scopes are pre-filled for you.",
      'Confirm the scopes below are checked.',
      'Click "Generate token" and copy it (GitHub shows it only once).',
      'Paste it below and click "Create & test".',
    ],
    note: 'Use "repo" for private repositories, or "public_repo" if you only need public ones.',
  },
  jira: {
    tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    linkLabel: 'Open Atlassian API tokens',
    scopes: null,
    steps: [
      'Open the Atlassian API-token page and click "Create API token".',
      'Name it "Deckgauge" and copy the token.',
      'Enter your Atlassian site URL and the email of that account below.',
      'Paste the token and click "Create & test".',
    ],
    note: 'Jira API tokens have no scopes — Deckgauge sees exactly the projects your account can already see.',
  },
  ado: {
    tokenUrl:
      'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate',
    linkLabel: 'How to create an Azure DevOps token',
    // Release (Read) is NOT optional despite having been absent from this list
    // for as long as deployment ingestion has existed. DORA's deploy frequency
    // and change failure rate read classic Release pipeline deployments from
    // vsrm.dev.azure.com/{org}/{project}/_apis/release/deployments; without the
    // scope that call fails, the per-project catch swallows it, and both metrics
    // quietly fall back to their proxies. A token minted by following these
    // steps could not read a single deployment.
    //
    // Environment (Read) covers multi-stage YAML pipeline deployments
    // (distributedtask/environments/{id}/environmentdeploymentrecords), which
    // are not ingested yet — the endpoint answers an auth redirect rather than
    // JSON without it. Asked for now so the tokens minted from here are already
    // able to read them when that source is added, instead of every connection
    // needing to be re-tokenised on that day.
    scopes: [
      'Code (Read)',
      'Work Items (Read)',
      'Project & Team (Read)',
      'Release (Read)',
      'Environment (Read)',
    ],
    steps: [
      'In your Azure DevOps org, open User settings → Personal access tokens.',
      'Click "New Token" and grant every read scope below.',
      'Copy the token, then enter your organization URL below.',
      'Paste the token and click "Create & test".',
    ],
    note: 'Release (Read) is what lets Deckgauge count real deployments — without it, Deployment Frequency and Change Failure Rate fall back to estimates.',
  },
  gitlab: {
    tokenUrl: `https://gitlab.com/-/user_settings/personal_access_tokens?name=Deckgauge&scopes=${GITLAB_SCOPES.join(
      ',',
    )}`,
    linkLabel: "Open GitLab's token page",
    scopes: GITLAB_SCOPES,
    steps: [
      "Open GitLab's access-token page — the name and scopes are pre-filled.",
      'Confirm the scopes below, set an expiry, and click "Create".',
      'Copy the token. For self-hosted GitLab, change the API base URL below to your instance.',
      'Paste the token and click "Create & test".',
    ],
  },
};
