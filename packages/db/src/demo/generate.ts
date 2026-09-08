import { demoId } from './ids.js';
import { intBetween, mulberry32, pick } from './random.js';
import { CATALOG_BOARDS, CATALOG_PEOPLE, CATALOG_STATUSES } from './catalog.js';

/** Fixed so two installs on the same day produce identical data. */

/**
 * A deterministic, sparse epic link for a demo issue.
 *
 * Keyed off the issue key so a re-seed produces the same links — a demo whose
 * roadmap coverage moves between runs is worse than one with none. Epics do not
 * link to themselves, and a board with no epics yields none.
 */
function epicKeyFor(
  issueKey: string,
  issueType: string,
  boardEpicKeys: string[],
): string | null {
  if (issueType === 'Epic' || boardEpicKeys.length === 0) return null;
  let hash = 0;
  for (const ch of issueKey) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  if (hash % 5 !== 0) return null;
  return boardEpicKeys[hash % boardEpicKeys.length]!;
}

export const DEFAULT_SEED = 20260905;

/** How far back the demo's history reaches. Six months. */
export const HISTORY_DAYS = 183;

const DAY_MS = 86_400_000;

/**
 * ClickHouse `DateTime` wants `YYYY-MM-DD hh:mm:ss`. A JS ISO string ends in
 * `.000Z` and is rejected on insert, which surfaces as a type error naming the
 * column rather than the format — so the conversion lives in one place.
 */
function chTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Sprint length. Two weeks over `HISTORY_DAYS` gives 13 sprints per board, plus
 * a 14th one-day bucket where 183 = 13x14 + 1 leaves a remainder — comfortably
 * above the Velocity widget's 8-sprint default window, and `stddevPop` over
 * fewer than two sprints is 0, which draws a confidence band of zero width.
 */
const SPRINT_DAYS = 14;

/**
 * Width of the zero-padded sprint number. Two digits covers the 14 sprints
 * `HISTORY_DAYS` yields.
 *
 * The padding is LOAD-BEARING, not cosmetic. Both consumers order by
 * `sprint_name` as a STRING and then take the top N:
 * `velocity-with-confidence.ts` does `ORDER BY sprint_name DESC LIMIT
 * {sprints}` (8 by default on the demo dashboard) and
 * `iteration-planning-accuracy.ts` the same with 6. Unpadded, byte-wise DESC
 * over `Sprint 1 .. Sprint 14` runs 9, 8, 7, 6, 5, 4, 3, 2, 14, 13, ... — so
 * the top 8 is sprints 2-9, the OLDEST eight, and the active sprint never
 * appears at all. That is a worse failure than the empty widget this seeding
 * fixes, because a chart of the wrong four months looks entirely correct.
 * Padded, lexicographic order and numeric order coincide.
 *
 * Derived from the window rather than pinned at 2, so the invariant survives a
 * change to `HISTORY_DAYS` or `SPRINT_DAYS`. The property test asserts that
 * string order equals sprint order, but it can only see the sprint counts the
 * current window actually produces — it would not catch a width that became
 * too narrow at 100+ sprints.
 */
const SPRINT_PAD = String(Math.floor(HISTORY_DAYS / SPRINT_DAYS) + 1).length;

/**
 * Which sprint a date falls in, numbered forward from the start of the history
 * window so sprint 1 is the oldest and the number rises with time the way a
 * real board's does.
 *
 * Purely a function of the date — it draws nothing from the PRNG, which is why
 * adding sprints left every other generated field byte-identical.
 */
function sprintIndexFor(date: Date, now: Date): number {
  const windowStart = now.getTime() - HISTORY_DAYS * DAY_MS;
  // Dates are clamped into the window by their callers, but floor() on a
  // negative delta would still yield sprint 0 or below; keep the floor at 1.
  return Math.max(1, Math.floor((date.getTime() - windowStart) / (SPRINT_DAYS * DAY_MS)) + 1);
}

/**
 * The sprint an issue created at `created` belongs to, for `board`.
 *
 * `latestIndex` is the board's highest sprint that actually has issues, and it
 * is the one marked `active`; every earlier one is `closed`. Deriving "active"
 * that way rather than from the sprint CONTAINING `now` is what makes it
 * seed-independent — at DEFAULT_SEED no project on the Platform board happened
 * to start inside the final two-week box, so that board had no active sprint at
 * all while the Mobile board had one.
 */
function sprintFor(
  created: Date,
  board: { key: string; name: string },
  now: Date,
  latestIndex: number,
): { id: string; name: string; state: 'active' | 'closed' } {
  const index = sprintIndexFor(created, now);
  return {
    id: `${board.key}-S${String(index).padStart(SPRINT_PAD, '0')}`,
    name: `${board.name} Sprint ${String(index).padStart(SPRINT_PAD, '0')}`,
    state: index === latestIndex ? 'active' : 'closed',
  };
}

