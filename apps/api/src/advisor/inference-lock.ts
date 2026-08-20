/**
 * FIFO mutex serialising Advisor inference for this process.
 *
 * `OLLAMA_NUM_PARALLEL=1` bounds the inference *server*; this bounds the queue in
 * front of it. Without it a second concurrent question holds a connection open
 * and both users wait past any timeout — on a 4-core box two concurrent questions
 * is not "twice as slow", it is two failures (spec §5.1, LIMIT 1).
 *
 * Scope is this process. The api runs as a single container, so that is box-wide
 * today. **If the api is ever scaled beyond one replica this becomes
 * insufficient** and needs a shared lock; Redis is already a dependency.
 */
export function createInferenceLock(): { run<T>(fn: () => Promise<T>): Promise<T> } {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      // Chain onto the tail, running `fn` on both settle paths so a predecessor's
      // rejection cannot wedge the queue for everyone behind it.
      const result = tail.then(fn, fn);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/**
 * The process-wide lock. A module singleton, deliberately: the board and help
 * advisors live in separate Fastify plugins, so a per-plugin lock would let one
 * board question and one help question run concurrently — which is the exact
 * thing being prevented.
 */
export const inferenceLock = createInferenceLock();
