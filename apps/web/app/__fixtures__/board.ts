import { DEFAULT_SIZE_DURATIONS, type Group, type OrgEmployeeDto, type Project, type RoadmapConfigPayload } from '@deckgauge/shared';
import type { ProjectWithFields } from '../utils/optimistic-mutators';

/**
 * Complete `Project` / `Group` fixtures for apps/web tests.
 *
 * These exist because the board test fixtures were hand-written object literals
 * cast with `as Project` / `as unknown as Project`. Two things followed from
 * that, and both were invisible for as long as apps/web was never typechecked:
 *
 * 1. The literals were INCOMPLETE — no `assignee`, `overriddenFields`,
 *    `preOverrideValues`, `startDate`, `costClassification`, and so on. The cast
 *    is what hid it, and stricter `@types/react` 19 prop checking is what
 *    surfaced it.
 * 2. Several literals were STALE: they set `jiraIssueKey`, which is not a field
 *    on `ProjectSchema` at all (the real one is `jiraKey`). A cast will happily
 *    accept a misspelled field forever.
 *
 * Build fixtures from these factories instead of casting. Every field carries a
 * realistic default, so a test names only what it is actually asserting on —
 * which is also what keeps a schema addition from breaking every board suite at
 * once.
 */
export function makeProject(over: Partial<ProjectWithFields> = {}): ProjectWithFields {
  return {
    id: 'p1',
    name: 'Project 1',
    owner: 'x',
    assignee: '',
    overriddenFields: [],
    preOverrideValues: null,
    status: 'NOT_STARTED',
    description: null,
    boardId: 'b1',
    groupId: null,
    ownerId: null,
    statusId: null,
    order: null,
    jiraKey: null,
    githubIssueId: null,
    githubRepoFullName: null,
    adoWorkItemId: null,
    adoProject: null,
    startDate: null,
    endDate: null,
    dueDate: null,
    durationCode: null,
    costClassification: null,
    onboardedEmployeeId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

export function makeGroup(
  over: Partial<Group & { projects: ProjectWithFields[] }> = {},
): Group & { projects: ProjectWithFields[] } {
  return {
    id: 'g1',
    name: 'Group 1',
    position: 0,
    color: '#6C6CFF',
    boardId: 'b1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    projects: [],
    ...over,
  };
}

/** Narrower alias for suites that only need the bare `Project` contract. */
export const makeBareProject = (over: Partial<Project> = {}): Project => makeProject(over);

/**
 * A `RoadmapConfigPayload`, for the `ganttConfig` that `RoadmapDetail` requires.
 *
 * Three roadmap-entity suites built a `RoadmapDetail` without it. Reuses the
 * real `DEFAULT_SIZE_DURATIONS` rather than inventing a size table, so a change
 * to the size scale does not silently diverge from what the product uses.
 */
export function makeGanttConfig(
  over: Partial<RoadmapConfigPayload> = {},
): RoadmapConfigPayload {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    boardViewId: '00000000-0000-4000-8000-000000000002',
    startDate: '2026-01-01',
    visibleQuarters: 4,
    sizeDurations: DEFAULT_SIZE_DURATIONS,
    defaultSizeWeeks: 2,
    hiddenGroupIds: [],
    ...over,
  };
}

/**
 * A complete `OrgEmployeeDto`.
 *
 * The org-tree suites each hand-rolled this literal, and every one of them
 * stopped at `aliases` — so `ranking`, `employeeId`, `businessTitle`,
 * `hireDate`, `location`, `employeeType`, `timeType`, `phone`, `workAddress`
 * and `isDeparted` were all absent. One of those suites additionally produced
 * TS2719 ("two different types with this name exist, but they are unrelated"),
 * which is what a structurally-identical-but-separately-declared literal looks
 * like from the checker's side.
 */
export function makeOrgEmployee(over: Partial<OrgEmployeeDto> = {}): OrgEmployeeDto {
  return {
    id: 'e1',
    externalId: null,
    name: 'Employee',
    role: null,
    email: null,
    managerId: null,
    isVacancy: false,
    matched: false,
    isActive: true,
    lastContributionAt: null,
    hasAssignment: false,
    stats: null,
    ranking: null,
    aliases: [],
    employeeId: null,
    businessTitle: null,
    hireDate: null,
    location: null,
    employeeType: null,
    timeType: null,
    phone: null,
    workAddress: null,
    isDeparted: false,
    ...over,
  };
}
