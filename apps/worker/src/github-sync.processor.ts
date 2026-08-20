import { PrismaClient } from '@deckgauge/db';
import { GitHubPort, GitHubProjectsPort } from '@deckgauge/shared';
import { githubRowKey } from './org-tree-sync/row-keys.js';
import {
  GitHubPromoteService,
  type PromoteGitHubIssue,
  type PromoteGitHubMilestone,
} from './github-promote.service.js';
import {
  type ChClient,
  mapGitHubToClickHouseRows,
  writeGitHubBasicToClickHouse,
} from './github-dual-writer.js';

interface ProcessorInput {
  adapter: GitHubPort;
  projectsAdapter?: GitHubProjectsPort;
  repos: string[];
  trigger: string;
  db: PrismaClient;
  /**
   * Optional ClickHouse client. When provided, the processor dual-writes the
   * full unfiltered set of fetched issues + milestones into the `github_issues`
   * and `github_milestones` CH tables BEFORE running promote/Postgres upserts.
   * Thin shape — PR/commit/review data is written by
   * github-intelligence-sync.handler against the same ReplacingMergeTree
   * tables. Omitted in tests that don't care about CH coverage so the call
   * site stays backward-compatible.
   */
  ch?: ChClient;
}

interface ProcessorOutput {
  status: string;
  trigger: string;
  milestoneCount: number;
  issueCount: number;
  finishedAt: Date | null;
  errorMessage: string | null;
}

