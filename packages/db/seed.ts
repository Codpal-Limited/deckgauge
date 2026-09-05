import { createPrismaClient } from "./src/client.js";

const prisma = createPrismaClient();

async function seed() {
  console.log('🌱 Seeding Jira data...');

  // Clear existing issues
  await prisma.jiraIssue.deleteMany({});
  await prisma.jiraEpic.deleteMany({});
  await prisma.jiraProject.deleteMany({});
  console.log('✓ Cleared existing Jira data');

  // No fake projects — real projects are created by the Jira sync worker
  console.log('✓ Skipped Jira project seeding (projects come from sync)');

  // No fake epics — real epics are created by the Jira sync worker
  console.log('✓ Skipped Jira epic seeding (epics come from sync)');

  // No fake issues — real issues are created by the Jira sync worker
  console.log('✓ Skipped Jira issue seeding (issues come from sync)');

  console.log('✅ Seed complete!');
  await prisma.$disconnect();
}

seed().catch((e) => {
  console.error('❌ Seed failed:', e);
  process.exit(1);
});
