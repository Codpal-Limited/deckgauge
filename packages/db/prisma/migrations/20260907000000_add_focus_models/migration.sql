-- Focus view: classification verdicts, per-board config, curated roadmap set.
-- Hand-written: `prisma migrate dev` cannot run here (shadow-DB P3006).
-- Purely additive — no existing table, column or type is touched.

-- CreateEnum
CREATE TYPE "focus_class" AS ENUM ('a', 'b', 'c', 'unclassified');

-- CreateEnum
CREATE TYPE "focus_verdict_source" AS ENUM ('human', 'capex', 'rule', 'model');

-- CreateTable
CREATE TABLE "focus_verdicts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "class" "focus_class" NOT NULL,
    "epic_key" VARCHAR(64),
    "reason" VARCHAR(400) NOT NULL,
    "source" "focus_verdict_source" NOT NULL,
    "rule_id" TEXT,
    "model" VARCHAR(128),
    "prompt_version" VARCHAR(32),
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "focus_verdicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "focus_configs" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "class_labels" JSONB NOT NULL DEFAULT '{}',
    "working_states" JSONB NOT NULL DEFAULT '{}',
    "stage_map" JSONB NOT NULL DEFAULT '{}',
    "migration_cutoff" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "focus_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "focus_epics" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "source_key" VARCHAR(64) NOT NULL,
    "title" VARCHAR(400) NOT NULL,
    "programme" VARCHAR(128),
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "focus_epics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "focus_verdicts_organization_id_fingerprint_key" ON "focus_verdicts"("organization_id", "fingerprint");

-- CreateIndex
CREATE INDEX "focus_verdicts_organization_id_source_idx" ON "focus_verdicts"("organization_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "focus_configs_board_id_key" ON "focus_configs"("board_id");

-- CreateIndex
CREATE UNIQUE INDEX "focus_epics_board_id_source_key_key" ON "focus_epics"("board_id", "source_key");

-- CreateIndex
CREATE INDEX "focus_epics_board_id_active_idx" ON "focus_epics"("board_id", "active");

-- AddForeignKey
ALTER TABLE "focus_verdicts" ADD CONSTRAINT "focus_verdicts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_configs" ADD CONSTRAINT "focus_configs_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_epics" ADD CONSTRAINT "focus_epics_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
