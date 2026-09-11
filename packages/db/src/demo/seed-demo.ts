import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../client.js';
import { clickhouse as clickhouseSingleton, type ClickHouseClient } from '../clickhouse.js';
import { isMainModule } from '../esm-main.js';
import { generateDemoDataset, DEFAULT_SEED } from './generate.js';
import { writeDemoToPostgres } from './write-postgres.js';
import { writeDemoToClickHouse } from './write-clickhouse.js';
import {
  removeDemoFromPostgres,
  removeDemoFromClickHouse,
  removedNothing,
  type DemoRemovalCounts,
} from './remove.js';
import { resolveOrganization, resolveOwner } from './resolve-target.js';

export interface SeedDemoOptions {
  remove: boolean;
  org: string | undefined;
  /**
   * Who the seeded content belongs to, by email. Undefined leaves the owner to
   * `resolveOwner`'s earliest-activated-admin inference — right for an install
   * with one admin, and the guess that failed in demo deploy #12 when there
   * were two. `demo/deploy-demo.sh` passes `DEMO_SEED_OWNER_EMAIL`.
   */
  ownerEmail: string | undefined;
  seed: number;
}

export type ParsedSeedDemoArgs =
  | { ok: true; options: SeedDemoOptions }
  | { ok: false; message: string };

/**
 * Parses the CLI's three flags out of an argv slice (no `node`/script path),
 * and REFUSES anything it cannot parse.
 *
 * This is the installer-facing surface, and every silent fallback it used to
 * have was a wrong answer delivered confidently:
 *
 * - `--seed notanumber` became `Number('notanumber')` = `NaN`, then `NaN >>> 0`
 *   = `0` inside mulberry32 — a valid, silently different dataset.
 * - `--org` as the final argument yielded `undefined`, which is indistinguishable
 *   from "no --org given", so an installer who meant to name an organization got
 *   auto-selection instead.
 * - `--org --seed 5` took the literal string `'--seed'` as the slug, and the
 *   refusal that followed named a slug the installer never typed.
 *
 * A flag whose value is missing or malformed is now an error with the fix in it.
 */
export function parseSeedDemoArgs(argv: readonly string[]): ParsedSeedDemoArgs {
  const valueOf = (name: string): { given: false } | { given: true; value: string | undefined } => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return { given: false };
    const next = argv[i + 1];
    // A value that is itself a flag is a missing value, not a value: `--org
    // --seed 5` must refuse rather than seed into an organization called
    // "--seed".
    //
    // So is an EMPTY or whitespace-only one, which used to slip through both
    // checks. On `--owner-email` that was not cosmetic: the empty string skipped
    // the named-owner block in `resolveOwner` and fell through to the inferred
    // earliest admin — deploy #12's mechanism, reached through the very flag
    // added to remove it (round-1 review; reproduced by execution). `--org ""`
    // happened to be caught later by `resolveOrganization`, which was luck
    // rather than design, so this holds for every flag.
    const missing = next === undefined || next.startsWith('--') || next.trim() === '';
    return { given: true, value: missing ? undefined : next };
  };

  const orgArg = valueOf('org');
  if (orgArg.given && orgArg.value === undefined) {
    return { ok: false, message: '--org needs an organization slug, e.g. --org acme.' };
  }

  const ownerArg = valueOf('owner-email');
  if (ownerArg.given && ownerArg.value === undefined) {
    return {
      ok: false,
      message: '--owner-email needs an email, e.g. --owner-email demo-seed@deckgauge.local.',
    };
  }

  const seedArg = valueOf('seed');
  if (seedArg.given && seedArg.value === undefined) {
    return { ok: false, message: '--seed needs an integer, e.g. --seed 20260905.' };
  }
  let seed = DEFAULT_SEED;
  if (seedArg.given && seedArg.value !== undefined) {
    const parsed = Number(seedArg.value);
    if (!Number.isInteger(parsed)) {
      return {
        ok: false,
        message: `--seed must be an integer, not "${seedArg.value}". Example: --seed 20260905.`,
      };
    }
    seed = parsed;
  }

  return {
    ok: true,
    options: {
      remove: argv.includes('--remove'),
      org: orgArg.given ? orgArg.value : undefined,
      ownerEmail: ownerArg.given ? ownerArg.value : undefined,
      seed,
    },
  };
}

export type SeedDemoResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * The whole command, minus process concerns (argv parsing, exit codes,
 * printing) — those live in `main()` below. Takes its dependencies rather than
 * reaching for module-level singletons, so the integration test can pass a
 * real Prisma client bound to this checkout's derived test database and a
 * real ClickHouse client bound to the test stack, without either one being a
 * process-global default this file would otherwise have to fight.
 *
 * Never creates an organization: it queries what exists and refuses if that
 * set is empty or ambiguous. Resolving the organization and its memberships is
 * two sequential queries — the membership query needs the organization id the
 * first one names — but both refusal paths come from `resolve-target.ts`, not
 * from re-deriving a decision here or from matching on either function's
 * message text.
 *
 * `now` is a parameter, defaulted to the wall clock, purely so a test can seed
 * twice at two DIFFERENT clocks — the only way to exercise idempotence across
 * days, which is where the ClickHouse half was not idempotent at all.
 */
