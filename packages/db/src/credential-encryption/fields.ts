/**
 * Every column in this schema that holds a credential, and the only list of them.
 *
 * These are not passwords to Deckgauge. Each one is a working token into the
 * customer's own GitHub, Jira, GitLab, Azure DevOps or Microsoft 365 tenant, which
 * is why a leaked database here is a breach of THEIR systems rather than only of
 * ours.
 *
 * Keys are Prisma model names as they appear in `schema.prisma` (the `model` value
 * a client extension receives), not table names.
 *
 * `__isolation__/credential-coverage.test.ts` parses the schema and fails if a
 * credential-shaped column exists that is missing from this map — so the tenth one
 * somebody adds cannot silently ship as plaintext.
 */
export const CREDENTIAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  JiraInstance: ["apiToken"],
  GitHubInstance: ["accessToken"],
  AzureDevOpsInstance: ["accessToken"],
  GitLabInstance: ["accessToken"],
  OrgTreeSource: ["msAccessToken", "msRefreshToken"],
  BoardCalendarSource: ["msAccessToken", "msRefreshToken"],
  AdvisorConfig: ["apiKey"],
};

/**
 * The distinct field NAMES, which is what the read walk matches on.
 *
 * It matches on the name because nested includes exist — `board →
 * jiraProjectSync → jiraInstance` among others — so the walk meets a credential
 * without knowing which model owns it. Matching by name alone would be unsafe on
 * its own, since the schema has ~20 `Json` columns that could contain a key
 * called `apiKey`; the walk is therefore ALSO gated on the value being a
 * `dgc.v1.` envelope. Both conditions, always.
 */
export const CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.values(CREDENTIAL_FIELDS).flat(),
);

/** Is this a model whose own columns include a credential? */
export function credentialFieldsFor(model: string | undefined): readonly string[] {
  return (model && CREDENTIAL_FIELDS[model]) || [];
}

/**
 * Escape hatch for the window between `prisma migrate deploy` and
 * `pnpm --filter @deckgauge/db encrypt-credentials` finishing on an existing
 * install. Downgrades the plaintext-read error to a warning.
 *
 * Deliberately not the default: a backfill that never ran would otherwise look
 * exactly like one that succeeded, which is the failure mode this repository has
 * already paid for twice in its test gates.
 */
export const ALLOW_PLAINTEXT_ENV = "DECKGAUGE_ALLOW_PLAINTEXT_CREDENTIALS";
