import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { demoId } from './ids.js';
import { CATALOG_STATUSES } from './catalog.js';
import type { DemoDataset } from './generate.js';
import { ALL_PRESETS, DEFAULT_SIZE_DURATIONS, DEFAULT_SIZE_WEEKS } from '@deckgauge/shared';
import { demoWorkingStates, DEMO_STAGE_MAP_OVERRIDE } from './focus-seed.js';

/** The ids the seeded connections take, shared with `generate.ts` and `remove.ts`. */
export const DEMO_JIRA_INSTANCE_ID = demoId('jira-instance:demo');
export const DEMO_GITHUB_INSTANCE_ID = demoId('github-instance:demo');

/**
 * The rest of the singleton root ids — kept as module-level constants (rather
 * than recomputed locally, as they were before) so the pre-flight tenant guard
 * below and the transaction body can never drift apart on what "the demo
 * roadmap" etc. means.
 *
 * Exported so `remove.ts` imports them rather than re-spelling the same
 * `demoId()` keys by hand — a key that differs by one character is a row that
 * can never be removed.
 */
export const DEMO_ROADMAP_ID = demoId('roadmap:demo');
export const DEMO_COMPARISON_ID = demoId('comparison:demo');
export const DEMO_ORG_TREE_ID = demoId('org-tree:demo');
export const DEMO_FOLDER_ID = demoId('folder:demo');

/**
 * The one seeded id that is NOT a fixed singleton — one per employee — and so
 * cannot be a module-level constant the way the four above are. Exported as a
 * function for the same reason those are exported as values: so `remove.ts`
 * calls this instead of re-spelling `demoId(\`ts-rule:${key}\`)` by hand. That
 * key was re-spelled on both sides once already; this closes it.
 */
export const demoTimesheetRuleId = (employeeKey: string): string => demoId(`ts-rule:${employeeKey}`);

/**
 * Status labels the timesheet engine treats as "still being worked", both for
 * the tree-wide default (`OrgTreeTimesheetConfig.activeStatuses`) and for each
 * per-employee override rule. Derived from the same catalog every board's
 * `BoardStatus` rows are built from (`CATALOG_STATUSES`), so it always matches
 * the labels actually on the boards rather than a hand-kept second list.
 *
 * `demoWorkingStates()` in `focus-seed.ts` is the same CONCEPT from a different
 * SOURCE, and the two must not be unified: the timesheet compares these against
 * board `BoardStatus` labels (built from `CATALOG_STATUSES`), while Focus
 * compares its `workingStates` against `jira_issues.status` (written from
 * `STATUS_FLOW`). Two consumers, two correct sources — and they agree only
 * because `focus-seed.test.ts` now asserts that the two lists do.
 */
const IN_PROGRESS_STATUS_LABELS = CATALOG_STATUSES.filter(
  (status) => status.category === 'In Progress',
).map((status) => status.label);

/**
 * Refuses to seed when the demo's singleton ids already belong to a DIFFERENT
 * organization.
 *
 * Every demo id is deliberately organization-independent — `demoId('board:platform')`
 * is the same UUID no matter which org it is seeded into, because task 8's
 * remover re-derives all nine singleton keys by name and `generate.ts` stamps
 * `demoId('github-instance:demo')` into every ClickHouse row regardless of
 * tenant. That is correct and MUST NOT change here: adding `organizationId`
 * into the `demoId()` keys would fix this file at the cost of breaking the
 * generator, the ClickHouse writer and the remover, which all agree on the
 * unqualified keys.
 *
 * But it means an upsert keyed on one of these ids, run against a SECOND
 * organization, finds the FIRST organization's row by id, leaves its
 * `organizationId` untouched (no upsert here re-stamps it — that is the actual
 * bug), and then grants the second organization's owner OWNER access on the
 * first organization's board / roadmap / org tree / comparison. That is a
 * tenant-boundary crossing, not merely stale data, so it is refused outright
 * rather than "fixed" by silently re-parenting someone else's rows to the
 * caller.
 *
 * Runs BEFORE the transaction opens — a read-only pre-flight check, not a step
 * inside the write — so a seed into an already-claimed install fails loudly
 * before touching anything.
 */
