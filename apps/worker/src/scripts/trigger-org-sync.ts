// apps/worker/src/scripts/trigger-org-sync.ts
//
// Enqueues an `org-tree-sync` job for every org tree in an organization, so the
// per-engineer leaderboard, heat strip and per-employee board lists are
// populated by the INSTALL rather than by somebody pressing a button.
//
// It lives here, and is PUBLISHED, because `demo/` is hard-excluded from the
// open-source publish — so the clone that most needs this had no way to run it,
// and the published README asked the reader to open the org chart and press
// Sync instead. It is in `apps/worker` rather than `packages/db` because it
// enqueues a BullMQ job and the worker already depends on `bullmq`.
//
// WHY A VISITOR CANNOT DO THIS THEMSELVES
//
// `POST /org-trees/:id/sync` is gated on `orgTree('EDITOR')`, and demo visitors
// hold VIEWER — deliberately, because EDITOR would let any visitor restructure
// the shared org chart for everyone. So pressing Sync in the browser returns
// 403, and the UI spins forever because `/sync-status` hard-codes
// `state: 'idle'` and the spinner is purely client-side, with no failure path.
// Observed on the live demo 2026-09-09.
//
// WHY THE SEEDER DOES NOT JUST WRITE THE STATS
//
// `packages/db/src/demo/seed-demo.ts` says so itself: the ranking, heat strip
// and per-employee board list all read `OrgEmployee.statsJson`, which the
// org-tree SYNC computes by matching seeded `author_email` values against the
// tree. Fabricating it in the seeder would duplicate the aggregator and go
// stale the moment anything real is synced. So the sync is the right producer —
// it just needs triggering by something other than a browser.
//
// It reaches the queue over REDIS_URL, so it runs either on the HOST against
// the published Redis port — which is how deploy-demo.sh runs the seed steps —
// or inside the worker container against `redis:6379`.
import { Queue } from 'bullmq';
import { createPrismaClient, isMainModule } from '@deckgauge/db';

const REDIS_URL = process.env.REDIS_URL;
// DECKGAUGE_ORG_SLUG first, and the order is the point rather than a
// preference. It is the name an open-source install uses, and it is what
// scripts/test-account.sh passes EXPLICITLY, per run, with
// `docker compose run --rm -e DECKGAUGE_ORG_SLUG=<slug> worker …`.
// DEMO_ORG_SLUG is AMBIENT on the demo stack: demo/docker-compose.demo.yml
// gives the worker `env_file: demo/.env.demo`, so a value an operator puts in
// that file reaches EVERY process in the container (deploy-demo.sh records the
// same asymmetry above its own `env_val DEMO_ORG_SLUG`). Reading the ambient
// one first let a value nobody typed this run outrank one somebody did. Both
// resolve to `demo` on that box today, so nothing was broken by it — it was
// simply the wrong way round, and the next slug that differed would have been
// silently ignored.
//
// demo/deploy-demo.sh (line 244) passes DEMO_ORG_SLUG and no DECKGAUGE_ORG_SLUG,
// so it is unaffected by the flip: the first term is undefined and the second
// still answers.
const ORG_SLUG = process.env.DECKGAUGE_ORG_SLUG ?? process.env.DEMO_ORG_SLUG ?? 'deckgauge';

async function main() {
  if (!REDIS_URL) {
    console.error('✗ REDIS_URL is not set — cannot reach the queue.');
    process.exit(1);
  }

  const prisma = createPrismaClient();
  try {
    const organization = await prisma.organization.findUnique({
      where: { slug: ORG_SLUG },
      select: { id: true },
    });
    if (!organization) {
      console.error(
        `✗ no organization with slug "${ORG_SLUG}".\n` +
          '  Set DECKGAUGE_ORG_SLUG (or DEMO_ORG_SLUG) to the slug you seeded.',
      );
      process.exit(1);
    }

    const trees = await prisma.orgTree.findMany({
      where: { organizationId: organization.id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (trees.length === 0) {
      console.log('  No org trees in this organization — nothing to sync.');
      return;
    }

    // The queue NAME must be 'org-tree-sync' and so must the job name: the
    // worker constructs `new Worker('org-tree-sync', …)` and the api adds
    // `.add('org-tree-sync', { treeId })`. Matching both keeps this
    // indistinguishable from a button press.
    const queue = new Queue('org-tree-sync', { connection: { url: REDIS_URL } });
    try {
      for (const tree of trees) {
        await queue.add('org-tree-sync', { treeId: tree.id });
        console.log(`  queued org-tree-sync for "${tree.name}" (${tree.id})`);
      }
    } finally {
      await queue.close();
    }

    console.log(`✓ Queued ${trees.length} org-tree sync job(s).`);
    console.log('  The worker matches seeded commit authors against the tree; the');
    console.log('  leaderboard and heat strip fill in once it finishes.');
  } finally {
    await prisma.$disconnect();
  }
}

// Only runs when this file is the process entry point, matching its siblings
// `packages/db/src/demo/{seed-demo,test-account}.ts`. Unguarded, merely
// IMPORTING this module — which anything inside `apps/worker` can now do, since
// it moved out of `demo/` into a compiled workspace — enqueues jobs against
// whatever REDIS_URL is set and can `process.exit(1)` out from under its
// importer. `main` is deliberately NOT exported: nothing should call it but the
// CLI, and a test that wants this behaviour should assert on the queue.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
