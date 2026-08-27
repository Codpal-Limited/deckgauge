// `SourceFieldsService` returns the live field list for a BoardJiraSource so
// the web field picker can offer the fields that actually exist in the user's
// Jira instance — including their custom fields, whose ids differ per instance
// and therefore cannot be hardcoded.
//
// Modelled on `SourceIssueTypesService`, and its two invariants carry over for
// the same reasons:
//
//   - `organizationId` leads the parameter list, so a mis-ordered call fails to
//     compile rather than silently becoming a tenant bypass.
//   - `boardId` is checked against the loaded source row, so a user with access
//     to board A cannot probe a source attached to board B. Route auth already
//     gates by board; the service does not trust the caller.
//
// Discovery hits Jira's REST API, which is rate-limited, so the shared
// `TypeCache` dedupes inflight loads and remembers the result for ~60s.

import type { PrismaClient } from '@deckgauge/db';
import {
  columnTypeForJiraField,
  unsupportedReasonFor,
  type DiscoveredJiraField,
  type JiraPort,
} from '@deckgauge/shared';
import type { TypeCache } from './type-cache.js';

export class SourceFieldsNotFoundError extends Error {
  constructor(provider: string, id: string) {
    super(`${provider} source ${id} not found`);
    this.name = 'SourceFieldsNotFoundError';
  }
}

interface Deps {
  prisma: PrismaClient;
  cache: TypeCache;
  jiraAdapterFor: (organizationId: string, instanceId: string) => Promise<JiraPort>;
}

export class SourceFieldsService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async listJira(
    organizationId: string,
    boardId: string,
    boardJiraSourceId: string,
  ): Promise<DiscoveredJiraField[]> {
    const row = await this.deps.prisma.boardJiraSource.findUnique({
      where: { id: boardJiraSourceId },
      include: { jiraProjectSync: true },
    });
    if (!row || row.boardId !== boardId) {
      throw new SourceFieldsNotFoundError('jira', boardJiraSourceId);
    }

    const instanceId = row.jiraProjectSync.jiraInstanceId;

    return this.deps.cache.getOrFetch<DiscoveredJiraField[]>(
      {
        organizationId,
        instanceId,
        provider: 'jira',
        kind: 'fields',
        // Fields are instance-wide, not per-project, so the resource leg is a
        // constant. Tenant and instance still lead the key, which is what keeps
        // one organization's discovered fields away from another's.
        resource: 'instance',
      },
      async () => {
        const adapter = await this.deps.jiraAdapterFor(organizationId, instanceId);
        // An adapter without `fetchFields` means discovery is unavailable, not
        // that something failed — hand-built doubles omit the optional method.
        if (!adapter.fetchFields) return [];

        const raw = await adapter.fetchFields();
        const discovered = raw.map((f): DiscoveredJiraField => {
          const columnType = columnTypeForJiraField(f.schema);
          return {
            id: f.id,
            name: f.name,
            custom: f.custom,
            columnType,
            supported: columnType !== null,
            unsupportedReason: unsupportedReasonFor(f.schema),
            // A list field stores its values joined, and only the column's
            // config can tell the renderer to split them back into chips —
            // the stored TEXT looks identical to hand-typed text.
            multiValue: f.schema?.type === 'array',
          };
        });

        // Supported first so the picker's useful entries are reachable without
        // scrolling past the ones it will not let you choose.
        return discovered.sort((a, b) => {
          if (a.supported !== b.supported) return a.supported ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      },
    );
  }
}
