import { createPrismaClient } from "../src/client.js";

const prisma = createPrismaClient();

async function main() {
  const email = process.argv.find((a) => a.includes('@'));
  if (!email) {
    console.error('Usage: npx tsx scripts/grant-owner-access.ts <user-email>');
    process.exit(1);
  }

  // Find or create the user
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: email.split('@')[0],
        keycloakId: `placeholder-${crypto.randomUUID()}`,
      },
    });
    console.log(`Created user: ${user.email} (id: ${user.id})`);
    console.log('  Note: keycloakId is a placeholder — it will be replaced on first Keycloak login.');
  } else {
    console.log(`Found existing user: ${user.email} (id: ${user.id})`);
  }

  // Find all boards with zero BoardAccess rows
  const boards = await prisma.board.findMany({
    include: { _count: { select: { accessEntries: true } } },
  });
  const ownerlessBoards = boards.filter((b) => b._count.accessEntries === 0);

  if (ownerlessBoards.length === 0) {
    console.log('All boards already have at least one access entry. Nothing to do.');
    return;
  }

  console.log(`\nFound ${ownerlessBoards.length} board(s) with no access entries:\n`);

  for (const board of ownerlessBoards) {
    await prisma.boardAccess.create({
      data: { boardId: board.id, userId: user.id, role: 'OWNER' },
    });
    console.log(`  ✓ Granted OWNER on "${board.name}" (${board.id})`);
  }

  console.log(`\nDone. ${ownerlessBoards.length} board(s) updated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
