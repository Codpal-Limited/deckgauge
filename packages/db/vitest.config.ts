import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from root directory
dotenv.config({
  path: path.resolve(__dirname, '../../.env'),
});

export default defineConfig({
  test: {
    environment: 'node',

    // Several suites here start a real ClickHouse container
    // (startClickHouseContainer). Run test FILES one at a time.
    //
    // Run in parallel they contend for memory on a developer machine and fail
    // in ways that look like product bugs rather than resource starvation:
    // observed on this host as `Test timed out in 5000ms` plus
    // `Table cockpit.jira_issues__v2 is dropped or detached`, with the same 7
    // files passing 76/76 immediately afterwards under --no-file-parallelism.
    // The convergence suite alone starts two containers sequentially, so
    // parallel files can mean three or more servers at once.
    //
    // Correctness does not depend on this — isolation does not come from test
    // ordering — but a suite that is only green when invoked with an extra flag
    // is a suite people will believe is broken.
    fileParallelism: false,

    // Container startup dominates these tests; the 5s default expires while a
    // server is still booting.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
