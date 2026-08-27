# The edition this image is BUILT as — see the long note in apps/api/Dockerfile.
# Global scope (before any FROM) so it can be interpolated into `FROM` lines.
#
# The worker needs this for the same reason the api does, and it was missing for
# longer: apps/worker/src/edition-loader.ts reads DECKGAUGE_EDITION, but nothing
# ever put `packages/enterprise` into this image and the worker service declared no
# DECKGAUGE_* variables at all. Its half of the edition seam — allowIngest and
# runPeriodicWork — therefore never ran in any deployed stack.
ARG EDITION=community

FROM node:20-slim AS base
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm i -g corepack && corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
# Default 0 because corporate networks MITM outbound TLS during local
# development. Hosted deployments MUST override this to 1 at runtime — see
# deploy/docker-compose.hosted.yml. At 0 the worker accepts a forged
# certificate for any provider while holding customer tokens.
ARG NODE_TLS_REJECT_UNAUTHORIZED=0
ENV NODE_TLS_REJECT_UNAUTHORIZED=${NODE_TLS_REJECT_UNAUTHORIZED}

# ── deps ────────────────────────────────────────────────────────────────────────
FROM base AS deps-common
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
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

# Community: no enterprise manifest, matching the OSS snapshot's regenerated lockfile.
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
# Default 0 because corporate networks MITM outbound TLS during local
# development. Hosted deployments MUST override this to 1 at runtime — see
# deploy/docker-compose.hosted.yml. At 0 the worker accepts a forged
# certificate for any provider while holding customer tokens.
ARG NODE_TLS_REJECT_UNAUTHORIZED=0
ENV NODE_TLS_REJECT_UNAUTHORIZED=${NODE_TLS_REJECT_UNAUTHORIZED}
COPY packages/shared/ packages/shared/
COPY packages/ui/ packages/ui/
COPY packages/notifications/ packages/notifications/
COPY packages/automations/ packages/automations/

# Community carries no enterprise module: loadEdition() returns null and the worker
# runs exactly as the free product does.
FROM runner-common AS runner-community

# Enterprise: baked in, not mounted, for the same reason as the api — a stale or
# absent mounted dist makes the loader fall back to Community silently.
FROM runner-common AS runner-enterprise
COPY packages/enterprise/ packages/enterprise/
RUN pnpm --filter @deckgauge/enterprise build

FROM runner-${EDITION} AS runner
COPY apps/worker/ apps/worker/
COPY config/ config/

WORKDIR /app/apps/worker
CMD ["npx", "tsx", "src/index.ts"]
