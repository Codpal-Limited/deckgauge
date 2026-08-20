import { PrismaClient } from '@deckgauge/db';
import {
  DELETED_STATUS_COLOR,
  DELETED_STATUS_LABEL,
  LEGACY_STATUS_LABELS,
  STATUS_COLORS,
  type JiraIssueExistence,
} from '@deckgauge/shared';
import { ensureDefaultGroup } from './sync-default-group.js';

export interface PromoteResult {
  created: number;
  updated: number;
  markedRemoved: number;
  /** Rows whose Jira issue was CONFIRMED gone and turned black. */
  markedDeleted: number;
  /**
   * Board sources where a run's confirmed deletions were withheld for tripping
   * the blast-radius cap. Empty on an ordinary run. Surfaced so a withheld
   * verdict reaches the sync history instead of looking like nothing happened.
   */
  withheldMassDeletions: WithheldMassDeletion[];
}

/** One board source's withheld verdict: it confirmed `confirmed` of `of` rows. */
export interface WithheldMassDeletion {
  boardId: string;
  jiraProjectKey: string;
  confirmed: number;
  of: number;
}

/**
 * How many candidates one run may probe per board source. A COST bound, not a
 * safety one — correctness comes from the per-key probe, which answers `exists`
 * (and so changes nothing) for the candidates a truncated fetch invents, and
 * `unknown` unless it can corroborate a 404 against a credential that still
 * authenticates and a project still in view. That corroboration is what makes
 * the probe trustworthy: before it existed, an expired token's 404s read as 392
 * deletions (2026-08-19).
 *
 * It is a budget rather than a refusal because a board can carry a BACKLOG of
 * deletions no earlier sync ever looked for: the RR Epics board held 353 the
 * first time this ran. Refusing above a threshold would have left that backlog
 * stuck forever. Whatever is left over is logged and picked up next run —
 * confirmed rows stop being candidates, so each run makes progress.
 */
export const MAX_DELETION_PROBES_PER_RUN = 200;

/**
 * The blast-radius cap: one run may not black out more than this SHARE of a
 * board source's synced rows for its project key.
 *
 * A backstop for the failure nobody has thought of yet. The empty-payload guards
 * and the probe's own corroboration each answer a cause we now understand; the
 * 2026-08-19 incident was understood only afterwards, and by then whole boards
 * were black. A run concluding that most of a board just died is far likelier to
 * be wrong about Jira than right about the board, whatever the cause.
 */
export const MASS_DELETION_SHARE = 0.5;

/**
 * …but only once a run has confirmed at least this many. On a board of four
 * rows "most of it" is ordinary attrition, and policing a proportion there would
 * make small boards unusable without catching anything.
 */
export const MASS_DELETION_FLOOR = 20;

