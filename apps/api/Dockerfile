# The edition this image is BUILT as. Global scope (declared before any FROM) so it
# can be interpolated into `FROM` lines below.
#
# This exists because `packages/enterprise` is present in the private repo and
# ABSENT from the open-source snapshot, while this Dockerfile ships to both
# (.github/oss-allowlist.txt publishes `apps/api/` as a directory). An
# unconditional `COPY packages/enterprise/ ...` therefore breaks every community
# build outright — BuildKit fails the whole build on a missing source, and no glob
# idiom rescues it once the parent directory itself is gone.
#
# Docker only builds the stages a target actually depends on, so selecting
# `community` means the enterprise stages are never evaluated and their COPYs never
# run. compose passes this from the same ${DECKGAUGE_EDITION} that selects the
# runtime edition, so the image cannot be built as one edition and run as the other.
ARG EDITION=community

FROM node:20-slim AS base
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm i -g corepack && corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

# ── deps ────────────────────────────────────────────────────────────────────────
# Manifests only, so a source edit does not invalidate the install layer.
FROM base AS deps-common
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
# The notification write path is a workspace package because BOTH apps/api and
# apps/worker use the one dispatcher (see packages/notifications/README.md).
# Manifest here so the install layer links the workspace member; the SOURCE copy
# in runner-common is the load-bearing half — without it
# node_modules/@deckgauge/notifications dangles and the app dies on first import.
# (--no-frozen-lockfile itself tolerates the missing member, verified; the crash is
# at runtime, which is a far worse place to find out.)
COPY packages/notifications/package.json packages/notifications/
# Same reasoning for the automation rule engine: apps/api runs it for hand-edits
# and apps/worker runs it for the rows a sync writes.
COPY packages/automations/package.json packages/automations/

# Community: no enterprise manifest, matching the OSS snapshot's regenerated
# lockfile (publish-opensource.yml drops the importer along with the package).
FROM deps-common AS deps-community
RUN pnpm install --no-frozen-lockfile

# Enterprise: the private lockfile carries a `packages/enterprise` importer, so its
# manifest must be present or --no-frozen-lockfile fails on a missing workspace member.
FROM deps-common AS deps-enterprise
COPY packages/enterprise/package.json packages/enterprise/
RUN pnpm install --no-frozen-lockfile

FROM deps-${EDITION} AS deps

# ── build ───────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/db/ packages/db/
# generate the Prisma client AND build the lib — its package "main" is dist/index.js,
# so without a build the api/worker crash: "Cannot find package @deckgauge/db/dist/index.js".
RUN pnpm --filter @deckgauge/db generate && pnpm --filter @deckgauge/db build

# ── runner ──────────────────────────────────────────────────────────────────────
FROM build AS runner-common
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
COPY packages/shared/ packages/shared/
COPY packages/ui/ packages/ui/
COPY packages/notifications/ packages/notifications/
COPY packages/automations/ packages/automations/

# Community carries no enterprise module at all. loadEnterprise() has nothing to
# import, `entitledFeatures` is empty, and the one-organization cap holds however
# the environment is set — which is the open-source product, not a degraded one.
FROM runner-common AS runner-community

# Enterprise bakes the module in rather than mounting it: a mounted dist can be
# stale or missing, and the loader's failure mode is a SILENT fall back to
# Community on a stack that otherwise looks healthy.
#
# Built here, not in `build`, because this is the first stage where the source
# exists. Its package "main" is dist/index.js and the loader imports by explicit
# path, so without the build the import throws and that silent fallback is exactly
# what happens.
FROM runner-common AS runner-enterprise
COPY packages/enterprise/ packages/enterprise/
RUN pnpm --filter @deckgauge/enterprise build

FROM runner-${EDITION} AS runner
COPY apps/api/ apps/api/
COPY config/ config/

WORKDIR /app/apps/api
EXPOSE 3001
CMD ["npx", "tsx", "src/index.ts"]
