import type { PrismaClient } from '@deckgauge/db';

export interface OrgTreeTimesheetConfigValue {
  activeStatuses: string[];
  /** Per-day working-hours cap. null = use the engine default (8h); 0 = uncapped. */
  dailyCapHours: number | null;
}

/** Per-org-tree timesheet config (Postgres). One row per tree. */
export class OrgTreeTimesheetConfigService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Returns the saved config, or null when the tree has no config row (unconfigured → fallback). */
  async get(orgTreeId: string): Promise<OrgTreeTimesheetConfigValue | null> {
    const row = await this.prisma.orgTreeTimesheetConfig.findUnique({ where: { orgTreeId } });
    return row ? { activeStatuses: row.activeStatuses, dailyCapHours: row.dailyCapHours } : null;
  }

  /**
   * Write ONLY the fields given, and CREATE the row only when a status list is
   * among them.
   *
   * Two writers own disjoint fields — the Time rules drawer derives
   * `activeStatuses`, the settings page owns `dailyCapHours` — so naming a
   * field you do not own overwrites the other writer's work. That is why the
   * value is a `Partial`.
   *
   * The create asymmetry is the part that matters, and it is not tidiness. The
   * row's EXISTENCE is the timesheet override, not its contents:
   * `loadOrgTreeActiveStatuses` answers `cfg ? cfg.activeStatuses : null` and
   * `computeTimesheet` branches on `!= null`, so a row created without a status
   * list gets the column's `@default([])` and becomes `Set([])` with
   * `useCategoryFallback: false` — every span fails `spanIsInProgress` and the
   * whole tree reads ZERO hours, with the per-role/per-employee rules bypassed
   * rather than fallen back to. A cap-only save must therefore never bring the
   * row into being; it answers `null` and the route turns that into a 409.
   *
   * A status list MAY create it, including `[]`, which is an explicit "count
   * nothing" and the one thing that empty list is allowed to mean.
   *
   * Prisma cannot make a scalar list nullable, so there is no "no decision yet"
   * value to store and the guard has to live here rather than in the schema.
   */
  async put(
    orgTreeId: string,
    value: Partial<OrgTreeTimesheetConfigValue>,
  ): Promise<OrgTreeTimesheetConfigValue | null> {
    const patch = {
      ...(value.activeStatuses !== undefined ? { activeStatuses: value.activeStatuses } : {}),
      ...(value.dailyCapHours !== undefined ? { dailyCapHours: value.dailyCapHours } : {}),
    };

    if (value.activeStatuses === undefined) {
      // `orgTreeId` is the primary key, so this touches one row or none — and
      // none is reported rather than silently succeeding.
      const { count } = await this.prisma.orgTreeTimesheetConfig.updateMany({
        where: { orgTreeId },
        data: patch,
      });
      if (count === 0) return null;
      // A second statement, so the returned row is read after the write rather
      // than echoed from the patch — which is what makes it the PERSISTED value.
      // Two residuals, both accepted: a concurrent bucket save landing between
      // the two makes the response's `activeStatuses` slightly stale (it can
      // never make the WRITE wrong, and the only caller discards the DTO); and
      // if the row is cascade-deleted in that window this answers `null`, which
      // the route reports as "set Time rules first" — misleading, but it takes a
      // tree deletion mid-request.
      return this.get(orgTreeId);
    }

    const row = await this.prisma.orgTreeTimesheetConfig.upsert({
      where: { orgTreeId },
      // `dailyCapHours` is absent from `patch` unless the caller sent it, and it
      // is nullable, so the schema supplies the default rather than a literal
      // here being a second place it is decided.
      create: { orgTreeId, ...patch },
      update: patch,
    });
    return { activeStatuses: row.activeStatuses, dailyCapHours: row.dailyCapHours };
  }
}
