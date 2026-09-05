import { type BoardAccessRole } from '../generated/prisma/client.js';
import { createPrismaClient } from "../client.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const email = arg('email');
  const tree = arg('tree');
  const role = (arg('role') ?? 'OWNER') as BoardAccessRole;

  if (!email || !tree) {
    console.error('Usage: grant:org-access --email <e> --tree <id|all> [--role OWNER|EDITOR|VIEWER]');
    process.exit(1);
  }
  if (!['OWNER', 'EDITOR', 'VIEWER'].includes(role)) {
    console.error(`Invalid role "${role}" — expected OWNER, EDITOR or VIEWER`);
    process.exit(1);
  }

  const prisma = createPrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`No user with email "${email}". They must sign in once before being granted access.`);
      process.exit(1);
    }

    const treeIds =
      tree === 'all'
        ? (await prisma.orgTree.findMany({ select: { id: true } })).map((t) => t.id)
        : [tree];

    if (treeIds.length === 0) {
      console.error('No org trees found.');
      process.exit(1);
    }

    for (const orgTreeId of treeIds) {
      await prisma.orgTreeAccess.upsert({
        where: { orgTreeId_userId: { orgTreeId, userId: user.id } },
        create: { orgTreeId, userId: user.id, role },
        update: { role },
      });
      console.log(`granted ${role} on ${orgTreeId} to ${email}`);
    }
    console.log(`\nDone — ${treeIds.length} tree(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
