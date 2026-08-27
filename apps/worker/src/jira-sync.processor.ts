import { PrismaClient } from '@deckgauge/db'
import { JiraPort, JiraFieldSchemaShape } from '@deckgauge/shared'
import { JiraPromoteService } from './jira-promote.service.js'
import { resolveJqlAllowLists } from './jira-jql-filter.js'
import { type ChClient } from './jira-dual-writer.js'

interface ProcessorInput {
  adapter: JiraPort
  projectKeys: string[]
  trigger: string
  db: PrismaClient
  syncConfigMap?: Map<string, string>  // projectKey → syncConfigId
  /**
   * The Jira connection these project keys belong to. **Required.**
   *
   * Scopes the per-board JQL filter lookup, so a board source on another
   * connection that happens to share a project key is not filtered by this run's
   * key set — and, since 2026-08-26, scopes PROMOTION itself: `promoteAll` reads
   * only this connection's `JiraProjectSync` rows, because a project key is
   * unique per Jira instance and not per deployment (TENANCY-PROGRAMME §5a).
   *
   * Optional until that fix, which made it the tenant boundary of the whole run.
   * The one production caller (`jira-sync.handler.ts`) always passed
   * `instance.id`; requiring it means no future one can forget and quietly
   * promote across every connection in the deployment.
   */
  instanceId: string
  /**
   * The organization that owns the connection being synced. **Required.**
   *
   * Stamped onto the `SyncRun` this processor writes, which is the only way that
   * row can be attributed: `SyncRun` had no tenant column until 2026-08-26, and
   * its four `*SyncId` columns are dead (never written by anything), so a run is
   * not attributable after the fact. Required rather than optional for the same
   * reason `instanceId` is — a caller that forgets it would silently write a row
   * every other tenant's sync-status route could read.
   *
   * `jira-sync.handler.ts` already loops per instance and passes
   * `instance.organizationId` from the same object it takes `instance.id` from.
   */
  organizationId: string
  /**
   * Optional ClickHouse client, ALREADY BOUND to the organization that owns the
   * Jira connection being synced — jira-sync.handler calls `chClientFor` inside
   * its per-instance loop and hands the result down. The processor stays
   * tenant-agnostic: it never sees an organizationId and cannot pick the wrong
   * one.
   *
   * Historically the processor dual-wrote the unfiltered epics+issues set into
   * `jira_issues` here; that write moved to the intelligence sync (see the note
   * in the body). What it is used for now is the reverse direction: purging the
   * analytics rows of issues the deletion pass confirms are gone from Jira, so a
   * deleted issue stops contributing timesheet hours and widget numbers.
   */
  ch?: ChClient
}

interface ProcessorOutput {
  status: string
  trigger: string
  epicCount: number
  issueCount: number
  finishedAt: Date | null
  errorMessage: string | null
}