/** A board row whose Jira issue is gone, paired with the key to purge for it. */
interface PurgeTarget {
  id: string;
  jiraKey: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map board status label back to legacy ProjectStatus enum for the required `status` column. */
const LABEL_TO_ENUM: Record<string, string> = {
  'not started': 'NOT_STARTED',
  'in progress': 'IN_PROGRESS',
  'at risk': 'AT_RISK',
  'blocked': 'BLOCKED',
  'done': 'DONE',
};

interface CachedBoardStatus {
  id: string;
  label: string;
  color: string;
}

/**
 * Minimal Jira item shape the promote service needs. Sourced from the JiraPort
 * adapter's fetchEpics/fetchIssues output — fed in-memory by the processor.
 * Previously this data was mirrored in Postgres `jira_epics` / `jira_issues`,
 * but those tables were dropped by 20260603120000_drop_legacy_phase3_tables.
 */
export interface PromoteJiraItem {
  key: string;
  projectKey: string;
  summary: string;
  description?: string | null;
  status: string;
  assignee?: string | null;
  type: string;
}

export interface PromotePayload {
  epics: PromoteJiraItem[];
  issues: PromoteJiraItem[];
}

/**
 * Per-board-source JQL filtering, resolved by `resolveJqlAllowLists` before the
 * promote runs. Sources absent from both collections are promoted unfiltered.
 */
export interface PromoteOptions {
  /** boardJiraSource.id → the only issue keys that source may promote. */
  allowedKeysBySourceId?: Map<string, ReadonlySet<string>>;
  /** Sources whose filter could not be resolved — skipped entirely, so a broken filter never widens the board. */
  skipSourceIds?: ReadonlySet<string>;
  /**
   * The project keys this run actually fetched. Deletion detection is confined
   * to them: promoteAll walks EVERY JiraProjectSync row, so without this every
   * row of every key the run did not fetch looks like a deletion candidate.
   */
  syncedProjectKeys?: readonly string[];
  /** The Jira connection this run belongs to — same confinement, across connections. */
  instanceId?: string;
  /**
   * Asks Jira whether one issue key still resolves. Absent (or an adapter that
   * cannot answer) turns deletion detection off entirely; `'unknown'` for a key
   * leaves that row untouched.
   */
  verifyIssue?: (issueKey: string) => Promise<JiraIssueExistence>;
  /**
   * Lets a run through the blast-radius cap. The escape hatch for a genuine bulk
   * deletion — a retired project whose rows really are all gone — set
   * deliberately by an operator for one run, never on by default.
   */
  allowMassDeletion?: boolean;
  /**
   * Drops the confirmed-deleted keys' rows from the analytics store, so a
   * deleted issue stops contributing timesheet hours and widget numbers. Called
   * once, at the end, with every key confirmed this run. A failure here is
   * logged and swallowed: the board signal is the primary outcome.
   */
  purgeAnalytics?: (issueKeys: string[]) => Promise<void>;
}

export class JiraPromoteService {
  constructor(private readonly prisma: PrismaClient) {}

