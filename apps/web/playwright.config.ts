import { defineConfig, devices } from '@playwright/test';

// Minimal Playwright config for Deckgauge web E2E smoke tests.
//
// NOTE: no `webServer` block on purpose. The development stack
// (Next.js :3000, Fastify API :3001, Postgres, Redis, Keycloak) is
// normally brought up out-of-band via `pnpm dev` + `docker compose up -d`.
// Specs assume the stack is already running. If/when CI needs a one-shot
// boot, re-introduce a `webServer` entry here.

export default defineConfig({
  testDir: './e2e',
  // Vitest owns `*.test.ts`/`*.test.tsx` everywhere else in this repo, so
  // Playwright is restricted to `e2e/*.spec.ts` to avoid loading Vitest specs.
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    // Overridable so the suite can be pointed at the local staging stack
    // (web is published on :3100 there, not :3000) without editing a tracked
    // file. Defaults to the dev server, which is what `pnpm dev` serves.
    baseURL: process.env.DECKGAUGE_E2E_BASE_URL ?? 'http://localhost:3000',
    // An authenticated session, if one has been captured. Playwright launches a
    // CLEAN browser profile, so being logged in to the app in your own browser
    // does NOT carry over — without this every board-dependent spec skips.
    //
    // Capture one (you log in by hand; no credential passes through the repo):
    //   pnpm --filter @deckgauge/web exec playwright codegen \
    //     http://localhost:3000 --save-storage=/tmp/dg-auth.json
    // then run with:
    //   DECKGAUGE_E2E_STORAGE_STATE=/tmp/dg-auth.json \
    //     pnpm --filter @deckgauge/web exec playwright test --project=mobile
    //
    // Keep the file OUT of the repo: it is a live session token. `/tmp` is the
    // suggestion for exactly that reason.
    storageState: process.env.DECKGAUGE_E2E_STORAGE_STATE || undefined,
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Mobile verification project (mobile-responsive plan, Slice 1).
      // `iPhone 13` is a 390x664 viewport with `isMobile` and touch enabled --
      // 390px is the width the plan measures every surface against. Same
      // `testDir` and `testMatch` as `chromium`: select it with
      // `--project=mobile`.
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        // `devices['iPhone 13']` sets `defaultBrowserType: 'webkit'`, and this
        // project was NEVER RUNNABLE here as a result: only Chromium is
        // installed, so every invocation died on a missing webkit binary. It
        // was added in Slice 1 and the failure was never seen, because nothing
        // ran it.
        //
        // Pinned to Chromium rather than installing webkit, because the touch
        // spec needs `Input.dispatchTouchEvent` over CDP — Chromium-only — and
        // that is the only way to produce a real touch swipe with NATIVE
        // scrolling. Playwright's `Touchscreen` offers `tap()` alone, and
        // synthetic DOM touch events do not scroll the page, so under webkit
        // the central "a swipe scrolls instead of dragging" assertion cannot be
        // written at all.
        //
        // What this therefore does NOT cover: real iOS Safari. That matters
        // here specifically, because `TouchSensor.setup()` installs a
        // non-passive `touchmove` listener the library marks as required for
        // iOS Safari. A webkit project would cover it and is worth adding —
        // filed rather than done, since it needs a browser install and a
        // different gesture mechanism.
        defaultBrowserType: 'chromium',
        browserName: 'chromium',
      },
    },
  ],
});
