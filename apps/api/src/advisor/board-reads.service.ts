import { Prisma, type PrismaClient } from '@deckgauge/db';
import {
  DESCRIPTION_PREVIEW_MAX,
  type AdvisorBoardRowDto,
  type AdvisorBoardRowsDto,
  type AdvisorBoardStructureDto,
  type AdvisorExcludedRowDto,
  type ListBoardRowsInput,
} from '@deckgauge/shared';

/**
 * Board *content* reads for the Advisor.
 *
 * Deliberately separate from `ClickhouseIntelligenceService`: that answers
 * analytics questions from ClickHouse over a `BoardScope`, this answers "what
 * is actually on this board" from Postgres over a board id. Keeping them apart
 * is what stops a content read from silently inheriting the analytics scope's
 * `useForIntelligence` filtering, which would drop rows from sources the board
 * excludes from analytics but still displays.
 *
 * Every method takes an already-authorized `boardId` and filters on it. There
 * is no method that reads across boards.
 */
export class BoardReadsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listRows(boardId: string, input: ListBoardRowsInput): Promise<AdvisorBoardRowsDto> {
    const where = await this.buildWhere(boardId, input);

    // Count and page in parallel: the count is what lets the model tell a first
    // page from a complete answer, so it is not optional and not deferred.
    const [totalMatching, rows] = await Promise.all([
      this.prisma.project.count({ where }),
      this.prisma.project.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: input.limit + 1, // one extra row: its presence is the "there is more" signal
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          name: true,
          groupId: true,
          status: true,
          statusId: true,
          owner: true,
          assignee: true,
          description: true,
          jiraKey: true,
          group: { select: { name: true } },
          boardStatus: { select: { label: true } },
          fieldValues: { select: { columnId: true, value: true } },
        },
      }),
    ]);

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;

    return {
      rows: page.map((row) => this.toDto(row)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalMatching,
    };
  }

  async getStructure(boardId: string): Promise<AdvisorBoardStructureDto> {
    const [groups, statuses, columns, jira, github, ado] = await Promise.all([
      this.prisma.group.findMany({
        where: { boardId },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, position: true },
      }),
      this.prisma.boardStatus.findMany({
        where: { boardId },
        orderBy: { order: 'asc' },
        select: { id: true, label: true, order: true, isDefault: true },
      }),
      this.prisma.boardColumn.findMany({
        where: { boardId },
        orderBy: { order: 'asc' },
        select: { id: true, name: true, type: true, order: true },
      }),
      this.prisma.boardJiraSource.findMany({
        where: { boardId },
        select: { defaultSyncedFields: true },
      }),
      this.prisma.boardGitHubSource.findMany({
        where: { boardId },
        select: { defaultSyncedFields: true },
      }),
      this.prisma.boardAdoSource.findMany({
        where: { boardId },
        select: { defaultSyncedFields: true },
      }),
    ]);

    const syncOwnedFields: AdvisorBoardStructureDto['syncOwnedFields'] = [];
    const add = (source: 'JIRA' | 'GITHUB' | 'ADO', raw: unknown[]) => {
      // Union across sources of the same kind: two jira sources on one board
      // can disagree, and a field owned by either is owned as far as an edit
      // to it is concerned.
      const fields = new Set<string>();
      for (const value of raw) {
        // Jira stores this as Json (which can hold a non-array), GitHub/ADO as String[] — normalise both.
        if (Array.isArray(value)) for (const f of value) if (typeof f === 'string') fields.add(f);
      }
      if (fields.size > 0) syncOwnedFields.push({ source, fields: [...fields] });
    };
    add('JIRA', jira.map((s) => s.defaultSyncedFields));
    add('GITHUB', github.map((s) => s.defaultSyncedFields));
    add('ADO', ado.map((s) => s.defaultSyncedFields));

    return { groups, statuses, columns: columns.map((c) => ({ ...c, type: String(c.type) })), syncOwnedFields };
  }

  async listExcluded(boardId: string): Promise<AdvisorExcludedRowDto[]> {
    const rows = await this.prisma.boardSyncExclusion.findMany({
      where: { boardId },
      orderBy: { excludedAt: 'desc' },
      select: {
        id: true,
        source: true,
        externalId: true,
        excludedAt: true,
        excludedBy: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      source: String(r.source),
      externalId: r.externalId,
      excludedAt: r.excludedAt.toISOString(),
      excludedBy: r.excludedBy,
    }));
  }

  private async buildWhere(
    boardId: string,
    input: ListBoardRowsInput,
  ): Promise<Prisma.ProjectWhereInput> {
    const describedIds = await this.idsByDescriptionPresence(boardId, input.hasDescription);

    return {
      boardId,
      ...(describedIds ? { id: { in: describedIds } } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.statusId ? { statusId: input.statusId } : {}),
      ...(input.search ? { name: { contains: input.search, mode: 'insensitive' } } : {}),
    };
  }

  /**
   * Ids on this board whose description is present (or absent), or `null` when
   * the caller did not filter on it.
   *
   * Raw SQL, and its own round trip, for one reason: "has a description" is not
   * `{ not: null }`. A row saved with an empty body, and one imported with a
   * whitespace-only body, both read as *described* under that predicate — which
   * is exactly the question this tool exists to answer, answered wrongly. Prisma
   * has no `btrim` filter and no regex operator on Postgres, so the trim has to
   * happen in SQL. It costs a query only when the filter is actually used;
   * `buildWhere` returns null here for every other call.
   */
  private async idsByDescriptionPresence(
    boardId: string,
    hasDescription: boolean | undefined,
  ): Promise<string[] | null> {
    if (hasDescription === undefined) return null;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM projects
      WHERE board_id = ${boardId}
        AND btrim(coalesce(description, '')) ${
          hasDescription ? Prisma.sql`<> ''` : Prisma.sql`= ''`
        }
    `;
    return rows.map((r) => r.id);
  }

  private toDto(row: {
    id: string;
    name: string;
    groupId: string | null;
    status: string;
    statusId: string | null;
    owner: string;
    assignee: string;
    description: string | null;
    jiraKey: string | null;
    group: { name: string } | null;
    boardStatus: { label: string } | null;
    fieldValues: { columnId: string; value: string }[];
  }): AdvisorBoardRowDto {
    const full = row.description;
    const truncated = !!full && full.length > DESCRIPTION_PREVIEW_MAX;
    return {
      id: row.id,
      name: row.name,
      groupId: row.groupId,
      groupName: row.group?.name ?? null,
      status: row.status,
      statusId: row.statusId,
      statusLabel: row.boardStatus?.label ?? null,
      owner: row.owner,
      assignee: row.assignee,
      description: truncated ? full!.slice(0, DESCRIPTION_PREVIEW_MAX) : full,
      descriptionTruncated: truncated,
      jiraKey: row.jiraKey,
      columns: Object.fromEntries(row.fieldValues.map((v) => [v.columnId, v.value])),
    };
  }
}