export interface DemoProject {
  id: string;
  name: string;
  owner: string;
  assignee: string;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'AT_RISK' | 'BLOCKED' | 'DONE';
  groupId: string;
  statusId: string;
  ownerId: string;
  order: number;
  jiraKey: string;
  jiraProjectKey: string;
  jiraType: string;
  /** CAPEX / OPEX, or null for the deliberate Unclassified slice. */
  costClassification: 'CAPEX' | 'OPEX' | null;
  startDate: Date;
  endDate: Date;
  dueDate: Date;
  fieldValues: { columnId: string; value: string }[];
}

export interface DemoBoard {
  id: string;
  key: string;
  name: string;
  jiraProjectKey: string;
  repoFullName: string;
  groups: { id: string; name: string; position: number }[];
  statuses: { id: string; label: string; color: string; order: number; isDefault: boolean }[];
  owners: { id: string; name: string; color: string; order: number }[];
  columns: { id: string; name: string; type: 'TEXT' | 'NUMBER' | 'DATE'; order: number }[];
  projects: DemoProject[];
}

export interface DemoEmployee {
  id: string;
  key: string;
  name: string;
  email: string;
  /**
   * The catalog's GitHub handle (`rmensah`), NOT `email.split('@')[0]`
   * (`rita.mensah`). Carried onto the dataset so `generateClickHouse` has one
   * place to read a login from — deriving it from the email in a second place
   * is how `CatalogPerson.login` came to be written and never read.
   */
  login: string;
  role: string;
  /**
   * A stable per-person multiplier on how long this engineer's pull requests
   * wait for their first review. Derived from the person's catalog index, so
   * the same person is consistently faster or slower across every run and
   * every chart — which is what "review latency varies by author" has to mean
   * to be visible in a per-engineer view. Spans 0.5x to 2x.
   */
  reviewLatencyFactor: number;
  managerId: string | null;
  position: number;
  location: string;
  hireDate: Date;
  isActive: boolean;
}

/** Filled in by the ClickHouse half of the generator (Task 5). */
export interface DemoClickHouse {
  jiraIssues: Record<string, unknown>[];
  jiraTransitions: Record<string, unknown>[];
  jiraWorklogs: Record<string, unknown>[];
  githubPullRequests: Record<string, unknown>[];
  githubCommits: Record<string, unknown>[];
  githubReviews: Record<string, unknown>[];
  githubDeployments: Record<string, unknown>[];
  boardItemClassification: Record<string, unknown>[];
}

export interface DemoDataset {
  now: Date;
  boards: DemoBoard[];
  employees: DemoEmployee[];
  clickhouse: DemoClickHouse;
}

const OWNER_COLORS = ['#5B8DEF', '#27AE60', '#F2994A', '#BB6BD9', '#EB5757', '#2D9CDB'];
const ISSUE_TYPES = ['Story', 'Task', 'Bug'];
const PROJECTS_PER_BOARD = 120;

/**
 * Every Nth project on a board is an Epic. `initiative-risk-radar.ts` selects
 * `issue_type = 'Epic' AND due_date IS NOT NULL`, and its only other leg reads
 * `cockpit.github_milestones`, which the seeder does not write — so with
 * Story/Task/Bug alone that widget had nothing to draw on a demo install.
 *
 * 12 gives ten epics per 120-project board: enough for the radar to be
 * inhabited, few enough that the board still reads as ordinary delivery work
 * rather than a wall of epics.
 *
 * It is not free elsewhere, and the trade is deliberate.
 * `investment-allocation.ts` groups by the raw canonical `type`, so the demo's
 * investment mix now carries an ~8% 'Epic' slice alongside Story/Task/Bug.
 * That is what a real board with epics looks like; the alternative is a widget
 * that renders nothing at all.
 */
const EPIC_EVERY = 12;

/**
 * `drawn` is evaluated by the caller BEFORE this returns, which is the point:
 * the PRNG draw happens unconditionally and in its original position, so
 * turning some projects into epics changes the chosen TYPE without shifting
 * the stream underneath every id and field that follows.
 */
function epicOr(drawn: string, index: number): string {
  return index % EPIC_EVERY === 0 ? 'Epic' : drawn;
}

/**
 * Leave every Nth project unclassified. The CapEx/OpEx report has three
 * buckets and renders hours for each, so a demo where Unclassified is empty
 * never shows that bucket working — just as one where it holds EVERYTHING
 * (which is what shipped) shows nothing else working.
 */
const UNCLASSIFIED_EVERY = 17;