export async function seedDemo(
  prisma: PrismaClient,
  ch: ClickHouseClient,
  options: SeedDemoOptions,
  now: Date = new Date(),
): Promise<SeedDemoResult> {
  const organizations = await prisma.organization.findMany({
    select: { id: true, slug: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  const orgResult = resolveOrganization(organizations, options.org);
  if (!orgResult.ok) {
    return { ok: false, message: orgResult.message };
  }
  const { organization } = orgResult;

  const memberships = await prisma.orgMembership.findMany({
    where: { organizationId: organization.id },
    select: { userId: true, email: true, role: true, status: true, activatedAt: true },
  });
  const ownerResult = resolveOwner(memberships, organization, options.ownerEmail);
  if (!ownerResult.ok) {
    return { ok: false, message: ownerResult.message };
  }
  const { ownerUserId } = ownerResult;

  const dataset = generateDemoDataset(now, options.seed);

  if (options.remove) {
    const postgres = await removeDemoFromPostgres(prisma, dataset, organization.id);
    const clickhouseRows = await removeDemoFromClickHouse(ch, dataset, organization.id);
    const counts: DemoRemovalCounts = { ...postgres, clickhouseRows };
    if (removedNothing(counts)) {
      return {
        ok: true,
        message:
          `No demo data found in organization "${organization.slug}" — nothing was removed. ` +
          '(Nothing else was touched either.)',
      };
    }
    return { ok: true, message: `${describeRemoval(counts)}\nNothing else was touched.` };
  }

  // Let write-postgres.ts's pre-flight refusals (claimed by another org, a
  // foreign sync collision) surface with their message intact — no catch,
  // no re-wrap. A caller reading "Cannot seed the demo into organization …"
  // needs that exact sentence, not a vaguer one wrapped around it.
  await writeDemoToPostgres(prisma, dataset, organization.id, ownerUserId);

  // Clear this organization's demo rows before re-writing them, on the SEED
  // path, every time. Postgres is idempotent by construction — every id is a
  // clock-independent UUIDv5 and every write is an upsert — but ClickHouse is
  // not: `jira_transitions` sorts on
  // (organization_id, project_key, issue_key, transitioned_at) with no `id`,
  // and every transition timestamp is derived from `now`. So a second seed on a
  // different DAY lands each row at a new sort key, ReplacingMergeTree appends
  // instead of replacing, and the history the cycle-time, status-dwell and
  // flow-efficiency views read silently doubles. Measured before this line
  // existed: a seed on 2026-09-05 followed by one on 2026-09-06 left 314
  // distinct transition keys with an overlap of four.
  //
  // Deleting first makes the ClickHouse half idempotent by construction rather
  // than by luck, and stays correct for any future table whose sort key is not
  // id-stable — including `jira_flow_efficiency_state`, whose aggregate values
  // would otherwise ADD on every re-seed.
  await removeDemoFromClickHouse(ch, dataset, organization.id);
  await writeDemoToClickHouse(ch, dataset, organization.id);

  const lines = [
    'Demo data seeded:',
    ...dataset.boards.map((board) => `  • ${board.name} — ${board.projects.length} items`),
    `  • Org chart — ${dataset.employees.length} people`,
    '',
    // The per-engineer ranking, the heat strip and the per-employee board list
    // all read `OrgEmployee.statsJson`, which the ORG-TREE SYNC computes by
    // matching the seeded `author_email` values against the tree. The seeder
    // does not fabricate it — that would duplicate the aggregator and go stale
    // the moment anything real is synced — so until the sync runs those three
    // panels render empty while the tree, roles, locations and timesheets are
    // already there.
    '  Next, fill in the per-engineer stats:',
    '    pnpm --filter @deckgauge/worker trigger:org-sync',
    '  (the leaderboard, heat strip and per-employee board list stay empty',
    '  until that sync has run). scripts/test-account.sh already does this.',
    '',
    '  Remove it any time with:  --remove',
  ];
  return { ok: true, message: lines.join('\n') };
}

/** The removal counts as a sentence, naming only what was actually deleted. */
function describeRemoval(counts: DemoRemovalCounts): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(counts.boards, 'board', 'boards');
  add(counts.roadmaps, 'roadmap', 'roadmaps');
  add(counts.comparisons, 'comparison', 'comparisons');
  add(counts.orgTrees, 'org chart', 'org charts');
  add(counts.boardFolders, 'board folder', 'board folders');
  add(counts.timesheetRules, 'timesheet rule', 'timesheet rules');
  // Named separately from the boards because they do NOT ride the board
  // cascade — FocusVerdict has no board FK at all, so an installer reading
  // this line is reading the one number the board count does not already cover.
  add(counts.focusVerdicts, 'focus verdict', 'focus verdicts');
  add(counts.jiraInstances + counts.gitHubInstances, 'demo connection', 'demo connections');
  add(counts.clickhouseRows, 'ClickHouse row', 'ClickHouse rows');
  // Board counts are ROOTS: each one takes its groups, projects, statuses,
  // owners, columns, views and board-source rows with it by cascade, and
  // Prisma does not report those.
  return `Demo data removed: ${parts.join(', ')}.`;
}

async function main(): Promise<void> {
  const parsed = parseSeedDemoArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`✗ ${parsed.message}`);
    process.exitCode = 1;
    return;
  }
  const prisma = createPrismaClient();
  try {
    const result = await seedDemo(prisma, clickhouseSingleton, parsed.options);
    if (result.ok) {
      console.log(`✓ ${result.message}`);
    } else {
      console.error(`✗ ${result.message}`);
      process.exitCode = 1;
    }
  } finally {
    // BOTH clients. Leaving the ClickHouse client open held the process alive
    // past the last line of output — `node …/seed-demo.js` printed its result
    // and then sat there until the socket timed out.
    await prisma.$disconnect();
    await clickhouseSingleton.close();
  }
}

// Only runs when this file is the process entry point — imported by the
// integration test, `main()` never fires; invoked directly (via tsx or the
// compiled dist/demo/seed-demo.js), it does.
if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('✗ Demo seed failed:', error);
    process.exitCode = 1;
  });
}
