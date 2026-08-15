import type { OrgTreeTimesheetConfig, PrismaClient } from '@deckgauge/db';
import { MAX_CONFIG_ROWS } from './page-state-notes.js';

/**
 * `OrgTreeTimesheetConfig` is read by BOTH the timesheet and the org resolver.
 * Reading and shaping it once here is what keeps the two payloads' description
 * of this shared table identical — they previously reported the same rows with
 * different fields (only one of them carried `dailyCapHours`), so the same
 * question answered from two pages could give two different answers.
 */
export interface OrgTreeConfigView {
  orgTreeId: string;
  /**
   * Joined from `OrgTree.name`. Cheap (a required relation on the row already
   * being read) and unambiguous, and it is the only identity in these payloads
   * that can be resolved to something a user would recognise.
   */
  orgTreeName: string;
  activeStatuses: readonly string[];
  countsNothing: boolean;
  /** `null` = engine default of 8h; `0` = UNCAPPED. See `DAILY_CAP_SEMANTICS`. */
  dailyCapHours: number | null;
}

export interface OrgTreeConfigRead {
  overrides: readonly OrgTreeConfigView[];
  truncated: boolean;
}

type ConfigRowWithTree = OrgTreeTimesheetConfig & { orgTree: { name: string } };

/**
 * Reads one row past the cap so "more rows exist" is known without a second
 * `count` query.
 */
export async function readOrgTreeTimesheetConfigs(prisma: PrismaClient): Promise<OrgTreeConfigRead> {
  const rows: ConfigRowWithTree[] = await prisma.orgTreeTimesheetConfig.findMany({
    take: MAX_CONFIG_ROWS + 1,
    include: { orgTree: { select: { name: true } } },
  });
  const shown = rows.slice(0, MAX_CONFIG_ROWS);
  return {
    overrides: shown.map((config) => ({
      orgTreeId: config.orgTreeId,
      orgTreeName: config.orgTree.name,
      activeStatuses: config.activeStatuses,
      // The override is the EXISTENCE of the row, not a non-empty list: an
      // empty `activeStatuses` is a valid, explicit "count nothing" for that
      // tree (`timesheet.service.ts`'s bypass is `!= null`, not a length check).
      countsNothing: config.activeStatuses.length === 0,
      dailyCapHours: config.dailyCapHours,
    })),
    truncated: rows.length > MAX_CONFIG_ROWS,
  };
}

/**
 * `dailyCapHours` is not guessable from its value alone (see the schema comment
 * on `OrgTreeTimesheetConfig.dailyCapHours`): `null` means "use the engine
 * default of 8h" and `0` means UNCAPPED, not "zero hours allowed". Stated in
 * the payload so the model does not invert it, and shared so both resolvers say
 * it identically.
 */
export const DAILY_CAP_SEMANTICS =
  'dailyCapHours is a per-day working-hours cap for that tree: null means the engine falls back to its default of 8 hours, and 0 means UNCAPPED — not zero hours allowed.';

/** What a saved per-tree active-status list does. Shared for the same reason. */
export const ORG_TREE_OVERRIDE_SEMANTICS =
  'A saved active-status list replaces the global timesheet default entirely for that org tree — including an empty list, which explicitly means "count nothing" for that tree (countsNothing: true).';
