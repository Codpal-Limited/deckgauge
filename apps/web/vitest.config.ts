import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  // JSX in this package is transformed by the React plugin, NOT by a bare
  // `esbuild: { jsx: 'automatic' }` as it was before Vitest 4.
  //
  // Two facts have to line up here. `apps/web/tsconfig.json` sets
  // `"jsx": "preserve"`, because Next.js does its own JSX transform in the real
  // build — so nothing in the tsconfig tells a test runner how to compile JSX.
  // And Vitest 4 ships Vite 8, which transforms with Rolldown/OXC instead of
  // esbuild, making the old `esbuild.jsx` option silently inert.
  //
  // Inert, not erroring: every `.tsx` suite failed to PARSE ("Unexpected JSX
  // expression") rather than reporting a config problem. packages/ui was
  // unaffected only because its own tsconfig says `"jsx": "react-jsx"`, which
  // OXC reads and honours.
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Playwright E2E specs (e2e/**) are picked up by `playwright test`, not by
    // vitest. Exclude them here so unit-test runs don't try to load `@playwright/test`.
    exclude: ['e2e/**', '**/node_modules/**', '**/dist/**', '.next/**'],
  },
});
