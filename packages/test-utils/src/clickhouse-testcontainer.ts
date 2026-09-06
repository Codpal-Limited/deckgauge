import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createClient, type ClickHouseClient } from '@clickhouse/client';

export interface ClickHouseTestContainer {
  url: string;
  client: ClickHouseClient;
  stop(): Promise<void>;
}

export interface StartOpts {
  schemaDir?: string;
  image?: string;
  port?: number;
  /** Enables CREATE ROLE / CREATE ROW POLICY. Off by default: it changes the
   *  server's user setup, and only the tenancy-policy tests need it. */
  accessManagement?: boolean;
}

const PORT_RANGE_START = 18_000;
const PORT_RANGE_SIZE = 2_000;
const PORT_ATTEMPTS = 50;

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

/**
 * A published port the host can actually reach.
 *
 * This used to return `49152 + random(16383)`, the OS ephemeral range, where a
 * concurrent run could collide with a port the OS was about to hand out. Below
 * that range plus a bind check removes the collision.
 *
 * Note for anyone chasing a readiness timeout: the ephemeral range was NOT the
 * cause of the 30s `waitForReady` failures once blamed on it. Those were
 * reproduced on 18000-range ports too, and one of them answered `Ok.` 3–6
 * seconds *after* the timeout fired — the real cause is ClickHouse boot latency
 * on a memory-tight host, which is why READY_TIMEOUT_MS is generous.
 */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const candidate = PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SIZE);
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(
    `No free port found in ${PORT_RANGE_START}-${PORT_RANGE_START + PORT_RANGE_SIZE - 1} for the ClickHouse test container`,
  );
}

/**
 * ClickHouse can take well over 30s to accept connections when the host is
 * short of memory — verified by a container answering `Ok.` seconds after a 30s
 * probe had already given up and failed the run.
 */
const READY_TIMEOUT_MS = 120_000;

async function waitForReady(url: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const resp = await fetch(`${url}/ping`);
      if (resp.ok) return;
    } catch { /* swallow until timeout */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`ClickHouse container did not become ready within ${timeoutMs}ms`);
}

export function hasDocker(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'pipe' });
  return r.status === 0;
}

export async function startClickHouseContainer(opts: StartOpts = {}): Promise<ClickHouseTestContainer> {
  // Pinned to the version docker-compose.yml runs, so tests exercise what
  // production exercises. CLICKHOUSE_TEST_IMAGE overrides it, which is how a
  // version upgrade gets validated: point this suite at the candidate image and
  // run it, rather than upgrading staging and finding out there. This codebase
  // already carries two version-specific ClickHouse behaviours (the
  // async_insert/deduplicate_blocks_in_dependent_materialized_views conflict,
  // Code 344; and FINAL parsing), so "it is only a minor bump" is not a safe
  // assumption here.
  //
  // 24.8 is a floor, not a preference. The per-query `role` request parameter
  // that scopes every organization's read (design doc D3) does not exist before
  // it — on 24.3 `?role=` fails with `Code 115`, so a test suite running on the
  // older image would pass while proving nothing about isolation. This default
  // must therefore stay in step with `docker-compose.yml` and
  // `docker-compose.test.yml`; a test image older than production is how a
  // version-specific behaviour hides.
  const image =
    opts.image ?? process.env.CLICKHOUSE_TEST_IMAGE ?? 'clickhouse/clickhouse-server:25.8-alpine';
  const port = opts.port ?? (await freePort());
  const name = `vpc-ch-test-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

  spawnSync('docker', ['pull', '--quiet', image], { stdio: 'pipe' });

  const run = spawnSync('docker', [
    'run', '--rm', '-d',
    '--name', name,
    '-p', `${port}:8123`,
    '--ulimit', 'nofile=262144:262144',
    '-e', 'CLICKHOUSE_SKIP_USER_SETUP=1',
    ...(opts.accessManagement ? ['-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1'] : []),
    image,
  ], { encoding: 'utf-8' });
  if (run.status !== 0) {
    throw new Error(`docker run failed: ${run.stderr}`);
  }

  const url = `http://localhost:${port}`;

  // `--rm` only fires when the container stops, so anything that throws between
  // `docker run` and the caller getting a `stop()` handle would leak a running
  // container — and on a memory-tight host those orphans make the next start
  // slower still, which is the very failure this used to be blamed on.
  let client: ClickHouseClient;
  try {
    await waitForReady(url);

    client = createClient({ url, database: 'default' });
    await client.command({ query: `CREATE DATABASE IF NOT EXISTS cockpit` });

    if (opts.schemaDir) {
      const files = readdirSync(opts.schemaDir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) {
        const sql = readFileSync(join(opts.schemaDir, f), 'utf-8');
        const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
        for (const stmt of statements) {
          try {
            await client.command({ query: stmt });
          } catch (e) {
            // Some statements are CREATE TABLE IF NOT EXISTS — re-runs are safe. Re-throw on real errors.
            if (!String(e).match(/already exists|TABLE_ALREADY_EXISTS/i)) throw e;
          }
        }
      }
    }
  } catch (e) {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'pipe' });
    throw e;
  }

  return {
    url,
    client,
    async stop() {
      await client.close();
      spawnSync('docker', ['stop', name], { stdio: 'pipe' });
    },
  };
}
