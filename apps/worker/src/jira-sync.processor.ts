import { PrismaClient } from '@deckgauge/db'
import { JiraPort } from '@deckgauge/shared'
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
   * The Jira connection these project keys belong to. Scopes the per-board JQL
   * filter lookup, so a board source on another connection that happens to share
   * a project key is not filtered by this run's key set.
   */
  instanceId?: string
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
  const { adapter, projectKeys, trigger, db, instanceId } = input

  // Create SyncRun record
  const syncRun = await db.syncRun.create({
    data: {
      status: 'PENDING',
      trigger: normalizeTrigger(trigger),
      startedAt: new Date(),
      source: 'jira',
    },
  })

  try {
    // Fetch data from adapter
    console.log(`[Processor] Fetching epics and issues for: ${projectKeys.join(', ')}`)
    const [epics, issues] = await Promise.all([
      adapter.fetchEpics(projectKeys),
      adapter.fetchIssues(projectKeys),
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
      })),
      issues: issues.map((i) => ({
        key: i.key,
        projectKey: i.projectKey,
        summary: i.summary,
        description: i.description ?? null,
        status: i.status,
        assignee: i.assignee ?? null,
        type: i.type,
      })),
    }, {
      allowedKeysBySourceId: jqlFilters.allowedKeysBySourceId,
      skipSourceIds: jqlFilters.skipSourceIds,
      // Deletion detection is confined to what this run actually covered —
      // promoteAll walks every JiraProjectSync row, including keys and
      // connections this run never fetched.
      syncedProjectKeys: projectKeys,
      instanceId,
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

function normalizeTrigger(trigger: string): 'STARTUP' | 'MANUAL' | 'SCHEDULED' {
  const normalized = trigger.toUpperCase()
  if (normalized === 'STARTUP') return 'STARTUP'
  if (normalized === 'MANUAL') return 'MANUAL'
  if (normalized === 'SCHEDULED') return 'SCHEDULED'
  throw new Error(`Unknown trigger: ${trigger}`)
}