async function assertDemoNotClaimedByAnotherOrg(
  prisma: PrismaClient,
  dataset: DemoDataset,
  organizationId: string,
): Promise<void> {
  const found: { label: string; organizationId: string }[] = [];

  const jira = await prisma.jiraInstance.findUnique({
    where: { id: DEMO_JIRA_INSTANCE_ID },
    select: { organizationId: true },
  });
  if (jira) found.push({ label: 'the demo Jira connection', organizationId: jira.organizationId });

  const github = await prisma.gitHubInstance.findUnique({
    where: { id: DEMO_GITHUB_INSTANCE_ID },
    select: { organizationId: true },
  });
  if (github) found.push({ label: 'the demo GitHub connection', organizationId: github.organizationId });

  const boards = await prisma.board.findMany({
    where: { id: { in: dataset.boards.map((b) => b.id) } },
    select: { id: true, organizationId: true },
  });
  for (const board of boards) {
    found.push({ label: `demo board ${board.id}`, organizationId: board.organizationId });
  }

  const roadmap = await prisma.roadmap.findUnique({
    where: { id: DEMO_ROADMAP_ID },
    select: { organizationId: true },
  });
  if (roadmap) found.push({ label: 'the demo roadmap', organizationId: roadmap.organizationId });

  const comparison = await prisma.comparison.findUnique({
    where: { id: DEMO_COMPARISON_ID },
    select: { organizationId: true },
  });
  if (comparison) found.push({ label: 'the demo comparison', organizationId: comparison.organizationId });

  const orgTree = await prisma.orgTree.findUnique({
    where: { id: DEMO_ORG_TREE_ID },
    select: { organizationId: true },
  });
  if (orgTree) found.push({ label: 'the demo org tree', organizationId: orgTree.organizationId });

  const folder = await prisma.boardFolder.findUnique({
    where: { id: DEMO_FOLDER_ID },
    select: { organizationId: true },
  });
  if (folder) found.push({ label: 'the demo board folder', organizationId: folder.organizationId });

  const foreign = found.find((row) => row.organizationId !== organizationId);
  if (foreign) {
    throw new Error(
      `Cannot seed the demo into organization ${organizationId}: ${foreign.label} already ` +
        `belongs to organization ${foreign.organizationId}. The demo data already belongs to ` +
        'another organization — remove it there first with the demo seeder\'s --remove, then seed again.',
    );
  }
}

/**
 * Refuses to seed when the target organization already syncs one of the
 * demo's Jira project keys or GitHub repos through a FOREIGN (non-demo)
 * connection.
 *
 * `--remove`'s ClickHouse half deletes by `organization_id` PLUS the
 * catalog's static `project_key` / `repo_full_name` — see `remove.ts`. Those
 * catalog keys (`DGDEMO`, `DGMOB`, …) are chosen to be implausible as real
 * Jira project keys, but no fixed key is provably collision-free, and an
 * organization that already happens to sync a project under one of them
 * would have two failures stack: the seed writes fake rows into the same
 * key-space as their real synced data, and a later `--remove` deletes real
 * rows alongside the fake ones — silent and unrecoverable, unlike the
 * "claimed by another org" case above, which just refuses loudly. Seed time
 * is the only point where this is still preventable.
 *
 * Scoped to `organizationId`'s OWN syncs — a project keyed identically at a
 * different organization is none of this organization's business, exactly
 * like `assertDemoNotClaimedByAnotherOrg` above. And scoped to FOREIGN syncs
 * only (`jiraInstanceId`/`githubInstanceId` not the demo's own) — re-seeding
 * over the demo's own `JiraProjectSync/GitHubRepoSync` rows (an idempotent
 * re-seed, or a re-seed after `--remove` half-completed) must keep working.
 */
