import type { WorkerEditionModule } from './edition-loader.js';

/**
 * Drives an edition's periodic background work on an interval.
 *
 * Lives in the worker rather than the edition module because the worker is already
 * the long-running process — an interval inside a request-serving API would run
 * once per replica, and this work must run once.
 *
 * Community has no periodic work, so no timer is created at all: the free product
 * has nothing to run, not a disabled schedule.
 */

/** Hourly. Frequent enough to catch a dropped webhook well inside any grace window. */
const DEFAULT_INTERVAL_MS = 3_600_000;

export function startPeriodicWork(
  edition: WorkerEditionModule | null,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  log: (message: string) => void = console.warn,
): (() => void) | null {
  if (!edition?.runPeriodicWork) return null;

  // Guards against overlap: the work walks every stale tenant, so a slow run must
  // not be joined by the next tick — two copies would double the outbound calls
  // and could apply their results out of order.
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void edition
      .runPeriodicWork!()
      .catch((err: unknown) => {
        // Caught, never rethrown. An unhandled rejection inside a timer would end
        // the schedule for the life of the process, so one outage would silently
        // stop all future runs.
        log(`[edition] periodic work failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // Unref'd so it never holds the process open on its own — shutdown stays driven
  // by the queues, as before.
  timer.unref?.();

  return () => clearInterval(timer);
}
