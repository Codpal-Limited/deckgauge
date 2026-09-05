import { createPrismaClient } from "../src/client.js";

const prisma = createPrismaClient();

async function main() {
  const boards = await prisma.board.findMany({ select: { id: true } });

  for (const board of boards) {
    const existing = await prisma.boardView.findFirst({
      where: { boardId: board.id, type: 'BOARD' },
    });
    if (!existing) {
      await prisma.boardView.create({
        data: {
          boardId: board.id,
          type: 'BOARD',
          name: 'Main Board',
          position: 0,
        },
      });
    }
  }

  // Backfill ProjectStatusChange for existing projects
  const projects = await prisma.project.findMany({
    select: { id: true, status: true, createdAt: true },
  });

  for (const project of projects) {
    const existing = await prisma.projectStatusChange.findFirst({
      where: { projectId: project.id },
    });
    if (!existing) {
      await prisma.projectStatusChange.create({
        data: {
          projectId: project.id,
          fromStatus: null,
          toStatus: project.status,
          changedAt: project.createdAt,
          changedBy: null,
        },
      });
    }
  }

  console.log(`Backfilled ${boards.length} board views and ${projects.length} status changes.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