export async function jiraSyncProcessor(input: ProcessorInput): Promise<ProcessorOutput> {
  const { adapter, projectKeys, trigger, db, instanceId, organizationId } = input

  // Create SyncRun record
  const syncRun = await db.syncRun.create({
    data: {
      organizationId,
      status: 'PENDING',
      trigger: normalizeTrigger(trigger),
      startedAt: new Date(),
      source: 'jira',
    },
  })

  try {
    // The union of Jira field ids mapped across this run's board sources, and
    // the schema block for each — both computed before the fetch below, since
    // the field ids are an argument to it. Loaded directly rather than passed
    // in: the processor receives projectKeys/instanceId, not BoardJiraSource
    // rows, so it queries them itself here using the same scoping
    // `resolveJqlAllowLists` uses (jira-jql-filter.ts:88).
    const boardSources = await db.boardJiraSource.findMany({
      where: {
        // Unconditional, not a spread of a conditional clause — see
        // resolveJqlAllowLists for why: a spread evaluating to `{}` would be
        // indistinguishable from a deliberate deployment-wide read, and the
        // instanceId guard is what makes the unconditional form safe.
        jiraProjectSync: {
          jiraInstanceId: instanceId,
          jiraProjectKey: { in: projectKeys },
        },
      },
      select: { fieldMappings: true },
    })
    const extraFields = mappedFieldIds(boardSources)
    const fieldSchemas = await collectFieldSchemas(adapter, extraFields)

    // Fetch data from adapter
    console.log(`[Processor] Fetching epics and issues for: ${projectKeys.join(', ')}`)
    const [epics, issues] = await Promise.all([
      adapter.fetchEpics(projectKeys, extraFields),
      adapter.fetchIssues(projectKeys, extraFields),
    ])
    console.log(`[Processor] Fetched ${epics.length} epics, ${issues.length} issues`)

    // An empty answer is where an expired credential hides. Jira serves an
    // expired API token ANONYMOUSLY on both endpoints this sync uses — the
    // search answers 200 with no issues, and the per-key probe the deletion pass
    // relies on answers 404 — so a dead token looks exactly like a set of empty
    // projects full of deleted issues. Asking `/myself` is the only way to tell,
    // and it is only worth asking when the fetch came back with nothing.
    if (projectKeys.length > 0 && epics.length === 0 && issues.length === 0) {
      const credentials = (await adapter.checkCredentials?.()) ?? 'unknown'
      if (credentials === 'invalid') {
        // Thrown rather than recorded: this run knows nothing about any board,
        // so it must not reach the promote service at all.
        throw new Error(
          `Jira no longer authenticates this connection — the API token has expired or been revoked. ` +
            `Fetched nothing for ${projectKeys.join(', ')}; board rows were left untouched. ` +
            `Reconnect it under Sources to resume syncing.`,
        )
      }
    }

    // NB: the basic sync no longer dual-writes jira_issues to ClickHouse. The
    // basic JiraPort carries no sprint / story-point / status-category data, so
    // its rows (sprint_name = null, status_category = 'Unknown') were clobbering
    // the richer JiraIntelligencePort rows in the ReplacingMergeTree (newest
    // synced_at wins), blanking Velocity / Planning Accuracy. The intelligence
    // sync is now the sole, streaming ClickHouse writer for jira_issues; the
    // basic sync owns only the Postgres board-promotion path below.

    // Note: previously this step upserted jira_projects, jira_epics, jira_issues
    // into Postgres mirror tables. Those tables were dropped by
    // 20260603120000_drop_legacy_phase3_tables. The promote service now reads
    // the fetched arrays directly via the payload arg below.

    // Resolve each board source's Advanced-filter (JQL) into the issue keys it
    // admits. The fetch above is shared by every board on the project key, so the
    // filter has to be applied as an intersection at promote time.
    const jqlFilters = await resolveJqlAllowLists({ db, adapter, instanceId, projectKeys })

    // Second pass: promote Jira items to Project rows
    const promoteService = new JiraPromoteService(db)
    const promoteResult = await promoteService.promoteAll({
      epics: epics.map((e) => ({
        key: e.key,
        projectKey: e.projectKey,
        summary: e.summary,
        description: e.description ?? null,
        status: e.status,
        assignee: e.assignee ?? null,
        type: 'Epic',
        dueDate: e.dueDate ?? null,
        // The raw values of the board's mapped fields. Dropping this here is
        // what made field mapping inert: `PromoteJiraItem.extra` is optional,
        // so its omission type-checked, and `applyFieldMappings` then read
        // `row.extra ?? {}` and skipped every mapped column on every run.
        extra: e.extra,
      })),
      issues: issues.map((i) => ({
        key: i.key,
        projectKey: i.projectKey,
        summary: i.summary,
        description: i.description ?? null,
        status: i.status,
        assignee: i.assignee ?? null,
        type: i.type,
        dueDate: i.dueDate ?? null,
        extra: i.extra,
      })),
    }, {
      allowedKeysBySourceId: jqlFilters.allowedKeysBySourceId,
      skipSourceIds: jqlFilters.skipSourceIds,
      // Deletion detection is confined to what this run actually covered —
      // promoteAll walks every JiraProjectSync row, including keys and
      // connections this run never fetched.
      syncedProjectKeys: projectKeys,
      instanceId,
      fieldSchemas,
      // An adapter that cannot answer reports 'unknown', which leaves rows alone.
      verifyIssue: (issueKey: string) =>
        adapter.issueExists?.(issueKey) ?? Promise.resolve('unknown' as const),
      purgeAnalytics: input.ch?.purgeJiraIssueKeys?.bind(input.ch),
      // Off unless an operator turns it on for a run — see MASS_DELETION_SHARE.
      allowMassDeletion: process.env.JIRA_ALLOW_MASS_DELETION === '1',
    })
    console.log(`[Processor] Promote: ${promoteResult.created} created, ${promoteResult.updated} updated, ${promoteResult.markedRemoved} marked removed, ${promoteResult.markedDeleted} marked deleted`)

    // Update SyncRun with success. A filter Jira refused does not fail the run —
    // the other sources synced fine — but it is recorded so a board that silently
    // stopped updating has a traceable reason.
    const updated = await db.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        epicCount: epics.length,
        issueCount: issues.length,
        errorMessage: joinReasons(
          summarizeEmptyFetch(projectKeys, epics.length, issues.length),
          summarizeWithheldDeletions(promoteResult.withheldMassDeletions),
          summarizeJqlErrors(jqlFilters.errors),
        ),
      },
    })

    return {
      status: updated.status,
      trigger: updated.trigger,
      epicCount: updated.epicCount,
      issueCount: updated.issueCount,
      finishedAt: updated.finishedAt,
      errorMessage: updated.errorMessage,
    }
  } catch (error) {
    // Update SyncRun with failure
    const errorMessage = error instanceof Error ? error.message : String(error)
    const updated = await db.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage,
      },
    })

    return {
      status: updated.status,
      trigger: updated.trigger,
      epicCount: updated.epicCount,
      issueCount: updated.issueCount,
      finishedAt: updated.finishedAt,
      errorMessage: updated.errorMessage,
    }
  }
}

