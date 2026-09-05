FROM node:20-slim AS base
RUN npm i -g corepack && corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

# Install deps
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
# packages/db devDepends on @deckgauge/test-utils, so pnpm needs that member to
# exist in the workspace even though no image ever runs a test. The MANIFEST is
# enough — packages/db/tsconfig.json excludes src/**/*.test.ts, the only files
# that import it, so no source copy is needed. Without this line the private
# build still succeeds (--no-frozen-lockfile tolerates the missing member) while
# the OSS snapshot, whose Dockerfiles the publish workflow rewrites to
# --no-frozen-lockfile, dies at ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
COPY packages/test-utils/package.json packages/test-utils/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --no-frozen-lockfile

# Build Next.js
FROM deps AS build
COPY packages/db/ packages/db/
# The Prisma client is NOT generated here. `prisma generate` needs the Prisma
# CLI's native schema engine, and that engine is a Linux binary this network
# cannot fetch: binaries.prisma.sh serves the darwin build fine but answers every
# Linux target with HTTP 200 and a zero-byte body. It is generated on the HOST by
# scripts/deploy-staging.sh and arrives here in the build context under
# packages/db/src/generated/. The check below turns a missing client into one
# clear line instead of a wall of TS2307 "cannot find module" errors.
RUN test -f packages/db/src/generated/prisma/client.ts || { \
      echo "ERROR: packages/db/src/generated/prisma is missing from the build context."; \
      echo "Generate it on the host first:  pnpm --filter @deckgauge/db generate"; \
      exit 1; \
    }
COPY packages/shared/ packages/shared/
COPY packages/ui/ packages/ui/
RUN pnpm --filter @deckgauge/ui build
# Copy web source files individually to preserve node_modules from deps stage
COPY apps/web/app apps/web/app
COPY apps/web/components apps/web/components
COPY apps/web/auth.ts apps/web/auth.ts
COPY apps/web/middleware.ts apps/web/middleware.ts
COPY apps/web/lib apps/web/lib
COPY apps/web/types apps/web/types
COPY apps/web/next.config.mjs apps/web/next.config.mjs
COPY apps/web/tsconfig.json apps/web/tsconfig.json
COPY apps/web/tailwind.config.ts apps/web/tailwind.config.ts
COPY apps/web/postcss.config.mjs apps/web/postcss.config.mjs
# Next.js bakes NEXT_PUBLIC_* env vars into the static client bundle at BUILD
# TIME, not at runtime. Compose overlays (docker-compose.phase3.yml etc.) must
# pass this through build.args so phase-3 (3010/3011) doesn't end up calling
# main-staging (3000/3001).
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Cap V8's heap for the build. `next build` is unbounded by default: it grows
# until the cgroup kills it, which surfaces as `Killed` / exit 137 /
# `ResourceExhausted: cannot allocate memory` at "Collecting build traces" — the
# tracing pass, which `output: "standalone"` requires and so cannot be turned
# off. That is what failed the aca210b4 and 8c18a37b staging deploys on a ~6GB
# Docker VM, and building the three images one at a time was NOT enough on its
# own; the ceiling is absolute, not contention.
#
# A cap does not give Node more memory, it makes it collect rather than grow, so
# the build fits instead of dying. Set on the build stage only — the runtime
# stage below is unaffected.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN pnpm --filter @deckgauge/web build

# Production — Next.js standalone
FROM node:20-slim AS runner
WORKDIR /app

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
