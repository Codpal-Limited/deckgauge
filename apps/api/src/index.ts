import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPrismaClient } from "@deckgauge/db";
import { buildServer } from "./server.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(process.cwd(), ".env"),
  resolve(currentDir, "../.env"),
  resolve(currentDir, "../../.env"),
  resolve(currentDir, "../../../.env"),
];

const envFilePath = envCandidates.find((candidate) => existsSync(candidate));

if (envFilePath) {
  dotenv.config({ path: envFilePath });
} else {
  dotenv.config();
}

const PORT = Number(process.env["PORT"] ?? 3001);
const HOST = process.env["HOST"] ?? "0.0.0.0";

const prisma = createPrismaClient();

async function main() {
  // Verify DB connection at startup — exit non-zero if it fails
  try {
    await prisma.$connect();
  } catch (err) {
    console.error("Failed to connect to database:", err);
    process.exit(1);
  }

  const app = buildServer(prisma);

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`API server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