export async function githubSyncProcessor(input: ProcessorInput): Promise<ProcessorOutput> {
  const { adapter, repos, trigger, db, ch } = input;

  const syncRun = await db.syncRun.create({
    data: {
      status: 'PENDING',
      trigger: normalizeTrigger(trigger),
      startedAt: new Date(),
      source: 'github',
    },
  });

  try {
    let totalMilestones = 0;
    let totalIssues = 0;
    const issuesByRepo: Record<string, PromoteGitHubIssue[]> = {};
    const milestonesByRepo: Record<string, PromoteGitHubMilestone[]> = {};

    // Build repo→projectNodeId map once per invocation. New model:
    // BoardGitHubSource → GitHubRepoSync (1 repo sync per instance+repo,
    // N board sources fan out). projectNodeId is optional and may live on
    // GitHubRepoSync after the legacy GitHubSyncConfig retires.
    const boardSources = await db.boardGitHubSource.findMany({
      include: { gitHubRepoSync: true },
    });
    const projectConfigByRepo = new Map<string, { projectNodeId: string }>();
    for (const bs of boardSources) {
      const rs = bs.gitHubRepoSync;
      const projectNodeId = (rs as { projectNodeId?: string | null }).projectNodeId ?? null;
      if (rs && projectNodeId) {
        projectConfigByRepo.set(rs.repoFullName, { projectNodeId });
      }
    }

    for (const repo of repos) {
      const projectCfg = projectConfigByRepo.get(repo);
      if (projectCfg && input.projectsAdapter) {
        // Project-mode: use GraphQL Projects v2 adapter
        console.log(`[GitHub Processor] Project-mode for ${repo} (projectNodeId: ${projectCfg.projectNodeId})`);
        const milestones = await adapter.fetchMilestones(repo);

        // P4.5 dual-write (project-mode milestones only — issues come from
        // projectsAdapter.fetchProjectItems below in a different shape).
        if (ch && milestones.length > 0) {
          const { milestoneRows } = mapGitHubToClickHouseRows({
            issues: [],
            milestones,
          });
          await writeGitHubBasicToClickHouse(ch, {
            issues: [],
            milestones: milestoneRows,
          });
        }

        // Accumulate milestones for the promote service (was upserting to
        // dropped github_milestones table).
        const milestoneAcc = milestonesByRepo[repo] ?? [];
        for (const milestone of milestones) {
          if (!milestoneAcc.some((m) => m.id === milestone.id)) milestoneAcc.push(milestone);
        }
        milestonesByRepo[repo] = milestoneAcc;
        totalMilestones += milestones.length;

        const projectItems = await input.projectsAdapter.fetchProjectItems(projectCfg.projectNodeId);
        console.log(`[GitHub Processor] Project-mode for ${repo}: ${projectItems.length} items`);

        // Accumulate project-mode issues for the promote service.
        const projIssueAcc = issuesByRepo[repo] ?? [];
        for (const item of projectItems) {
          if (!item.issue) continue; // skip drafts / non-issues
          // Shared builder: org-tree sync joins this id back to ClickHouse activity,
          // and a silent divergence there costs every assignment its board chip.
          const id = githubRowKey(item.issue.repoFullName, item.issue.number);
          if (!projIssueAcc.some((e) => e.id === id)) {
            projIssueAcc.push({
              id,
              repoFullName: item.issue.repoFullName,
              number: item.issue.number,
              title: item.issue.title,
              body: item.issue.body ?? null,
              state: item.issue.state,
              assigneeLogin: item.issue.assigneeLogin ?? null,
              labels: item.issue.labels,
              type: item.issue.type ?? null,
              milestoneId: null,
              projectItemId: item.itemId,
              projectStatusName: item.statusName,
              updatedAt: item.issue.updatedAt,
            });
            totalIssues += 1;
          }
        }
        issuesByRepo[repo] = projIssueAcc;
      } else {
        // State-mode: use REST adapter (unchanged behaviour)
        console.log(`[GitHub Processor] Fetching milestones and issues for: ${repo}`);
        const [milestones, issues] = await Promise.all([
          adapter.fetchMilestones(repo),
          adapter.fetchIssues(repo),
        ]);
        console.log(
          `[GitHub Processor] Fetched ${milestones.length} milestones, ${issues.length} issues for ${repo}`,
        );

        // P4.5 dual-write: push the unfiltered fetch into ClickHouse before any
        // Postgres-side filters apply. The basic GitHubPort doesn't carry PRs,
        // reviews, or commits — github-intelligence-sync.handler covers those
        // separately against the same ReplacingMergeTree tables. See
        // planning/STORAGE-SPLIT.md.
        if (ch) {
          const { issueRows, milestoneRows } = mapGitHubToClickHouseRows({
            issues,
            milestones,
          });
          await writeGitHubBasicToClickHouse(ch, {
            issues: issueRows,
            milestones: milestoneRows,
          });
        }

        // Accumulate milestones + issues for the promote service (was
        // upserting to dropped github_milestones / github_issues tables).
        const stateMilestoneAcc = milestonesByRepo[repo] ?? [];
        for (const m of milestones) {
          if (!stateMilestoneAcc.some((e) => e.id === m.id)) stateMilestoneAcc.push(m);
        }
        milestonesByRepo[repo] = stateMilestoneAcc;
        totalMilestones += milestones.length;

        const stateIssueAcc = issuesByRepo[repo] ?? [];
        for (const issue of issues) {
          if (!stateIssueAcc.some((e) => e.id === issue.id)) {
            stateIssueAcc.push({
              id: issue.id,
              repoFullName: issue.repoFullName,
              number: issue.number,
              title: issue.title,
              body: issue.body ?? null,
              state: issue.state,
              assigneeLogin: issue.assigneeLogin ?? null,
              labels: issue.labels,
              type: issue.type ?? null,
              milestoneId: issue.milestoneId ?? null,
              updatedAt: issue.updatedAt,
            });
          }
        }
        issuesByRepo[repo] = stateIssueAcc;
        totalIssues += issues.length;
      }
    }

    // Promote GitHub issues to Project rows
    const promoteService = new GitHubPromoteService(db);
    const promoteResult = await promoteService.promoteAll({ issuesByRepo, milestonesByRepo });
    console.log(
      `[GitHub Processor] Promote: ${promoteResult.created} created, ${promoteResult.updated} updated, ${promoteResult.markedRemoved} marked removed`,
    );

    const updated = await db.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        epicCount: totalMilestones,
        issueCount: totalIssues,
      },
    });

    return {
      status: updated.status,
      trigger: updated.trigger,
      milestoneCount: updated.epicCount,
      issueCount: updated.issueCount,
      finishedAt: updated.finishedAt,
      errorMessage: updated.errorMessage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const updated = await db.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage,
      },
    });

    return {
      status: updated.status,
      trigger: updated.trigger,
      milestoneCount: updated.epicCount,
      issueCount: updated.issueCount,
      finishedAt: updated.finishedAt,
      errorMessage: updated.errorMessage,
    };
  }
}

function normalizeTrigger(trigger: string): 'STARTUP' | 'MANUAL' | 'SCHEDULED' {
  const normalized = trigger.toUpperCase();
  if (normalized === 'STARTUP') return 'STARTUP';
  if (normalized === 'MANUAL') return 'MANUAL';
  if (normalized === 'SCHEDULED') return 'SCHEDULED';
  throw new Error(`Unknown trigger: ${trigger}`);
}