  async promoteAll(
    payload: PromotePayload = { epics: [], issues: [] },
    options: PromoteOptions = {},
  ): Promise<PromoteResult> {
    let created = 0;
    let updated = 0;
    let markedRemoved = 0;
    let markedDeleted = 0;
    const withheldMassDeletions: WithheldMassDeletion[] = [];
    /** Rows whose ClickHouse history still has to go: confirmed this run, or left over from an earlier one. */
    const purgeTargets: PurgeTarget[] = [];

    // New model: 1 JiraProjectSync per (instance, project key); per-board filters
    // live on BoardJiraSource. One project sync fans out into N board sources.
    const projectSyncs = await this.prisma.jiraProjectSync.findMany({
      include: { boardSources: true },
    });

    for (const ps of projectSyncs) {
      const jiraProjectKey = ps.jiraProjectKey;
      // Hoisted: the payload is shared by every board source on this key, and
      // scanning it once per source would rescan thousands of issues per board.
      const payloadKeys = this.payloadKeysFor(payload, jiraProjectKey);

      for (const boardSource of ps.boardSources) {
        // Its JQL filter could not be resolved this run (Jira rejected it, or was
        // unreachable). Promoting unfiltered would flood the board with the whole
        // project; marking removed would flag every row it already has. Leave it be.
        if (options.skipSourceIds?.has(boardSource.id)) {
          console.warn(
            `[JiraPromote] Skipping board source ${boardSource.id} (${jiraProjectKey}) — its JQL filter could not be resolved`,
          );
          continue;
        }

        const allowedKeys = options.allowedKeysBySourceId?.get(boardSource.id) ?? null;
        const allowedTypes = boardSource.allowedIssueTypes as string[];
        const statusMapping = (boardSource.statusMapping ?? {}) as Record<string, string>;
        const fieldMappings = (boardSource.fieldMappings ?? {}) as Record<string, string>;
        const defaultSyncedFields = (boardSource.defaultSyncedFields ?? [
          'name',
          'status',
          'owner',
          'description',
        ]) as string[];

        // Pre-load board statuses for this board (cache to avoid N+1)
        const statusCache = await this.loadStatusCache(boardSource.boardId);

        // Resolve group lazily — only create a default group on first new-project
        // creation, so syncs with no new items don't leave empty groups behind.
        let groupId: string | null = boardSource.targetGroupId;

        // Batch-fetch existing projects scoped to this board (multi-board fan-out:
        // the same jiraKey can exist on multiple boards, so we must NOT key purely
        // by jiraProjectKey).
        const existingProjects = await this.prisma.project.findMany({
          where: { jiraProjectKey, boardId: boardSource.boardId },
          select: { id: true, jiraKey: true, jiraProjectKey: true, status: true, statusId: true, jiraSyncedFields: true, ownerOverridden: true, jiraDeletedAt: true, jiraAnalyticsPurgedAt: true },
        });
        const projectByJiraKey = new Map(existingProjects.map((p) => [p.jiraKey, p]));

        // A fetch that came back empty is not evidence of anything.
        //
        // Jira has answered 200 with zero issues for a project it was still
        // serving normally minutes earlier (an outage on 2026-08-19 did it for
        // four hours). Every conclusion below reads "absent from the payload" as
        // "gone from Jira", so an empty payload indicts the whole board at once —
        // and the per-key probe that is supposed to catch that cannot, because
        // Jira answers 404 both for a deleted issue and for one the caller has
        // momentarily lost sight of. Withhold judgement instead: the rows keep
        // the state they have, and the next run that brings back a payload draws
        // the conclusions.
        if (payloadKeys.size === 0 && existingProjects.length > 0) {
          console.warn(
            `[JiraPromote] Board ${boardSource.boardId} (${jiraProjectKey}): the fetch returned no ` +
              `keys for this project while the board holds ${existingProjects.length} synced row(s) — ` +
              `leaving them untouched rather than treating an empty payload as deletion.`,
          );
          // Purges an EARLIER run already established still have to land: that
          // deletion was confirmed against a payload, and only the ClickHouse
          // half of it is outstanding.
          if (this.isInDeletionScope(jiraProjectKey, ps.jiraInstanceId, options)) {
            for (const row of existingProjects) {
              if (row.jiraKey && row.jiraDeletedAt && !row.jiraAnalyticsPurgedAt) {
                purgeTargets.push({ id: row.id, jiraKey: row.jiraKey });
              }
            }
          }
          continue;
        }

        const jiraExclusions = await this.prisma.boardSyncExclusion.findMany({
          where: { boardId: boardSource.boardId, source: 'JIRA' },
          select: { externalId: true },
        });
        const excludedJiraKeys = new Set(jiraExclusions.map((e) => e.externalId));

        // Filter in-memory payload (was previously a Postgres read against the
        // now-dropped jira_epics / jira_issues tables — those tables vanished in
        // 20260603120000_drop_legacy_phase3_tables).
        const epicRows = allowedTypes.includes('Epic')
          ? payload.epics.filter((e) => e.projectKey === jiraProjectKey)
          : [];

        const nonEpicTypes = allowedTypes.filter((t) => t !== 'Epic');
        const issueRows =
          nonEpicTypes.length > 0
            ? payload.issues.filter(
                (i) => i.projectKey === jiraProjectKey && nonEpicTypes.includes(i.type),
              )
            : [];

        // Merge into a single typed array
        type RawItem = {
          key: string;
          summary: string;
          description: string | null;
          status: string;
          assignee: string | null;
          type: string;
        };
        const allItems: RawItem[] = [
          ...epicRows.map((e) => ({
            key: e.key,
            summary: e.summary,
            description: e.description ?? null,
            status: e.status,
            assignee: e.assignee ?? null,
            type: 'Epic',
          })),
          ...issueRows.map((i) => ({
            key: i.key,
            summary: i.summary,
            description: i.description ?? null,
            status: i.status,
            assignee: i.assignee ?? null,
            type: i.type,
          })),
        ];

        const notExcluded =
          excludedJiraKeys.size > 0
            ? allItems.filter((r) => !excludedJiraKeys.has(r.key))
            : allItems;

        // The board source's JQL filter, applied as an intersection. Anything it
        // drops is left out of `seenKeys`, so a row that stopped matching gets
        // flagged `jiraRemovedFromSource` by the mark-removed pass below — the
        // same treatment as an issue deleted in Jira.
        const items =
          allowedKeys === null ? notExcluded : notExcluded.filter((r) => allowedKeys.has(r.key));

        const seenKeys: string[] = [];

        for (const row of items) {
          const jiraKey = row.key;
          seenKeys.push(jiraKey);

          const existing = projectByJiraKey.get(jiraKey) ?? null;

          const statusId = await this.resolveStatusId(
            row.status,
            statusMapping,
            boardSource.boardId,
            statusCache,
          );
          const legacyStatus = this.toLegacyEnum(statusId, statusCache);

          if (!existing) {
            if (groupId === null) {
              groupId = await ensureDefaultGroup(this.prisma, boardSource.boardId, jiraProjectKey);
            }
            const newProject = await this.prisma.project.create({
              data: {
                name: row.summary,
                description: row.description,
                status: legacyStatus as never,
                statusId,
                owner: row.assignee ?? '',
                assignee: row.assignee ?? '',
                boardId: boardSource.boardId,
                groupId,
                jiraKey,
                jiraProjectKey,
                jiraType: row.type,
                jiraSyncedFields: defaultSyncedFields,
                jiraRemovedFromSource: false,
              },
            });
            created++;

            await this.prisma.projectStatusChange.create({
              data: {
                projectId: newProject.id,
                fromStatus: null,
                toStatus: this.labelFromCache(statusId, statusCache) ?? legacyStatus,
                changedBy: 'sync:jira',
              },
            });

            await this.applyFieldMappings(fieldMappings, row as Record<string, unknown>, newProject.id);
          } else {
            const syncedFields = (existing.jiraSyncedFields ?? defaultSyncedFields) as string[];
            const updateData: Record<string, unknown> = {
              jiraRemovedFromSource: false,
            };

            if (syncedFields.includes('name')) {
              updateData.name = row.summary;
            }
            if (syncedFields.includes('status')) {
              updateData.statusId = statusId;
              updateData.status = legacyStatus;
            }
            if (syncedFields.includes('owner')) {
              // Always refresh the synced Assignee; only overwrite the editable
              // Owner while it still follows the assignee (not manually set).
              updateData.assignee = row.assignee ?? '';
              if (!existing.ownerOverridden) {
                updateData.owner = row.assignee ?? '';
              }
            }
            if (syncedFields.includes('description')) {
              updateData.description = row.description;
            }

            await this.prisma.project.update({
              where: { id: existing.id },
              data: updateData,
            });
            updated++;

            if (updateData.status && updateData.status !== existing.status) {
              await this.prisma.projectStatusChange.create({
                data: {
                  projectId: existing.id,
                  fromStatus: this.labelFromCache(existing.statusId as string, statusCache) ?? (existing.status as string),
                  toStatus: this.labelFromCache(statusId, statusCache) ?? legacyStatus,
                  changedBy: 'sync:jira',
                },
              });
            }

            await this.applyFieldMappings(fieldMappings, row as Record<string, unknown>, existing.id);
          }
        }

        // Mark removed: projects on THIS board for THIS project key whose type is
        // in the board's allowedTypes but whose jiraKey is no longer in Jira.
        const markResult = await this.prisma.project.updateMany({
          where: {
            boardId: boardSource.boardId,
            jiraProjectKey,
            jiraType: { in: allowedTypes },
            jiraKey: { notIn: seenKeys },
          },
          data: { jiraRemovedFromSource: true },
        });
        markedRemoved += markResult.count;

        if (!this.isInDeletionScope(jiraProjectKey, ps.jiraInstanceId, options)) continue;

        // Deleted by an earlier run whose purge never landed. Collected before
        // any new detection so a ClickHouse outage cannot strand them, and
        // deliberately outside the candidate cap and the probe — the deletion is
        // already established, only the purge is outstanding.
        for (const row of existingProjects) {
          if (row.jiraKey && row.jiraDeletedAt && !row.jiraAnalyticsPurgedAt) {
            purgeTargets.push({ id: row.id, jiraKey: row.jiraKey });
          }
        }

        const deletions = await this.markDeletedIssues({
          boardId: boardSource.boardId,
          jiraProjectKey,
          existingProjects,
          payloadKeys,
          statusCache,
          options,
        });
        markedDeleted += deletions.confirmed.length;
        purgeTargets.push(...deletions.confirmed);
        if (deletions.withheld) withheldMassDeletions.push(deletions.withheld);
      }
    }

    await this.purgeAnalyticsFor(purgeTargets, options);

    return { created, updated, markedRemoved, markedDeleted, withheldMassDeletions };
  }