/**
 * CapEx / OpEx for a demo project.
 *
 * Bugs are maintenance of existing software and classify OPEX; feature work
 * (Epic / Story / Task) is new development and classifies CAPEX. That is the
 * ordinary reading of the accounting rule the timesheet report implements, and
 * it means the demo's split follows from data already generated rather than
 * from a second random draw — so this costs the PRNG stream nothing.
 *
 * Returns null for the Unclassified slice. Resolution walks to the nearest
 * classified ancestor (`packages/shared/src/timesheet/classification.ts`), and
 * demo issues have no parents, so each project's own value is what the report
 * uses.
 */
function classificationFor(jiraType: string, index: number): 'CAPEX' | 'OPEX' | null {
  if (index % UNCLASSIFIED_EVERY === 0) return null;
  return jiraType === 'Bug' ? 'OPEX' : 'CAPEX';
}

const PROJECT_TOPICS = [
  'Rate-limit the public API', 'Retire the legacy auth shim', 'Cache board queries',
  'Bulk import from CSV', 'Ship the audit log', 'Reduce cold-start time',
  'Add per-tenant metrics', 'Migrate to structured logging', 'Harden webhook replay',
  'Split the settings screen', 'Offline draft recovery', 'Push notification opt-in',
  'Dark mode for the board grid', 'Paginate the activity feed', 'Deep links into a project',
  'Background refresh budget', 'Crash-free session tracking', 'Biometric unlock',
  'Warehouse export job', 'Backfill missing worklogs', 'Nightly rollup partitions',
  'Deduplicate contributor identities', 'Schema drift alarm', 'Query cost budget',
  'Timezone-correct week buckets', 'Replace the polling loop',
];

/**
 * The whole demo dataset, as a pure function of a clock and a seed.
 *
 * Pure on purpose: every interesting decision — how a project's dates fall, how
 * a status distribution skews, later how deploy cadence and review latency shape
 * DORA — is testable here with no database, no container and no network. The
 * writers that follow contain no decisions at all.
 */
