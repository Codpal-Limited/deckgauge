/**
 * Re-provisions every organization's ClickHouse identity: the row-policy
 * baseline, then each organization's role, SELECT grant, per-object `iso_`
 * predicates, and the read identity's grant of that role.
 *
 *   pnpm --filter @deckgauge/db ch:reprovision-organizations
 *
 * In a deployed stack the process needs the container's environment, so run it
 * through compose rather than on the host:
 *
 *   docker compose run --rm api pnpm --filter @deckgauge/db ch:reprovision-organizations
 *
 * **Why this script exists.** `reprovisionOrganizations` and
 * `OrganizationService.provisionAllAnalytics` have both been the documented remedy
 * for an organization with missing ClickHouse policies since the row-policy work
 * landed — and neither had any caller: no route, no script, no CLI. The migration
 * CLI names `reprovisionOrganizations` inside a warning string, which is to say
 * the runbook's failure branch instructed an operator to call a TypeScript
 * function. This is that function, made runnable.
 *
 * **When to use this rather than `ch:retrofit-read-identity`.** They are not
 * interchangeable, and the difference is a window rather than a preference:
 *
 * - `ch:retrofit-read-identity` grants an existing role to a newly-created read
 *   identity. It writes no row policies, so nothing is ever dropped and there is
 *   no moment at which the app reads zero. Use it when the organizations are
 *   already provisioned and only the reader is new.
 * - this script replays the whole baseline, and the baseline converges the ingest
 *   identity's permissive policy by drop-then-create. Mid-pass that identity is
 *   briefly denied on the object being replaced — which fails CLOSED (the app
 *   transiently reads zero rather than reading another tenant), but it is a real
 *   window and it is the reason the narrower tool exists. Use this when predicates
 *   are actually missing: after a migration added a tenant table, or when
 *   `ch:retrofit-read-identity` reports unpoliced objects.
 *
 * Idempotent: every statement it issues is `IF NOT EXISTS` or an idempotent
 * drop-then-create.
 */
import { chExecutorFromClient, reprovisionOrganizations } from '../ch-provisioning.js';
import { createPrismaClient } from "../client.js";
import { isMainModule } from '../esm-main.js';

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  // Imported inside main() for the reason ChStatementExecutor exists at all:
  // clickhouse.ts builds its client at import time with a hard-coded fallback of
  // localhost:8123 — the staging server — so a top-level import would build a
  // client pointed at real data the moment anything imports this file.
  const { clickhouse } = await import('../clickhouse.js');
  try {
    const organizations = await prisma.organization.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    if (organizations.length === 0) {
      console.log('No organizations on this deployment — nothing to re-provision.');
      return;
    }
    console.log(`Re-provisioning ${organizations.length} organization(s).`);

    const results = await reprovisionOrganizations(
      chExecutorFromClient(clickhouse),
      organizations.map((o) => o.id),
    );

    // Paired by index rather than by parsing the role name back into an id:
    // reprovisionOrganizations returns one result per input id, in order, and
    // reversing `org_<id>` would break the moment the prefix changed.
    results.forEach((result, i) => {
      console.log(
        `  ✓ ${result.role} — ${result.statements} statement(s) (${organizations[i]?.name ?? '?'})`,
      );
    });

    // One coverage report is shared by every organization in the pass, so read it
    // off the first result rather than printing it N times.
    const coverage = results[0]?.coverage;
    if (coverage === undefined) return;

    if (coverage.apiReadIdentity === undefined) {
      // The same operator error ch-retrofit-read-identity exits non-zero for, but
      // a warning here rather than a failure: this script's job is the predicates,
      // and it did them. Reads simply still run through the ingest identity.
      console.warn(
        `  ! no ClickHouse API read identity is configured, so reads still run through the ` +
          `ingest identity '${coverage.serviceIdentity}' and span every organization. Set ` +
          `CLICKHOUSE_READ_USER / CLICKHOUSE_READ_URL to a SEPARATE login holding no row ` +
          `policy of its own, then run: pnpm --filter @deckgauge/db ch:retrofit-read-identity`,
      );
    } else {
      console.log(
        `  ✓ read identity '${coverage.apiReadIdentity}' holds DEFAULT ROLE NONE and each ` +
          `organization's role`,
      );
    }

    if (coverage.needsReprovision.length > 0) {
      // Should be empty immediately after this pass — it is the state this pass
      // exists to repair. Non-empty here means the predicates did not take, which
      // is worth failing on rather than printing.
      console.error(
        `  ✗ ${coverage.needsReprovision.length} tenant object(s) STILL have no ` +
          `per-organization policy after re-provisioning: ` +
          `${coverage.needsReprovision.join(', ')}. This pass was supposed to write them.`,
      );
      process.exitCode = 1;
      return;
    }
    if (coverage.unreadable.length > 0) {
      // Loud but not fatal: these carry no organization_id, so no per-organization
      // policy can re-admit them and only the ingest identity reads them. The fix
      // is a schema change, not another run of this script.
      console.warn(
        `  ! ${coverage.unreadable.length} object(s) have no organization_id and are readable ` +
          `by NOBODY except the ingest identity: ${coverage.unreadable.join(', ')}. Give them ` +
          `an organization_id to make them tenant-scoped.`,
      );
    }
    console.log(`Done. ${results.length} organization(s) re-provisioned.`);
  } finally {
    await prisma.$disconnect();
    await clickhouse.close();
  }
}

// Guarded so importing this module never triggers a live run against a real
// ClickHouse — only executing the file directly does.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