  /**
   * Drop the confirmed-deleted issues' analytics rows, then record that it
   * happened. The stamp is what stops the next sync retrying, so it is written
   * only after the purge resolves — a failure here leaves the rows on the retry
   * list and costs nothing else: the board is already black either way.
   */
  private async purgeAnalyticsFor(
    targets: readonly PurgeTarget[],
    options: PromoteOptions,
  ): Promise<void> {
    if (targets.length === 0 || !options.purgeAnalytics) return;

    const issueKeys = [...new Set(targets.map((t) => t.jiraKey))];
    try {
      await options.purgeAnalytics(issueKeys);
      await this.prisma.project.updateMany({
        where: { id: { in: targets.map((t) => t.id) } },
        data: { jiraAnalyticsPurgedAt: new Date() },
      });
    } catch (err) {
      console.error(
        `[JiraPromote] Analytics purge failed for ${issueKeys.length} deleted issue(s) ` +
          `(${issueKeys.join(', ')}) — will retry on the next sync:`,
        err,
      );
    }
  }

  /**
   * Whether this project sync is one the current run may draw conclusions about.
   * promoteAll walks EVERY JiraProjectSync row, but a run fetches only the keys
   * of one connection — everything else is absent for reasons that have nothing
   * to do with deletion.
   */
  private isInDeletionScope(
    jiraProjectKey: string,
    jiraInstanceId: string,
    options: PromoteOptions,
  ): boolean {
    if (options.syncedProjectKeys && !options.syncedProjectKeys.includes(jiraProjectKey)) return false;
    if (options.instanceId && options.instanceId !== jiraInstanceId) return false;
    return true;
  }

