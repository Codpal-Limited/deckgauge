/**
 * Retrofits the ClickHouse read identity's per-organization role grants onto a
 * deployment whose organizations were provisioned BEFORE that identity existed.
 *
 * Run it once, after setting `CLICKHOUSE_READ_USER` / `CLICKHOUSE_READ_URL` and
 * creating the login, on any deployment that already had organizations. On a
 * fresh install it is unnecessary and harmless: `provisionOrganizationAnalytics`
 * grants the role as part of creating the organization, so every grant is already
 * held and the pass only re-asserts `DEFAULT ROLE NONE`.
 *
 *   docker compose run --rm api pnpm --filter @deckgauge/db ch:retrofit-read-identity
 *
 * **Run it through compose, not on the host.** The organization list comes from
 * Postgres and the DDL goes to ClickHouse, so the process needs `DATABASE_URL`,
 * `CLICKHOUSE_URL` and `CLICKHOUSE_READ_URL` — and on a hosted box those live in
 * `deploy/.env.hosted`, which `deploy/deploy-hosted.sh` deliberately never sources
 * into the shell. A bare host invocation therefore inherits none of them, resolves
 * no read identity, and would report that there was nothing to do. That is the
 * exact silence this script exists to remove, so it now EXITS NON-ZERO rather than
 * reporting success: see the `readIdentity === undefined` branch below.
 *
 * Exit codes: 0 only when a read identity was found AND every organization's
 * predicates are in place. 1 when no read identity resolved (operator error), and
 * 1 when the grants landed but some tenant object has no per-organization policy —
 * because that object still reads empty, and a deliberately-invoked repair must not
 * report "done" while it does.
 *
 * It writes nothing to Postgres — the read is `SELECT id FROM organizations`.
 *
 * The decision logic lives in `retrofitReadIdentityGrants`
 * (`packages/db/src/ch-provisioning.ts`) and is tested there against a fake
 * executor and a real container. This file is wiring and reporting only, which is
 * why it carries no logic worth testing and no branch that decides anything.
 */
import { PrismaClient } from '@prisma/client';
import { chExecutorFromClient, retrofitReadIdentityGrants } from '../ch-provisioning.js';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  // Imported inside main(), for the reason ChStatementExecutor exists at all:
  // clickhouse.ts builds its client at import time with a hard-coded fallback of
  // localhost:8123 — the staging server — so a top-level import would build a
  // client pointed at real data the moment anything imports this file, including
  // a test that only wanted the exported wiring.
  const { clickhouse } = await import('../clickhouse.js');
  try {
    const organizations = await prisma.organization.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    if (organizations.length === 0) {
      console.log('No organizations on this deployment — nothing to retrofit.');
      return;
    }
    const names = new Map(organizations.map((o) => [o.id, o.name]));
    console.log(`Retrofitting read-identity grants for ${organizations.length} organization(s).`);

    const report = await retrofitReadIdentityGrants(
      chExecutorFromClient(clickhouse),
      organizations.map((o) => o.id),
    );

    if (report.readIdentity === undefined) {
      // The LIBRARY treats an unset read identity as a legitimate state, and that
      // is right: a deployment that has not split its read path has no reader to
      // grant anything to. But this SCRIPT was invoked deliberately, by someone
      // repairing that split, so finding no reader is operator error — most often
      // a bare host invocation that inherited none of the container's environment.
      // Exiting 0 here would reproduce, one layer out, the precise failure the
      // retrofit exists to remove: a reassuring message over empty dashboards.
      console.error(
        '✗ No ClickHouse API read identity is configured (CLICKHOUSE_READ_USER / ' +
          'CLICKHOUSE_READ_URL), so NOTHING was done. Reads still run through the ingest ' +
          'identity and span every organization.\n' +
          '  If you meant to split the read path: create the login with no row policy of its ' +
          'own, set CLICKHOUSE_READ_URL, and re-run.\n' +
          '  If you ran this on the host: the variables live in deploy/.env.hosted, which the ' +
          'deploy script never sources. Run it in the container instead:\n' +
          '    docker compose run --rm api pnpm --filter @deckgauge/db ch:retrofit-read-identity',
      );
      process.exitCode = 1;
      return;
    }

    for (const id of report.granted) {
      console.log(`  ✓ granted org_${id} to '${report.readIdentity}' (${names.get(id) ?? '?'})`);
    }
    for (const id of report.alreadyHeld) {
      console.log(`  • org_${id} already granted (${names.get(id) ?? '?'})`);
    }
    console.log(
      `  ✓ '${report.readIdentity}' DEFAULT ROLE NONE re-asserted; ` +
        `default_roles_all=${report.defaultRolesAll} (must be 0 — no role, no rows)`,
    );
    if (report.unpolicied.length > 0) {
      // The grants DID land, and they were correct — withholding them would have
      // left the deployment strictly worse. But a role with missing predicates
      // reads empty on those objects with every guard passing, so this is not
      // "done". Its remedy is the heavier pass, which now has a command.
      console.error(
        `✗ grants applied, but ${report.unpolicied.length} organization(s) are MISSING ` +
          `per-organization row policies, so those objects read empty for them:`,
      );
      for (const gap of report.unpolicied) {
        console.error(
          `    ${gap.organizationId}: ${gap.objects.join(', ')} (${names.get(gap.organizationId) ?? '?'})`,
        );
      }
      console.error(
        `  This is what a ClickHouse migration that added a tenant table leaves behind — the ` +
          `baseline denies the new object and only provisioning writes the predicates. Repair:\n` +
          `    docker compose run --rm api pnpm --filter @deckgauge/db ch:reprovision-organizations`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Done. ${report.granted.length} granted, ${report.alreadyHeld.length} already held, ` +
        `${report.statements} statement(s).`,
    );
  } finally {
    await prisma.$disconnect();
    await clickhouse.close();
  }
}

// Guarded so importing this module never triggers a live run against a real
// ClickHouse — only executing the file directly does.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