/**
 * A run that asked about projects and got nothing back.
 *
 * Jira can answer 200 with an empty result set while the projects are alive —
 * it did so for four hours on 2026-08-19 — and the promote service now declines
 * to read that as deletion. That silence has to reach the sync history too:
 * otherwise the only trace of an outage is a string of COMPLETED runs with zero
 * counts, which is exactly what it looked like while 392 live rows went black.
 */
function summarizeEmptyFetch(
  projectKeys: readonly string[],
  epicCount: number,
  issueCount: number,
): string | null {
  if (projectKeys.length === 0 || epicCount > 0 || issueCount > 0) return null
  return (
    `Jira returned no epics and no issues for ${projectKeys.join(', ')}. Treated as an outage, ` +
    `not as deletion — board rows were left untouched.`
  )
}

/**
 * Deletions a board source confirmed but did not write, for tripping the
 * blast-radius cap. A withheld verdict that only ever reached the worker log
 * would look, from the sync history, exactly like a run with nothing to do.
 */
function summarizeWithheldDeletions(
  withheld: ReadonlyArray<{ boardId: string; jiraProjectKey: string; confirmed: number; of: number }>,
): string | null {
  if (withheld.length === 0) return null
  const boards = withheld
    .map((w) => `${w.jiraProjectKey} on board ${w.boardId} (${w.confirmed} of ${w.of} rows)`)
    .join('; ')
  return (
    `Withheld a run that would have marked most of a board deleted: ${boards}. ` +
    `Nothing was written. If this really is a bulk deletion, re-run with JIRA_ALLOW_MASS_DELETION=1.`
  )
}

function joinReasons(...reasons: Array<string | null>): string | null {
  const present = reasons.filter((r): r is string => r !== null)
  return present.length === 0 ? null : present.join('; ')
}

function summarizeJqlErrors(
  errors: ReadonlyArray<{ boardSourceId: string; projectKey: string; message: string }>,
): string | null {
  if (errors.length === 0) return null
  return errors
    .map((e) => `JQL filter failed for ${e.projectKey} (board source ${e.boardSourceId}): ${e.message}`)
    .join('; ')
}

/**
 * The union of Jira field ids mapped across the sources this run covers.
 *
 * Computed from the same rows the promote step reads, so the set requested and
 * the set written can never diverge.
 */
function mappedFieldIds(
  sources: readonly { fieldMappings?: unknown }[],
): string[] {
  const ids = new Set<string>()
  for (const source of sources) {
    const mappings = (source.fieldMappings ?? {}) as Record<string, string>
    for (const fieldId of Object.keys(mappings)) ids.add(fieldId)
  }
  return Array.from(ids)
}

/**
 * Jira's `schema` block for each mapped field, which the promote step needs to
 * extract values. Instance-wide rather than per-issue, so it is fetched once
 * per run rather than carried on every row.
 *
 * Never fatal: a run whose field discovery fails should still sync names,
 * statuses and owners. Empty schemas mean the mapped columns keep their last
 * values, which is the same outcome as Jira not returning the field.
 */
async function collectFieldSchemas(
  adapter: JiraPort,
  fieldIds: string[],
): Promise<Record<string, JiraFieldSchemaShape>> {
  if (fieldIds.length === 0 || !adapter.fetchFields) return {}
  try {
    const all = await adapter.fetchFields()
    const wanted = new Set(fieldIds)
    const schemas: Record<string, JiraFieldSchemaShape> = {}
    for (const field of all) {
      if (wanted.has(field.id) && field.schema) schemas[field.id] = field.schema
    }
    return schemas
  } catch (err) {
    console.warn('[jira-sync] field schema discovery failed; mapped columns will not update', err)
    return {}
  }
}

function normalizeTrigger(trigger: string): 'STARTUP' | 'MANUAL' | 'SCHEDULED' {
  const normalized = trigger.toUpperCase()
  if (normalized === 'STARTUP') return 'STARTUP'
  if (normalized === 'MANUAL') return 'MANUAL'
  if (normalized === 'SCHEDULED') return 'SCHEDULED'
  throw new Error(`Unknown trigger: ${trigger}`)
}
