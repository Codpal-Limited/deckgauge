/**
 * PUBLIC runtime loader for the open-core seam, worker side. Ships open-source.
 *
 * A near-copy of apps/api/src/enterprise-loader.ts rather than a shared import,
 * and deliberately so: the loader's whole purpose is that no app declares a
 * dependency on the private package, and apps/worker importing from apps/api would
 * couple two independently-built apps to make a ~15-line function shared. See
 * planning/OPEN-CORE-ARCHITECTURE.md §4.
 *
 * Absent module, wrong edition, or a failed load → null → the worker runs exactly
 * as the free product does.
 */

/** The only parts of the edition contract the worker uses. */
export interface WorkerEditionModule {
  /**
   * Whether an organization may ingest new data. Absent means always allowed,
   * which is the Community behaviour.
   */
  allowIngest?(organizationId: string): Promise<boolean>;
  /**
   * Periodic background work. Generic by design: the worker knows only that an
   * edition may have some, never what it is. Absent in Community.
   */
  runPeriodicWork?(): Promise<void>;
}

export async function loadEdition(): Promise<WorkerEditionModule | null> {
  if (process.env.DECKGAUGE_EDITION !== 'enterprise') return null;

  // Resolve by explicit path only. Bare-specifier resolution is intentionally NOT
  // attempted — apps must not depend on the private package, or the community
  // snapshot becomes uninstallable.
  const modulePath = process.env.DECKGAUGE_ENTERPRISE_MODULE;
  if (!modulePath) return null;

  try {
    const mod = (await import(modulePath)) as {
      createEnterprise?: () => WorkerEditionModule;
    };
    if (typeof mod.createEnterprise !== 'function') return null;
    return mod.createEnterprise();
  } catch (err) {
    console.warn('[edition] enterprise requested but module failed to load; running Community.', err);
    return null;
  }
}
