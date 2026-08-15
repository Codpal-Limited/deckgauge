CREATE TABLE "AdvisorConfig" (
  "id"        TEXT NOT NULL,
  "provider"  TEXT NOT NULL,
  "apiKey"    TEXT,
  "baseUrl"   TEXT,
  "model"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdvisorConfig_pkey" PRIMARY KEY ("id")
);
