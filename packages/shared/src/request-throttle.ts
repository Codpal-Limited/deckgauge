// Shared client-side request throttle for upstream APIs whose limit is not a
// simple observable request counter.
//
// Azure DevOps bills a caller in "throughput units" over a sliding window and
// starts DELAYING requests once the account exceeds its share — the account we
// sync with was pushed over that line by ~4-8k requests per cycle running
// continuously. Unlike GitHub there is no reliable remaining-quota header to
// steer by, so the useful controls are (a) spacing requests out, (b) a hard
// ceiling per window as a backstop, and (c) obeying an explicit throttle signal
// when the server does send one.
//
// Deliberately NOT modelled on github-rate-limiter's token budget: that one
// mirrors GitHub's documented 5000/hour allowance, which ADO has no analogue of.

/**
 * The narrow contract adapters depend on, so they need no knowledge of how the
 * pacing is implemented (or whether it is present at all).
 */
export interface Throttle {
  /** Wait until it is this caller's turn to issue one request. */
  acquire(): Promise<void>;
  /** Record an upstream instruction to back off for `ms`. */
  backOff(ms: number): void;
}

export interface RequestThrottleOpts {
  /** Minimum gap between two requests, in ms. 0/undefined disables spacing. */
  minIntervalMs?: number;
  /** Hard ceiling on requests per `windowMs`. Undefined disables the ceiling. */
  maxPerWindow?: number;
  /** Length of the budget window in ms. Defaults to 5 minutes (ADO's window). */
  windowMs?: number;
}

/** Injectable clock so the behaviour is testable without real waiting. */
export interface ThrottleClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

const realClock: ThrottleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RequestThrottle implements Throttle {
  private lastRequestAt = 0;
  private windowStartedAt: number;
  private usedInWindow = 0;
  private pauseUntil = 0;

  constructor(
    private readonly opts: RequestThrottleOpts,
    private readonly clock: ThrottleClock = realClock,
  ) {
    this.windowStartedAt = clock.now();
  }

  /**
   * Wait until it is this caller's turn to issue one request. Call immediately
   * before each upstream request.
   */
  async acquire(): Promise<void> {
    // An explicit server-side backoff outranks our own pacing.
    const pauseMs = this.pauseUntil - this.clock.now();
    if (pauseMs > 0) {
      await this.clock.sleep(pauseMs);
      this.pauseUntil = 0;
    }

    const { maxPerWindow } = this.opts;
    if (maxPerWindow !== undefined) {
      const windowMs = this.opts.windowMs ?? DEFAULT_WINDOW_MS;
      this.rollWindowIfElapsed(windowMs);
      if (this.usedInWindow >= maxPerWindow) {
        const waitMs = Math.max(0, this.windowStartedAt + windowMs - this.clock.now());
        if (waitMs > 0) await this.clock.sleep(waitMs);
        this.rollWindowIfElapsed(windowMs);
      }
    }

    const minIntervalMs = this.opts.minIntervalMs ?? 0;
    if (minIntervalMs > 0 && this.lastRequestAt > 0) {
      const elapsed = this.clock.now() - this.lastRequestAt;
      const remaining = minIntervalMs - elapsed;
      if (remaining > 0) await this.clock.sleep(remaining);
    }

    this.lastRequestAt = this.clock.now();
    this.usedInWindow++;
  }

  /**
   * Record that the upstream asked us to back off for `ms` (e.g. a 429 with
   * `Retry-After`). Every caller sharing this throttle waits it out, so one
   * queue's throttling slows the others that spend the same account budget.
   */
  backOff(ms: number): void {
    if (ms <= 0) return;
    this.pauseUntil = Math.max(this.pauseUntil, this.clock.now() + ms);
  }

  snapshot(): {
    usedInWindow: number;
    maxPerWindow: number | null;
    pausedForMs: number;
  } {
    return {
      usedInWindow: this.usedInWindow,
      maxPerWindow: this.opts.maxPerWindow ?? null,
      pausedForMs: Math.max(0, this.pauseUntil - this.clock.now()),
    };
  }

  private rollWindowIfElapsed(windowMs: number): void {
    if (this.clock.now() - this.windowStartedAt >= windowMs) {
      this.windowStartedAt = this.clock.now();
      this.usedInWindow = 0;
    }
  }
}