export function generateDemoDataset(now: Date, seed: number): DemoDataset {
  const rand = mulberry32(seed);
  const windowStart = now.getTime() - HISTORY_DAYS * DAY_MS;

  const employees: DemoEmployee[] = CATALOG_PEOPLE.map((person, index) => ({
    id: demoId(`employee:${person.key}`),
    key: person.key,
    name: person.name,
    email: person.email,
    login: person.login,
    role: person.role,
    // 0.5, 0.75, … 2.0 and around again — a fixed cycle over the catalog, so
    // the spread is guaranteed rather than drawn, and it never moves.
    reviewLatencyFactor: 0.5 + (index % 7) * 0.25,
    managerId: person.managerKey === null ? null : demoId(`employee:${person.managerKey}`),
    position: index,
    location: person.location,
    // Everybody predates the history window, so no chart shows a contributor
    // who had not been hired yet.
    hireDate: new Date(windowStart - intBetween(rand, 60, 1500) * DAY_MS),
    isActive: true,
  }));

  const boards: DemoBoard[] = CATALOG_BOARDS.map((catalogBoard) => {
    const boardId = demoId(`board:${catalogBoard.key}`);

    const groups = catalogBoard.groups.map((name, position) => ({
      id: demoId(`group:${catalogBoard.key}:${name}`),
      name,
      position,
    }));

    const statuses = CATALOG_STATUSES.map((status, order) => ({
      id: demoId(`status:${catalogBoard.key}:${status.label}`),
      label: status.label,
      color: status.color,
      order,
      isDefault: status.label === 'Backlog',
    }));

    const owners = CATALOG_PEOPLE.slice(0, 12).map((person, order) => ({
      id: demoId(`owner:${catalogBoard.key}:${person.key}`),
      name: person.name,
      // `order % OWNER_COLORS.length` is always a valid index into a
      // non-empty, fixed-length array literal — provably in range.
      color: OWNER_COLORS[order % OWNER_COLORS.length]!,
      order,
    }));

    const columns: DemoBoard['columns'] = [
      { id: demoId(`column:${catalogBoard.key}:squad`), name: 'Squad', type: 'TEXT', order: 0 },
      { id: demoId(`column:${catalogBoard.key}:points`), name: 'Story points', type: 'NUMBER', order: 1 },
    ];

    const projects: DemoProject[] = [];
    for (let n = 1; n <= PROJECTS_PER_BOARD; n++) {
      const jiraKey = `${catalogBoard.jiraProjectKey}-${100 + n}`;
      // Each of these three indices comes from intBetween(rand, 0, arr.length - 1)
      // against the array it indexes, so it is always in [0, arr.length - 1] —
      // provably in range on a non-empty array.
      const status = statuses[intBetween(rand, 0, statuses.length - 1)]!;
      const owner = owners[intBetween(rand, 0, owners.length - 1)]!;
      const group = groups[intBetween(rand, 0, groups.length - 1)]!;
      // Start density ramps upward across the window. Half the projects are
      // placed uniformly and half by `sqrt(u)`, whose density rises linearly
      // with time; the mixture runs from ~0.5x the mean rate at the window's
      // opening to ~1.5x at its close. Two draws every time (never one), so
      // the PRNG stream — and therefore the whole dataset — stays
      // deterministic whichever branch is taken.
      //
      // The old `HISTORY_DAYS - 20` ceiling is deliberately gone: it left the
      // most recent twenty days with no project starts at all, so every
      // velocity chart FELL to zero at its right edge — the opposite of the
      // upward trend this generator's docblock claims.
      const u = rand();
      const startFraction = rand() < 0.5 ? u : Math.sqrt(u);
      const startDate = new Date(
        windowStart + Math.floor(startFraction * HISTORY_DAYS) * DAY_MS,
      );
      const endDate = new Date(startDate.getTime() + intBetween(rand, 3, 30) * DAY_MS);

      // Built as a variable and classified AFTER, rather than hoisting the
      // `jiraType` draw above the literal. `name` draws from PROJECT_TOPICS
      // before `jiraType` draws from ISSUE_TYPES, and `fieldValues` draws
      // twice after it, so pulling the type draw out to a `const` above the
      // literal would REORDER the stream and move every id and date in the
      // dataset. Assigning the derived field afterwards keeps the draw
      // sequence exactly as it was.
      const project: DemoProject = {
        id: demoId(`project:${jiraKey}`),
        name: `${pick(rand, PROJECT_TOPICS)} (${jiraKey})`,
        owner: owner.name,
        assignee: owner.name,
        status: projectStatusFor(status.label),
        groupId: group.id,
        statusId: status.id,
        ownerId: owner.id,
        order: n * 1000,
        jiraKey,
        jiraProjectKey: catalogBoard.jiraProjectKey,
        jiraType: epicOr(pick(rand, ISSUE_TYPES), n),
        // Derived from `jiraType` immediately below, once the draw above has
        // settled. Not a second draw.
        costClassification: null,
        startDate,
        endDate,
        dueDate: endDate,
        fieldValues: [
          // `columns` is a fixed two-element literal built two lines above;
          // columns[0] and columns[1] are provably in range.
          { columnId: columns[0]!.id, value: pick(rand, ['Core', 'Growth', 'Infra']) },
          { columnId: columns[1]!.id, value: String(pick(rand, [1, 2, 3, 5, 8])) },
        ],
      };
      project.costClassification = classificationFor(project.jiraType, n);
      projects.push(project);
    }

    return {
      id: boardId,
      key: catalogBoard.key,
      name: catalogBoard.name,
      jiraProjectKey: catalogBoard.jiraProjectKey,
      repoFullName: catalogBoard.repoFullName,
      groups,
      statuses,
      owners,
      columns,
      projects,
    };
  });

  return {
    now,
    boards,
    employees,
    clickhouse: generateClickHouse(rand, now, boards, employees),
  };
}

const STATUS_FLOW = [
  { status: 'Backlog', category: 'To Do' },
  { status: 'Selected', category: 'To Do' },
  { status: 'In Progress', category: 'In Progress' },
  { status: 'In Review', category: 'In Progress' },
  { status: 'Done', category: 'Done' },
] as const;

/**
 * The engineering history behind the boards.
 *
 * Shaped rather than uniform, because the point of the demo is the intelligence
 * layer and uniform noise makes every chart a flat line. Exactly four shapes
 * are implemented, and this list is meant to be exhaustive:
 *
 * - **A mild upward trend in project start density** across the window (the
 *   mixture in `generateDemoDataset` above), so throughput rises rather than
 *   sitting flat — and no taper, so the most recent weeks are populated.
 * - **Review latency that varies by author**, through each employee's fixed
 *   `reviewLatencyFactor`: the same person is consistently faster or slower.
 * - **Deployments that mostly succeed** — ~1 in 8 fails, so change-failure
 *   rate is a real number rather than zero.
 * - **Worklogs spread over three to eight entries per issue**, so the
 *   timesheet report sums to plausible weeks per engineer instead of spiking.
 *
 * Everything else here is a uniform draw, and is not claimed to be otherwise.
 */