async function assertNoForeignSyncCollision(
  prisma: PrismaClient,
  dataset: DemoDataset,
  organizationId: string,
): Promise<void> {
  const projectKeys = dataset.boards.map((b) => b.jiraProjectKey);
  const repos = dataset.boards.map((b) => b.repoFullName);

  const foreignJira = await prisma.jiraProjectSync.findFirst({
    where: {
      jiraProjectKey: { in: projectKeys },
      jiraInstanceId: { not: DEMO_JIRA_INSTANCE_ID },
      jiraInstance: { organizationId },
    },
    select: { jiraProjectKey: true },
  });
  if (foreignJira) {
    throw new Error(
      `Cannot seed the demo into organization ${organizationId}: it already syncs a real ` +
        `Jira project keyed "${foreignJira.jiraProjectKey}" through a connection that is not the ` +
        "demo's own. The demo cannot be seeded into an organization that already syncs one of its " +
        'project keys — that project\'s real issues would be deleted the next time the demo is removed.',
    );
  }

  const foreignGitHub = await prisma.gitHubRepoSync.findFirst({
    where: {
      repoFullName: { in: repos },
      githubInstanceId: { not: DEMO_GITHUB_INSTANCE_ID },
      githubInstance: { organizationId },
    },
    select: { repoFullName: true },
  });
  if (foreignGitHub) {
    throw new Error(
      `Cannot seed the demo into organization ${organizationId}: it already syncs a real GitHub ` +
        `repo named "${foreignGitHub.repoFullName}" through a connection that is not the demo's own. ` +
        'The demo cannot be seeded into an organization that already syncs one of its repo names — ' +
        "that repo's real commits/PRs would be deleted the next time the demo is removed.",
    );
  }
}

