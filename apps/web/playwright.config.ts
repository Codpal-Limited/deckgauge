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
    baseURL: 'http://localhost:3000',
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
      use: { ...devices['iPhone 13'] },
    },
  ],
});