  /** Every key Jira returned for a project key, before any board-level filtering. */
  private payloadKeysFor(payload: PromotePayload, jiraProjectKey: string): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const item of payload.epics) {
      if (item.projectKey === jiraProjectKey) keys.add(item.key);
    }
    for (const item of payload.issues) {
      if (item.projectKey === jiraProjectKey) keys.add(item.key);
    }
    return keys;
  }

  /**
   * Turn rows whose Jira issue Jira itself no longer resolves black, and return
   * their keys.
   *
   * A row is only a CANDIDATE when its key is missing from the whole fetched
   * payload for its project key — not merely from the filtered set the board was
   * allowed to promote, which a JQL filter or an issue-type change also empties.
   * Each candidate is then confirmed one key at a time; anything short of a
   * definite 'deleted' leaves the row exactly as it was.
   */
  private async markDeletedIssues(input: {
    boardId: string;
    jiraProjectKey: string;
    existingProjects: Array<{
      id: string;
      jiraKey: string | null;
      status: unknown;
      statusId: string | null;
      jiraDeletedAt: Date | null;
    }>;
    payloadKeys: ReadonlySet<string>;
    statusCache: Map<string, CachedBoardStatus>;
    options: PromoteOptions;
  }): Promise<{ confirmed: PurgeTarget[]; withheld: WithheldMassDeletion | null }> {
    const { boardId, jiraProjectKey, existingProjects, payloadKeys, statusCache, options } = input;
    const { verifyIssue } = options;

    if (!verifyIssue) return { confirmed: [], withheld: null };

    const candidates = existingProjects
      .filter((p) => p.jiraKey !== null && p.jiraDeletedAt === null && !payloadKeys.has(p.jiraKey))
      // Key order so a backlog drains the same way every run instead of
      // re-probing whatever Postgres happened to return first.
      .sort((a, b) => (a.jiraKey as string).localeCompare(b.jiraKey as string));
    if (candidates.length === 0) return { confirmed: [], withheld: null };

    const probing = candidates.slice(0, MAX_DELETION_PROBES_PER_RUN);
    if (candidates.length > probing.length) {
      console.log(
        `[JiraPromote] Board ${boardId} (${jiraProjectKey}): probing ${probing.length} of ` +
          `${candidates.length} rows missing from Jira — ${candidates.length - probing.length} more next run.`,
      );
    }

    // Probed first, written second: the cap below judges the whole run's verdict,
    // so nothing may be written while the verdict is still being assembled.
    const gone: typeof probing = [];
    for (const candidate of probing) {
      if ((await verifyIssue(candidate.jiraKey as string)) === 'deleted') gone.push(candidate);
    }
    if (gone.length === 0) return { confirmed: [], withheld: null };

    const syncedRows = existingProjects.filter((p) => p.jiraKey !== null).length;
    if (
      !options.allowMassDeletion &&
      gone.length >= MASS_DELETION_FLOOR &&
      gone.length > syncedRows * MASS_DELETION_SHARE
    ) {
      console.warn(
        `[JiraPromote] Board ${boardId} (${jiraProjectKey}): withholding ${gone.length} confirmed ` +
          `deletion(s) out of ${syncedRows} synced row(s) — one run erasing most of a board is far ` +
          `likelier to be a Jira fault than a real purge, so nothing was written. If this really is a ` +
          `bulk deletion, re-run the sync with JIRA_ALLOW_MASS_DELETION=1.`,
      );
      return {
        confirmed: [],
        withheld: { boardId, jiraProjectKey, confirmed: gone.length, of: syncedRows },
      };
    }

    const confirmed: PurgeTarget[] = [];
    for (const candidate of gone) {
      const jiraKey = candidate.jiraKey as string;
      const deletedStatusId = await this.ensureDeletedStatus(boardId, statusCache);
      await this.prisma.project.update({
        where: { id: candidate.id },
        data: {
          // The legacy `status` enum is deliberately untouched: it has no
          // "Deleted" member, and rewriting it would move the row in every
          // consumer that still reads the enum.
          statusId: deletedStatusId,
          jiraDeletedAt: new Date(),
          jiraRemovedFromSource: true,
        },
      });
      await this.prisma.projectStatusChange.create({
        data: {
          projectId: candidate.id,
          fromStatus:
            this.labelFromCache(candidate.statusId ?? '', statusCache) ?? (candidate.status as string),
          toStatus: DELETED_STATUS_LABEL,
          changedBy: 'sync:jira',
        },
      });
      console.log(`[JiraPromote] ${jiraKey} no longer exists in Jira — row marked Deleted`);
      confirmed.push({ id: candidate.id, jiraKey });
    }
    return { confirmed, withheld: null };
  }

  /**
   * The board's "Deleted" status, created black on first use. Reuses whatever a
   * board already has under that label rather than fighting a user's own colour
   * choice, and never draws from STATUS_COLORS — black is reserved for this.
   */
  private async ensureDeletedStatus(
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
  ): Promise<string> {
    const cached = cache.get(DELETED_STATUS_LABEL.toLowerCase());
    if (cached) return cached.id;
    // Delegated rather than hand-rolled, so it inherits the P2002 handling that
    // matters when two syncs first detect a deletion on one board at once.
    return this.upsertBoardStatus(DELETED_STATUS_LABEL, boardId, cache, DELETED_STATUS_COLOR);
  }

  /**
   * Resolve a Jira status string to a board_status ID.
   *
   * Resolution order:
   * 1. Explicit mapping value (UUID → direct; legacy enum → label lookup)
   * 2. Case-insensitive label match on the board
   * 3. Upsert a new board status with the Jira status name
   */
  private async resolveStatusId(
    jiraStatus: string,
    statusMap: Record<string, string>,
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
  ): Promise<string> {
    const mapped = statusMap[jiraStatus];
    if (mapped) {
      // Already a board status UUID — but only use it if it belongs to this board
      if (UUID_RE.test(mapped)) {
        for (const s of cache.values()) {
          if (s.id === mapped) return mapped;
        }
        // UUID not on this board — fall through to other resolution methods
      }

      // Legacy enum value (e.g. "NOT_STARTED") → resolve label
      const label = LEGACY_STATUS_LABELS[mapped];
      if (label) {
        const cached = cache.get(label.toLowerCase());
        if (cached) return cached.id;
      }

      // Mapped value might be a label itself
      const byLabel = cache.get(mapped.toLowerCase());
      if (byLabel) return byLabel.id;
    }

    // Fallback: case-insensitive match on Jira status name
    const byName = cache.get(jiraStatus.toLowerCase());
    if (byName) return byName.id;

    // No match — upsert a new board status
    return this.upsertBoardStatus(jiraStatus, boardId, cache);
  }

  /**
   * Create a new board status for an unknown Jira status, handling race
   * conditions. `fixedColor` names the colour outright instead of drawing an
   * unused one from the palette — the Deleted status is always black.
   */
  private async upsertBoardStatus(
    label: string,
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
    fixedColor?: string,
  ): Promise<string> {
    try {
      const color = fixedColor ?? this.pickUnusedColor(cache);
      const maxOrder = await this.prisma.boardStatus.aggregate({
        where: { boardId },
        _max: { order: true },
      });

      const created = await this.prisma.boardStatus.create({
        data: {
          boardId,
          label,
          color,
          order: (maxOrder._max.order ?? -1) + 1,
        },
      });

      cache.set(label.toLowerCase(), { id: created.id, label: created.label, color });
      return created.id;
    } catch (err: unknown) {
      // Unique constraint violation (P2002) — concurrent sync created it first
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        const existing = await this.prisma.boardStatus.findFirst({
          where: { boardId, label: { equals: label, mode: 'insensitive' } },
        });
        if (existing) {
          cache.set(label.toLowerCase(), { id: existing.id, label: existing.label, color: '' });
          return existing.id;
        }
      }
      throw err;
    }
  }

  /** Pick a random color not yet used by statuses on this board (uses in-memory cache). */
  private pickUnusedColor(cache: Map<string, CachedBoardStatus>): string {
    const usedSet = new Set<string>();
    for (const s of cache.values()) usedSet.add(s.color);
    const available = STATUS_COLORS.filter((c) => !usedSet.has(c));
    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)]!;
    }
    return STATUS_COLORS[Math.floor(Math.random() * STATUS_COLORS.length)]!;
  }

  /** Load all board statuses into a lowercase-label-keyed cache (includes color for pickUnusedColor). */
  private async loadStatusCache(boardId: string): Promise<Map<string, CachedBoardStatus>> {
    const statuses = await this.prisma.boardStatus.findMany({
      where: { boardId },
      select: { id: true, label: true, color: true },
    });
    const cache = new Map<string, CachedBoardStatus>();
    for (const s of statuses) {
      cache.set(s.label.toLowerCase(), { id: s.id, label: s.label, color: s.color });
    }
    return cache;
  }

  /** Map a board status ID back to the legacy ProjectStatus enum value. */
  private toLegacyEnum(statusId: string, cache: Map<string, CachedBoardStatus>): string {
    for (const s of cache.values()) {
      if (s.id === statusId) {
        return LABEL_TO_ENUM[s.label.toLowerCase()] ?? 'NOT_STARTED';
      }
    }
    return 'NOT_STARTED';
  }

  /** Find the human-readable label for a board status ID by scanning the cache. */
  private labelFromCache(statusId: string, cache: Map<string, CachedBoardStatus>): string | null {
    for (const s of cache.values()) {
      if (s.id === statusId) return s.label;
    }
    return null;
  }

  private async applyFieldMappings(
    fieldMappings: Record<string, string>,
    row: Record<string, unknown>,
    projectId: string
  ): Promise<void> {
    for (const [jiraField, columnId] of Object.entries(fieldMappings)) {
      const value = row[jiraField];
      if (value === undefined || value === null) continue;

      const stringValue = String(value);
      await this.prisma.projectFieldValue.upsert({
        where: { projectId_columnId: { projectId, columnId } },
        update: { value: stringValue },
        create: { projectId, columnId, value: stringValue },
      });
    }
  }
}