export async function writeDemoToPostgres(
  prisma: PrismaClient,
  dataset: DemoDataset,
  organizationId: string,
  ownerUserId: string,
): Promise<void> {
  await assertDemoNotClaimedByAnotherOrg(prisma, dataset, organizationId);
  await assertNoForeignSyncCollision(prisma, dataset, organizationId);

  // One transaction: a half-written demo is worse than none. The 5s default is
  // nowhere near enough for ~130 projects and their field values.
  await prisma.$transaction(async (tx) => {
    const jira = await tx.jiraInstance.upsert({
      where: { id: DEMO_JIRA_INSTANCE_ID },
      create: {
        id: DEMO_JIRA_INSTANCE_ID,
        name: 'Northwind Jira (demo)',
        atlassianUrl: 'https://northwind.example.atlassian.net',
        email: 'demo@northwind.example',
        apiToken: 'demo-not-a-real-token',
        projectKeys: dataset.boards.map((b) => b.jiraProjectKey),
        organizationId,
        // The whole reason the worker leaves this connection alone. Without it
        // the scheduled sync calls a host that does not exist every 15 minutes
        // and deletion detection purges the demo's ClickHouse rows.
        isDemo: true,
        // Organization-wide, so every member sees the demo board's sources.
        ownerUserId: null,
      },
      update: { isDemo: true, projectKeys: dataset.boards.map((b) => b.jiraProjectKey) },
    });

    const github = await tx.gitHubInstance.upsert({
      where: { id: DEMO_GITHUB_INSTANCE_ID },
      create: {
        id: DEMO_GITHUB_INSTANCE_ID,
        baseUrl: 'https://api.github.com',
        accessToken: 'demo-not-a-real-token',
        org: 'northwind',
        organizationId,
        isDemo: true,
        ownerUserId: null,
      },
      update: { isDemo: true, baseUrl: 'https://api.github.com', org: 'northwind' },
    });

    for (const board of dataset.boards) {
      await tx.board.upsert({
        where: { id: board.id },
        create: {
          id: board.id,
          name: board.name,
          organizationId,
          // Not read by getBoardScope, but the Phase 3 promote path uses it and
          // a board without it drops its linked tickets.
          ticketKeyPrefixes: [board.jiraProjectKey],
        },
        update: { name: board.name, ticketKeyPrefixes: [board.jiraProjectKey] },
      });

      await tx.boardAccess.upsert({
        where: { boardId_userId: { boardId: board.id, userId: ownerUserId } },
        create: { boardId: board.id, userId: ownerUserId, role: 'OWNER' },
        update: { role: 'OWNER' },
      });

      for (const group of board.groups) {
        await tx.group.upsert({
          where: { id: group.id },
          create: { id: group.id, name: group.name, position: group.position, boardId: board.id },
          update: { name: group.name, position: group.position },
        });
      }

      for (const status of board.statuses) {
        await tx.boardStatus.upsert({
          where: { id: status.id },
          create: {
            id: status.id,
            boardId: board.id,
            label: status.label,
            color: status.color,
            order: status.order,
            isDefault: status.isDefault,
          },
          update: { label: status.label, color: status.color, order: status.order, isDefault: status.isDefault },
        });
      }

      for (const owner of board.owners) {
        await tx.boardOwner.upsert({
          where: { id: owner.id },
          create: { id: owner.id, boardId: board.id, name: owner.name, color: owner.color, order: owner.order },
          update: { name: owner.name, color: owner.color, order: owner.order },
        });
      }

      for (const column of board.columns) {
        await tx.boardColumn.upsert({
          where: { id: column.id },
          create: { id: column.id, boardId: board.id, name: column.name, type: column.type, order: column.order },
          update: { name: column.name, type: column.type, order: column.order },
        });
      }

      for (const project of board.projects) {
        await tx.project.upsert({
          where: { id: project.id },
          create: {
            id: project.id,
            name: project.name,
            owner: project.owner,
            assignee: project.assignee,
            status: project.status,
            boardId: board.id,
            groupId: project.groupId,
            statusId: project.statusId,
            ownerId: project.ownerId,
            order: project.order,
            jiraKey: project.jiraKey,
            jiraProjectKey: project.jiraProjectKey,
            jiraType: project.jiraType,
            costClassification: project.costClassification,
            startDate: project.startDate,
            endDate: project.endDate,
            dueDate: project.dueDate,
          },
          update: {
            status: project.status,
            // Kept in step with the ClickHouse mirror the CapEx/OpEx report
            // actually reads. Postgres is the source of truth a user edits,
            // so a re-seed that refreshed only the mirror would leave the two
            // disagreeing the moment anyone opened the item.
            costClassification: project.costClassification,
            groupId: project.groupId,
            name: project.name,
            // These are anchored to `dataset.now` in generate.ts and DO move
            // between runs (the whole demo history window slides with the
            // clock); the update branch must re-stamp them, not just the
            // fields that never move.
            startDate: project.startDate,
            endDate: project.endDate,
            dueDate: project.dueDate,
          },
        });

        for (const fieldValue of project.fieldValues) {
          await tx.projectFieldValue.upsert({
            where: { projectId_columnId: { projectId: project.id, columnId: fieldValue.columnId } },
            create: {
              id: demoId(`field-value:${project.id}:${fieldValue.columnId}`),
              projectId: project.id,
              columnId: fieldValue.columnId,
              value: fieldValue.value,
            },
            update: { value: fieldValue.value },
          });
        }
      }

      const projectSync = await tx.jiraProjectSync.upsert({
        where: { id: demoId(`jira-sync:${board.jiraProjectKey}`) },
        create: {
          id: demoId(`jira-sync:${board.jiraProjectKey}`),
          jiraInstanceId: jira.id,
          jiraProjectKey: board.jiraProjectKey,
          syncWorklogs: true,
        },
        update: { syncWorklogs: true },
      });

      // Without this row getBoardScope returns isEmpty and every intelligence
      // method short-circuits before querying ClickHouse.
      await tx.boardJiraSource.upsert({
        where: { boardId_jiraProjectSyncId: { boardId: board.id, jiraProjectSyncId: projectSync.id } },
        create: { boardId: board.id, jiraProjectSyncId: projectSync.id },
        update: {},
      });

      const repoSync = await tx.gitHubRepoSync.upsert({
        where: { id: demoId(`github-sync:${board.repoFullName}`) },
        create: {
          id: demoId(`github-sync:${board.repoFullName}`),
          githubInstanceId: github.id,
          repoFullName: board.repoFullName,
        },
        update: {},
      });

      await tx.boardGitHubSource.upsert({
        where: { boardId_gitHubRepoSyncId: { boardId: board.id, gitHubRepoSyncId: repoSync.id } },
        create: {
          boardId: board.id,
          gitHubRepoSyncId: repoSync.id,
          // The default, but stated explicitly — it is the flag the whole
          // statistics half depends on.
          useForIntelligence: true,
        },
        update: { useForIntelligence: true },
      });

      /**
       * Team Focus is zero-configuration on a real board — every FocusConfig
       * field has a working default. The demo is the case where two of those
       * defaults are wrong for the data, so it states them. See focus-seed.ts
       * for which two and why.
       */
      await tx.focusConfig.upsert({
        where: { boardId: board.id },
        create: {
          id: demoId(`focus-config:${board.key}`),
          boardId: board.id,
          workingStates: demoWorkingStates(),
          stageMap: DEMO_STAGE_MAP_OVERRIDE as unknown as Prisma.InputJsonValue,
          // The shipped A/B/C labels are correct for this dataset.
          classLabels: {},
        },
        update: {
          workingStates: demoWorkingStates(),
          stageMap: DEMO_STAGE_MAP_OVERRIDE as unknown as Prisma.InputJsonValue,
        },
      });
    }

    /**
     * The residue, as HUMAN verdicts — see `focus-seed.ts` for which tasks and
     * why only those.
     *
     * HUMAN is the honest tier and the only defensible one here.
     * `resolve-verdict.ts` describes it as "a person taking responsibility for a
     * call", which is what a hand-curated demo dataset is. RULE would claim a
     * rule fired when the defining property of this set is that none did; MODEL
     * would claim an inference nobody paid for. It is also the top tier, so the
     * residue stays classified whatever the tiers below it later do — and that
     * cuts both ways, which is why `focusResidueVerdicts` refuses to emit a
     * fingerprint any already-decided task carries.
     *
     * Organization-scoped, not board-scoped: `FocusVerdict` has no board FK at
     * all. That is also why `remove.ts` has to delete these explicitly rather
     * than leaning on the board cascade.
     */
    for (const verdict of dataset.focusVerdicts) {
      await tx.focusVerdict.upsert({
        where: {
          organizationId_fingerprint: {
            organizationId,
            fingerprint: verdict.fingerprint,
          },
        },
        create: {
          id: demoId(`focus-verdict:${verdict.fingerprint}`),
          organizationId,
          fingerprint: verdict.fingerprint,
          class: verdict.class,
          epicKey: null,
          reason: verdict.reason,
          source: 'HUMAN',
          ruleId: verdict.ruleId,
        },
        update: { class: verdict.class, reason: verdict.reason, source: 'HUMAN' },
      });
    }

    // ── Org tree ──────────────────────────────────────────────────────────────
    const orgTreeId = DEMO_ORG_TREE_ID;
    await tx.orgTree.upsert({
      where: { id: orgTreeId },
      create: { id: orgTreeId, name: 'Northwind Systems', organizationId },
      update: { name: 'Northwind Systems' },
    });

    await tx.orgTreeAccess.upsert({
      where: { orgTreeId_userId: { orgTreeId, userId: ownerUserId } },
      create: { orgTreeId, userId: ownerUserId, role: 'OWNER' },
      update: { role: 'OWNER' },
    });

    // Pass 1: every employee, manager link left null. A manager may sort after
    // their report in CATALOG_PEOPLE (e.g. a Director created after a Staff
    // Engineer who reports to them is fine, but the reverse also happens), and
    // OrgEmployee.managerId is a self-referential FK — the referenced row must
    // already exist.
    for (const employee of dataset.employees) {
      await tx.orgEmployee.upsert({
        where: { id: employee.id },
        create: {
          id: employee.id,
          orgTreeId,
          externalId: employee.key,
          name: employee.name,
          role: employee.role,
          email: employee.email,
          location: employee.location,
          hireDate: employee.hireDate,
          position: employee.position,
          isActive: employee.isActive,
          // Marks this row as resolved to a real identity rather than a
          // vacancy or an unmatched sync candidate — org-tree.service.ts
          // excludes anything with `matched: false` from every leaderboard.
          // The demo's employees ARE the authors behind the ClickHouse rows
          // (matched by email in generate.ts), so this must be true or the
          // per-engineer views come back empty.
          matched: true,
          managerId: null,
        },
        update: {
          name: employee.name,
          role: employee.role,
          email: employee.email,
          location: employee.location,
          isActive: employee.isActive,
          position: employee.position,
          hireDate: employee.hireDate,
          // Cleared here and re-established in pass 2 below, same as create.
          // Without this, an employee whose manager has since left the
          // catalog (or moved) keeps its OLD `managerId` forever — pass 2
          // only ever sets a link, it never removes one.
          managerId: null,
        },
      });
    }

    // Pass 2: the manager links, now that every employee row exists.
    for (const employee of dataset.employees) {
      if (employee.managerId === null) continue;
      await tx.orgEmployee.update({
        where: { id: employee.id },
        data: { managerId: employee.managerId },
      });
    }

    await tx.orgTreeTimesheetConfig.upsert({
      where: { orgTreeId },
      create: { orgTreeId, activeStatuses: IN_PROGRESS_STATUS_LABELS },
      update: { activeStatuses: IN_PROGRESS_STATUS_LABELS },
    });

    for (const employee of dataset.employees) {
      const ruleId = demoTimesheetRuleId(employee.key);
      await tx.timesheetStatusRule.upsert({
        where: { id: ruleId },
        create: {
          id: ruleId,
          organizationId,
          scope: 'EMPLOYEE',
          employeeId: employee.id,
          inProgressStatuses: IN_PROGRESS_STATUS_LABELS,
        },
        update: { inProgressStatuses: IN_PROGRESS_STATUS_LABELS },
      });
    }

    // ── Roadmap ───────────────────────────────────────────────────────────────
    const roadmapId = DEMO_ROADMAP_ID;
    await tx.roadmap.upsert({
      where: { id: roadmapId },
      create: {
        id: roadmapId,
        name: 'Northwind Systems Roadmap',
        createdBy: ownerUserId,
        organizationId,
      },
      update: {},
    });

    await tx.roadmapAccess.upsert({
      where: { roadmapId_userId: { roadmapId, userId: ownerUserId } },
      create: { roadmapId, userId: ownerUserId, role: 'OWNER' },
      update: { role: 'OWNER' },
    });

    let groupPosition = 0;
    for (const board of dataset.boards) {
      await tx.roadmapBoardSubscription.upsert({
        where: { roadmapId_boardId: { roadmapId, boardId: board.id } },
        create: { id: demoId(`roadmap-sub:${board.key}`), roadmapId, boardId: board.id },
        update: {},
      });

      for (const group of board.groups) {
        await tx.roadmapGroup.upsert({
          where: { roadmapId_groupId: { roadmapId, groupId: group.id } },
          create: {
            id: demoId(`roadmap-group:${group.id}`),
            roadmapId,
            groupId: group.id,
            position: groupPosition,
            source: 'BOARD_SUB',
          },
          update: { position: groupPosition },
        });
        groupPosition += 1;
      }
    }

    const roadmapGridViewId = demoId('roadmap-view:demo:grid');
    await tx.roadmapView.upsert({
      where: { id: roadmapGridViewId },
      create: { id: roadmapGridViewId, roadmapId, type: 'GRID', name: 'Grid', position: 0 },
      update: {},
    });

    const roadmapGanttViewId = demoId('roadmap-view:demo:gantt');
    await tx.roadmapView.upsert({
      where: { id: roadmapGanttViewId },
      create: { id: roadmapGanttViewId, roadmapId, type: 'GANTT', name: 'Timeline', position: 1 },
      update: {},
    });

    await tx.roadmapGanttConfig.upsert({
      where: { roadmapViewId: roadmapGanttViewId },
      create: {
        id: demoId('roadmap-gantt-config:demo'),
        roadmapViewId: roadmapGanttViewId,
        startDate: dataset.now,
        visibleQuarters: 4,
        sizeDurations: DEFAULT_SIZE_DURATIONS as unknown as Prisma.InputJsonValue,
        defaultSizeWeeks: DEFAULT_SIZE_WEEKS,
      },
      update: {},
    });

    // ── Comparison ────────────────────────────────────────────────────────────
    const comparisonId = DEMO_COMPARISON_ID;
    await tx.comparison.upsert({
      where: { id: comparisonId },
      create: { id: comparisonId, name: 'Platform vs Mobile', createdBy: ownerUserId, organizationId },
      update: {},
    });

    // Not just tidiness: comparison.service.ts's `create` always pairs a
    // Comparison with this grant in the same transaction, because a comparison
    // with no ComparisonAccess row is immediately unreachable through the
    // access-checked routes.
    await tx.comparisonAccess.upsert({
      where: { comparisonId_userId: { comparisonId, userId: ownerUserId } },
      create: { comparisonId, userId: ownerUserId, role: 'OWNER' },
      update: { role: 'OWNER' },
    });

    let comparisonPosition = 0;
    for (const board of dataset.boards) {
      await tx.comparisonMember.upsert({
        where: { comparisonId_boardId: { comparisonId, boardId: board.id } },
        create: {
          id: demoId(`comparison-member:${board.key}`),
          comparisonId,
          boardId: board.id,
          position: comparisonPosition,
        },
        update: { position: comparisonPosition },
      });
      comparisonPosition += 1;
    }

    // ── Board folder, per-user prefs, board/dashboard/roadmap views ─────────────
    const folderId = DEMO_FOLDER_ID;
    await tx.boardFolder.upsert({
      where: { id: folderId },
      create: {
        id: folderId,
        userId: ownerUserId,
        name: 'Northwind Systems (demo)',
        position: 0,
        organizationId,
      },
      update: {},
    });

    let prefPosition = 0;
    for (const board of dataset.boards) {
      await tx.userBoardPref.upsert({
        where: { userId_boardId: { userId: ownerUserId, boardId: board.id } },
        create: {
          id: demoId(`board-pref:${board.key}`),
          userId: ownerUserId,
          boardId: board.id,
          folderId,
          position: prefPosition,
          isFavorite: true,
        },
        update: { folderId, position: prefPosition },
      });
      prefPosition += 1;

      const boardViewId = demoId(`board-view:${board.key}:board`);
      await tx.boardView.upsert({
        where: { id: boardViewId },
        create: { id: boardViewId, boardId: board.id, type: 'BOARD', name: 'Board', position: 0 },
        update: {},
      });

      /**
       * One view per preset, from the REAL definitions in `@deckgauge/shared`.
       *
       * This used to be a hand-written four-widget subset of the Engineering
       * Intelligence preset, described here as "a representative slice". It had
       * drifted to 4 of 26 widgets, and Team Focus was absent altogether — so
       * the seeded demo was missing five sixths of the intelligence surface and
       * a whole view. Applying `ALL_PRESETS` is what makes that class of drift
       * impossible: the coverage guard in that module already fails the build
       * when a catalogued widget type belongs to no preset.
       *
       * `presetKey` IS stamped now, reversing the note that used to be here.
       * That note said omitting it kept `PresetService` from throwing
       * PRESET_ALREADY_APPLIED and permanently blocking the real preset — sound
       * while this view held a subset, and wrong once the view IS the preset.
       * The opt-in banner must not offer to apply what is already there.
       */
      let viewPosition = 1;
      for (const preset of ALL_PRESETS) {
        const viewId = demoId(`board-view:${board.key}:${preset.presetKey}`);
        await tx.boardView.upsert({
          where: { id: viewId },
          create: {
            id: viewId,
            boardId: board.id,
            type: preset.viewType ?? 'DASHBOARD',
            name: preset.viewName,
            position: viewPosition,
            presetKey: preset.presetKey,
          },
          update: { name: preset.viewName, presetKey: preset.presetKey },
        });
        viewPosition += 1;

        for (const widget of preset.widgets) {
          const widgetId = demoId(`widget:${board.key}:${widget.type}`);
          await tx.dashboardWidget.upsert({
            where: { id: widgetId },
            create: {
              id: widgetId,
              boardViewId: viewId,
              widgetType: widget.type,
              title: widget.title,
              config: widget.config as Prisma.InputJsonValue,
              layout: widget.layout as unknown as Prisma.InputJsonValue,
            },
            update: {
              /**
               * MOVES the widget, and that is the whole point of naming it
               * here. Widget ids are `widget:<board>:<TYPE>` and did not change
               * when the view id became `board-view:<board>:<presetKey>`, so on
               * an install seeded by the old code every widget already exists
               * pointing at the OLD view. Without this line the upsert takes
               * its `update` branch and leaves it there: the new Engineering
               * Intelligence view comes up four widgets short (three of them
               * the headline KPI row) beside a surviving, identically-named
               * second tab. `demo/deploy-demo.sh` seeds without `--remove`, so
               * the live public demo is that install.
               */
              boardViewId: viewId,
              /**
               * The other three are just as destructive and just as
               * deliberate: the widget id is DETERMINISTIC, so a re-seed
               * overwrites whatever a board owner retitled, reconfigured or
               * dragged, and resurrects a widget they deleted. That is correct
               * only because these rows are GENERATED — the seeder's contract
               * is that a re-seed converges the demo back onto the preset, and
               * a demo that drifts with one visitor's edits is the thing
               * `demo-reset.ts` prunes nightly. It would be wrong for any row
               * a user is meant to own.
               */
              title: widget.title,
              config: widget.config as Prisma.InputJsonValue,
              layout: widget.layout as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }

      const roadmapViewBoardId = demoId(`board-view:${board.key}:roadmap`);
      await tx.boardView.upsert({
        where: { id: roadmapViewBoardId },
        create: {
          id: roadmapViewBoardId,
          boardId: board.id,
          type: 'ROADMAP',
          name: 'Roadmap',
          position: viewPosition,
        },
        update: { position: viewPosition },
      });
    }

    /**
     * The view id this branch superseded.
     *
     * Before Task 2 the dashboard view was `board-view:<board>:dashboard`; it
     * is now keyed on the preset, so no upsert addresses the old id any more
     * and a stack seeded with it keeps that view forever beside the new one —
     * a second tab with the same name, "Engineering Intelligence".
     *
     * It is EMPTY by the time this runs, and deliberately so. The widget upsert
     * above re-parents every widget onto the preset view (see its `update`
     * branch), so this delete runs AFTER that loop rather than before it: it
     * can then only ever remove a view with nothing on it, and the cascade from
     * `DashboardWidget.boardViewId` cannot take a live widget with it. An empty
     * duplicate tab is the whole defect being fixed here.
     *
     * Deleted by exact id and scoped to this organization, so it can only match
     * the row the demo itself created. On the `--remove` path nothing equivalent
     * is needed: that function deletes the BOARD, and `BoardView.board` is
     * `onDelete: Cascade`, so every view goes with it. See `remove.ts`.
     */
    await tx.boardView.deleteMany({
      where: {
        id: { in: dataset.boards.map((b) => demoId(`board-view:${b.key}:dashboard`)) },
        board: { organizationId },
      },
    });
  }, { timeout: 120_000 });
}
