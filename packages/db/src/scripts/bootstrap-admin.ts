import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from "../client.js";
import { isMainModule } from '../esm-main.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Thrown inside the revoke transaction when the read-then-write admin count
 * check would drop the instance to zero admins. Caught by `revokeAdmin` and
 * translated into a refusal message — never allowed to escape as a raw error.
 */
export class LastAdminError extends Error {}

export type OperationResult = { ok: true; message: string } | { ok: false; message: string };

function userNotFoundMessage(email: string): string {
  return `No user with email "${email}". They must sign in once before a User row exists.`;
}

export async function listAdmins(prisma: PrismaClient): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { email: true },
    orderBy: { email: 'asc' },
  });
  return admins.map((a) => a.email);
}

export async function grantAdmin(prisma: PrismaClient, email: string): Promise<OperationResult> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return { ok: false, message: userNotFoundMessage(email) };
  }
  if (user.isAdmin) {
    return { ok: true, message: `${email} is already an administrator — nothing to do.` };
  }
  await prisma.user.update({ where: { id: user.id }, data: { isAdmin: true } });
  return { ok: true, message: `granted admin to ${email}` };
}

/**
 * Revoking is guarded twice:
 *
 * 1. The target must actually be an admin — otherwise report that plainly and
 *    change nothing, rather than claiming a revoke happened. A typo'd email
 *    during an incident must never come back with a false "revoked" message.
 * 2. The last-admin count check and the write happen inside one
 *    SERIALIZABLE transaction. Under Postgres SSI, two concurrent revokes
 *    that both read "2 admins" and each target a different one form a
 *    write-skew anti-dependency cycle — Postgres aborts one with a
 *    serialization failure rather than letting both commit and leave zero
 *    admins. A plain count-then-update (two separate statements) cannot
 *    close that race; only the shared transaction can.
 */
export async function revokeAdmin(prisma: PrismaClient, email: string): Promise<OperationResult> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return { ok: false, message: userNotFoundMessage(email) };
  }
  if (!user.isAdmin) {
    return { ok: true, message: `${email} is not an administrator — nothing to do.` };
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        const admins = await tx.user.count({ where: { isAdmin: true } });
        if (admins <= 1) {
          throw new LastAdminError();
        }
        await tx.user.update({ where: { id: user.id }, data: { isAdmin: false } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    if (err instanceof LastAdminError) {
      return {
        ok: false,
        message:
          `Refusing to revoke the last administrator (${email}). ` +
          'Grant another one first, or the instance becomes unmanageable.',
      };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      return {
        ok: false,
        message: `Could not revoke admin from ${email} — a concurrent change conflicted with this one. Retry.`,
      };
    }
    throw err;
  }

  return { ok: true, message: `revoked admin from ${email}` };
}

async function main() {
  const prisma = createPrismaClient();
  try {
    if (flag('list')) {
      const admins = await listAdmins(prisma);
      if (admins.length === 0) {
        console.log('No database administrators. Grant one with --email <e>.');
      } else {
        for (const email of admins) console.log(email);
      }
      return;
    }

    const email = arg('email');
    if (!email) {
      console.error('Usage: bootstrap:admin --email <e> [--revoke] | --list');
      process.exit(1);
    }

    const result = flag('revoke') ? await revokeAdmin(prisma, email) : await grantAdmin(prisma, email);
    if (result.ok) {
      console.log(result.message);
    } else {
      console.error(result.message);
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Guard the CLI entry point so importing this module for its exported
// functions (as bootstrap-admin.test.ts does) never triggers a live run
// against process.argv — only running the file directly does.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