function generateClickHouse(
  rand: () => number,
  now: Date,
  boards: DemoBoard[],
  employees: DemoEmployee[],
): DemoClickHouse {
  const out: DemoClickHouse = {
    jiraIssues: [], jiraTransitions: [], jiraWorklogs: [],
    githubPullRequests: [], githubCommits: [], githubReviews: [], githubDeployments: [],
    boardItemClassification: [],
  };

  // The catalog's handles (`rmensah`), not the local part of the email
  // (`rita.mensah`) — see `DemoEmployee.login`.
  const logins = employees.map((e) => e.login);
  const names = employees.map((e) => e.name);
  let prNumber = 0;
  let deploymentId = 0;

  for (const board of boards) {
    // Computed across the whole board before any issue is emitted, so the
    // board's newest sprint is the active one no matter which project supplies
    // it. `startDate` is already fixed and clamped into the window by the
    // caller, so this is a pure read. `0` for a board with no projects keeps
    // `Math.max(...[])` from yielding -Infinity; no issue is emitted either
    // way, so the value is never observed.
    const latestSprintIndex = board.projects.length
      ? Math.max(...board.projects.map((p) => sprintIndexFor(p.startDate, now)))
      : 0;
    // Real epic keys on this board: `jiraTypeFor` makes every EPIC_EVERY-th
    // project an Epic, so these exist already and nothing has to be invented.
    const boardEpicKeys = board.projects
      .filter((p) => p.jiraType === 'Epic')
      .map((p) => p.jiraKey);

    for (const project of board.projects) {
      const key = project.jiraKey;
      const created = project.startDate;
      // employees is non-empty (CATALOG_PEOPLE) and authorIndex is drawn from
      // intBetween(rand, 0, employees.length - 1), so it is provably in
      // range against employees/logins/names, which all share that length.
      const authorIndex = intBetween(rand, 0, employees.length - 1);
      const author = names[authorIndex]!;
      // Clamped to `now`: with the taper removed a project can start days
      // before the run, and `endDate` is `startDate + 3..30 days`, so an
      // unclamped `resolved_at` would land in the future and every
      // cycle-time and flow-efficiency bucket would carry a week that has
      // not happened yet.
      const resolved =
        project.status === 'DONE'
          ? new Date(Math.min(project.endDate.getTime(), now.getTime()))
          : null;
      // STATUS_FLOW has 5 entries (indices 0-4). finalStep is either
      // STATUS_FLOW.length - 1 (= 4) or intBetween(rand, 1, 3) (in [1, 3]),
      // so finalStep is always in [1, 4] — a valid STATUS_FLOW index.
      const finalStep = project.status === 'DONE' ? STATUS_FLOW.length - 1 : intBetween(rand, 1, 3);

      // Sprints are DERIVED from the issue's creation date, not drawn — so
      // the PRNG stream, and therefore every id and every other field, does
      // not move. They are also the only source of sprint data in the
      // product: `velocity-with-confidence.ts` and
      // `iteration-planning-accuracy.ts` aggregate `sprint_name` off the
      // ISSUES union, and there is no sprints table anywhere. Leaving these
      // three columns null kept the Velocity widget — one of the four default
      // demo widgets — on its 'No sprints synced yet' empty state forever.
      const sprint = sprintFor(created, board, now, latestSprintIndex);

      // The CapEx/OpEx report reads classifications from ClickHouse, not from
      // Postgres: `apps/api/src/timesheet/timesheet-fetch.ts` queries
      // `cockpit.board_item_classification`, which in production is written by
      // `apps/api/src/projects/classification-mirror.ts` whenever a project's
      // `costClassification` changes. Seeding only the Postgres column would
      // therefore have left the report reading $0 exactly as before, so the
      // seeder writes the mirror too. Shape matches `buildClassificationRow`:
      // it skips a project with no classification, hence the null check.
      if (project.costClassification) {
        out.boardItemClassification.push({
          issue_key: key,
          provider: 'jira',
          classification: project.costClassification,
          board_id: board.id,
          project_id: project.id,
          synced_at: chTime(now),
        });
      }

      out.jiraIssues.push({
        id: `${key}`,
        key,
        project_key: board.jiraProjectKey,
        project_name: board.name,
        issue_type: project.jiraType,
        parent_key: null,
        // Sparse and deterministic: roughly one non-Epic issue in five carries a
        // link, to an epic that actually exists on this board. Sparse because
        // that is what real data looks like — on the reference window only 12 of
        // 105 tasks had one, which is why roadmap coverage cannot be computed
        // from this field alone. Seeding it at all is what stops
        // `epic_key`-reading widgets rendering an all-null column on a demo
        // install, which is the blind spot builders-populated.int.test.ts
        // exists to catch.
        epic_key: epicKeyFor(key, project.jiraType, boardEpicKeys),
        epic_summary: null,
        summary: project.name,
        description: '',
        priority: pick(rand, ['Low', 'Medium', 'High']),
        labels: [],
        components: [],
        fix_versions: [],
        assignee: author,
        assignee_email: employees[authorIndex]!.email,
        reporter: pick(rand, names),
        status: STATUS_FLOW[finalStep]!.status,
        status_category: STATUS_FLOW[finalStep]!.category,
        resolution: resolved ? 'Done' : null,
        story_points: pick(rand, [1, 2, 3, 5, 8]),
        original_estimate_s: null,
        time_spent_s: null,
        sprint_id: sprint.id,
        sprint_name: sprint.name,
        sprint_state: sprint.state,
        created_at: chTime(created),
        updated_at: chTime(resolved ?? now),
        resolved_at: resolved ? chTime(resolved) : null,
        due_date: project.dueDate.toISOString().slice(0, 10),
        custom_fields: '{}',
        instance_url: 'https://northwind.example.atlassian.net',
      });

      // Walk the status flow forward. Each step lands between the issue's
      // creation and its resolution (or now), so the derived cycle times are
      // ordered rather than merely present.
      //
      // Each step advances by at least ONE SECOND. `jira_transitions`'s sort
      // key is (organization_id, project_key, issue_key, transitioned_at) with
      // no `id` in it, so two steps clamped to the same instant on a
      // short-lived issue collapse into one row under ReplacingMergeTree and
      // the issue's final "In Review -> Done" step silently disappears — about
      // ten transitions a run before this reservation existed.
      const ceiling = (resolved ?? now).getTime();
      let at = created.getTime();
      for (let step = 1; step <= finalStep; step++) {
        const dwell = intBetween(rand, 4, 96) * 3_600_000;
        const previous = at;
        // Leave one second per step still to come, so the clamp never has to
        // stack two of them on the ceiling.
        const latest = ceiling - (finalStep - step) * 1000;
        at = Math.max(Math.min(at + dwell, latest), previous + 1000);
        out.jiraTransitions.push({
          id: `${key}-t${step}`,
          issue_key: key,
          project_key: board.jiraProjectKey,
          issue_type: project.jiraType,
          assignee: author,
          // step ranges [1, finalStep] and finalStep <= 4, so step and
          // step - 1 are both valid STATUS_FLOW indices (0-4).
          from_status: STATUS_FLOW[step - 1]!.status,
          from_category: STATUS_FLOW[step - 1]!.category,
          to_status: STATUS_FLOW[step]!.status,
          to_category: STATUS_FLOW[step]!.category,
          transitioned_by: author,
          transitioned_at: chTime(new Date(at)),
          // The dwell as ACTUALLY applied, not as drawn — the clamp above
          // shortens it whenever the issue resolved sooner than the draw.
          time_in_prev_status_s: Math.floor((at - previous) / 1000),
        });
      }

      // Worklogs — three to eight entries per issue, so the timesheet report
      // sums to plausible weeks per engineer rather than to a single spike.
      const worklogCount = intBetween(rand, 3, 8);
      for (let w = 0; w < worklogCount; w++) {
        const startedAt = new Date(created.getTime() + intBetween(rand, 0, 20) * DAY_MS);
        if (startedAt.getTime() > now.getTime()) continue;
        out.jiraWorklogs.push({
          id: `${key}-w${w}`,
          issue_key: key,
          project_key: board.jiraProjectKey,
          author,
          author_email: employees[authorIndex]!.email,
          time_spent_s: intBetween(rand, 1, 6) * 3600,
          started_at: chTime(startedAt),
          created_at: chTime(startedAt),
        });
      }

      // Two PRs out of three carry a ticket key; the third is the coverage gap
      // the ticket-coverage widget exists to show.
      const prCount = intBetween(rand, 1, 3);
      for (let p = 0; p < prCount; p++) {
        prNumber += 1;
        // Same proof as authorIndex above: employees is non-empty and the
        // index is drawn from intBetween(rand, 0, employees.length - 1).
        const prAuthorIndex = intBetween(rand, 0, employees.length - 1);
        const prCreated = new Date(created.getTime() + intBetween(rand, 0, 14) * DAY_MS);
        if (prCreated.getTime() > now.getTime()) continue;
        const isMerged = rand() < 0.82;
        // The author's own fixed factor, so this person's PRs consistently
        // wait longer (or less) for a first review than that person's.
        const latencyFactor = employees[prAuthorIndex]!.reviewLatencyFactor;
        // Unclamped draw first, so the PRNG stream — and therefore ids and
        // every OTHER field — never moves. `reviewLatencyFactor` runs up to
        // 2x and there is no taper reserving a buffer before `now` any more
        // (see the project-start comment above), so this can land up to
        // ~80 hours past `now` for an unmerged PR with no merge/close event
        // to clamp it. Clamp immediately, and derive everything else —
        // `mergedAt`, the hours, `updated_at` — from the CLAMPED value, not
        // the raw one, so a review that reads as landing at `now` also has a
        // duration and a merge time that agree with that.
        const rawReviewAt = new Date(
          prCreated.getTime() +
            Math.max(1, Math.round(intBetween(rand, 1, 40) * latencyFactor)) * 3_600_000,
        );
        const reviewAt = new Date(Math.min(rawReviewAt.getTime(), now.getTime()));
        const mergedAt = new Date(reviewAt.getTime() + intBetween(rand, 1, 30) * 3_600_000);
        const capped = mergedAt.getTime() > now.getTime() ? now : mergedAt;
        const headBranch = `feature/${key.toLowerCase()}-${p}`;
        const mergeCommitSha = isMerged ? shaFor(rand) : null;

        out.githubPullRequests.push({
          id: `${board.repoFullName}#${prNumber}`,
          repo_full_name: board.repoFullName,
          number: prNumber,
          instance_id: demoId('github-instance:demo'),
          title: `${key} ${project.name}`,
          body: '',
          // DERIVED, mirroring `deriveState` in
          // `packages/shared/src/github-pr-adapter.ts` — 'merged' whenever
          // `merged_at` is set, not GitHub's raw open/closed. The entire PR
          // half of the dashboards filters on `state = 'merged'` (DORA lead
          // time and change-failure, the cycle-time scatter and trend,
          // review-quality index and trend, PR-size distribution, ticket
          // coverage, AI-assisted share, merge frequency, both
          // period-comparison sides), so seeding 'closed' emptied all of them
          // on a fresh install while every row count still looked correct.
          state: isMerged ? 'merged' : 'open',
          is_draft: 0,
          base_branch: 'main',
          head_branch: headBranch,
          labels: [],
          milestone_title: null,
          author_login: logins[prAuthorIndex]!,
          author_name: names[prAuthorIndex]!,
          requested_reviewers: [],
          additions: intBetween(rand, 10, 600),
          deletions: intBetween(rand, 2, 300),
          changed_files: intBetween(rand, 1, 18),
          commit_count: intBetween(rand, 1, 12),
          created_at: chTime(prCreated),
          updated_at: chTime(isMerged ? capped : reviewAt),
          merged_at: isMerged ? chTime(capped) : null,
          closed_at: isMerged ? chTime(capped) : null,
          // A review on an open PR is ordinary and real. A MERGE time on one
          // is not: `capped` derives from a `mergedAt` that never happened,
          // and `clickhouse-intelligence.service.ts`'s per-engineer recent-PR
          // list selects `cycle_time_hours` with no merged filter — so an
          // open demo PR was displaying a completed cycle time. Both
          // merge-derived fields are null unless the PR actually merged.
          first_review_at: chTime(reviewAt),
          first_approval_at: chTime(reviewAt),
          cycle_time_hours: isMerged
            ? (capped.getTime() - prCreated.getTime()) / 3_600_000
            : null,
          review_time_hours: (reviewAt.getTime() - prCreated.getTime()) / 3_600_000,
          approval_time_hours: (reviewAt.getTime() - prCreated.getTime()) / 3_600_000,
          merge_time_hours: isMerged
            ? (capped.getTime() - reviewAt.getTime()) / 3_600_000
            : null,
          ai_assisted: rand() < 0.35 ? 1 : 0,
          ai_confidence: null,
          ai_signals: '{}',
          linked_ticket_keys: [key],
          merge_commit_sha: mergeCommitSha,
          // logins is the same length as employees, and the index is drawn
          // from intBetween(rand, 0, logins.length - 1) — provably in range.
          merged_by_login: isMerged ? logins[intBetween(rand, 0, logins.length - 1)]! : null,
        });

        // github_reviews has no `instance_id` column and its PR number
        // column is `pull_request_number`, not `pr_number` — an unknown or
        // misnamed field is rejected by ClickHouse's JSONEachRow parser at
        // insert time. `pr_author_login` is a required (non-nullable, no
        // DEFAULT) column, so it must always be supplied.
        //
        // One to three reviews per PR, each by a DIFFERENT person. Exactly one
        // review per PR made every reviews-per-PR panel read n = 1 everywhere,
        // which is not a distribution.
        const reviewCount = intBetween(rand, 1, 3);
        const reviewers = new Set<number>();
        for (let r = 0; r < reviewCount; r++) {
          let reviewerIndex = intBetween(rand, 0, employees.length - 1);
          // Walk forward to the next unused reviewer. `employees` has ~25
          // entries and `reviewCount` is at most 3, so a free index always
          // exists and this terminates.
          while (reviewers.has(reviewerIndex)) {
            reviewerIndex = (reviewerIndex + 1) % employees.length;
          }
          reviewers.add(reviewerIndex);
          out.githubReviews.push({
            // `github_reviews` orders on (organization_id, repo_full_name,
            // pull_request_number, id), so the per-review `id` suffix is what
            // keeps these rows distinct under ReplacingMergeTree.
            id: `${board.repoFullName}#${prNumber}-r${r}`,
            repo_full_name: board.repoFullName,
            pull_request_number: prNumber,
            pr_author_login: logins[prAuthorIndex]!,
            reviewer_login: logins[reviewerIndex]!,
            reviewer_name: names[reviewerIndex]!,
            state: pick(rand, ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']),
            body: '',
            comment_count: intBetween(rand, 0, 8),
            // `reviewAt` is already clamped to `now`, but a later reviewer's
            // offset (up to 2 * 30 minutes) can still push past it — clamp
            // per row rather than assume the base timestamp being safe is
            // enough.
            submitted_at: chTime(
              new Date(Math.min(reviewAt.getTime() + r * 1_800_000, now.getTime())),
            ),
          });
        }

        const commitCount = intBetween(rand, 1, 6);
        for (let c = 0; c < commitCount; c++) {
          const committedAt = new Date(prCreated.getTime() + c * 3_600_000);
          if (committedAt.getTime() > now.getTime()) continue;
          // github_commits requires author_name, committer_name and
          // message_subject (String columns with no DEFAULT) — the demo
          // author also commits and merges their own branch, and the
          // message has no body, so the subject is the whole message.
          const commitSha = shaFor(rand);
          const commitMessage = `${key} ${pick(rand, ['fix', 'refactor', 'test', 'feat'])}`;
          out.githubCommits.push({
            id: `${board.repoFullName}@${commitSha}`,
            repo_full_name: board.repoFullName,
            sha: commitSha,
            instance_id: demoId('github-instance:demo'),
            author_login: logins[prAuthorIndex]!,
            author_name: names[prAuthorIndex]!,
            author_email: employees[prAuthorIndex]!.email,
            committer_login: logins[prAuthorIndex]!,
            committer_name: names[prAuthorIndex]!,
            message: commitMessage,
            message_subject: commitMessage,
            additions: intBetween(rand, 1, 200),
            deletions: intBetween(rand, 0, 120),
            changed_files: intBetween(rand, 1, 8),
            branch: headBranch,
            pull_request_number: prNumber,
            is_merge_commit: 0,
            committed_at: chTime(committedAt),
            ai_assisted: 0,
            ai_confidence: null,
            ai_signals: '{}',
            linked_ticket_keys: [key],
          });
        }

        if (isMerged && rand() < 0.45) {
          deploymentId += 1;
          // One draw, two fields. Drawn independently, `environment` and
          // `production` disagreed on roughly a third of deployments — a row
          // claiming `production = 1` while sitting in `staging`.
          const environment = rand() < 0.7 ? 'production' : 'staging';
          const deployedAt = new Date(capped.getTime() + intBetween(rand, 1, 8) * 3_600_000);
          const at = deployedAt.getTime() > now.getTime() ? now : deployedAt;
          out.githubDeployments.push({
            id: `${board.repoFullName}#${deploymentId}`,
            // board.repoFullName is always "{owner}/{repo}" from the catalog,
            // so split('/') always yields at least one element — index 0 is
            // provably present.
            org: board.repoFullName.split('/')[0]!,
            repo_full_name: board.repoFullName,
            instance_id: demoId('github-instance:demo'),
            deployment_id: deploymentId,
            ref: 'main',
            sha: shaFor(rand),
            task: 'deploy',
            environment,
            production: environment === 'production' ? 1 : 0,
            creator_login: logins[prAuthorIndex]!,
            created_at: chTime(new Date(at)),
            updated_at: chTime(new Date(at)),
            // ~1 in 8 fails, so change-failure rate is a number rather than zero.
            latest_status: rand() < 0.12 ? 'failure' : 'success',
            latest_status_at: chTime(new Date(at)),
          });
        }
      }
    }
  }

  return out;
}

function shaFor(rand: () => number): string {
  const HEX = '0123456789abcdef';
  let sha = '';
  // i ranges [0, 39] and HEX has 16 characters (indices 0-15); intBetween
  // clamps to [0, 15], so HEX[...] is always defined.
  for (let i = 0; i < 40; i++) sha += HEX[intBetween(rand, 0, 15)]!;
  return sha;
}

function projectStatusFor(statusLabel: string): DemoProject['status'] {
  switch (statusLabel) {
    case 'Done':
      return 'DONE';
    case 'In Progress':
    case 'In Review':
      return 'IN_PROGRESS';
    case 'Selected':
      return 'NOT_STARTED';
    default:
      return 'NOT_STARTED';
  }
}
