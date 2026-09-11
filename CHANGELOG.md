# Changelog

All notable changes to Deckgauge are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are read
against what a **self-hosted install** sees: a release that requires the
operator to do something before upgrading is a major one.

> **Reading this in the public repository?** Entries before v2.0.0 predate the
> first public release, and some of them name scripts, compose overlays and
> planning documents that live in the development repository and are not part of
> the published tree — `scripts/deploy-staging.sh`, `docker-compose.phase3.yml`
> and the like. They are kept verbatim because a changelog that is rewritten
> after the fact is worth less than one that is not; where an entry concerns this
> project's own staging rather than your install, it says so. Nothing you need in
> order to run, upgrade or back up Deckgauge is missing from the clone.

## [Unreleased]

Nothing yet.

## [v2.0.0] — 2026-09-11 — Public launch

The first release published for anyone to install. Everything below has been
running on this project's own staging since it landed; what is new in v2.0.0 is
that it is public, documented, and installable in one command.

Try it without installing anything: [demo.deckgauge.com](https://demo.deckgauge.com).

Licensed under the Functional Source License (FSL-1.1-Apache-2.0). This release is
free to run at any size, commercially, forever; the one restriction is reselling it
as a competing hosted service, and its Apache-2.0 grant takes effect on
**11 September 2028**. The full answer is at <https://deckgauge.com/license/>.

### Added

**Org chart and people**

- **Org trees** imported from CSV/Excel or synced from a Microsoft Entra
  directory over Microsoft Graph (paste-a-token or device-code connect), with
  per-team employee boards, private 1:1 / review notes, and a salary column
  behind its own permission — read access to the tree never implies pay
  visibility.
- **Per-engineer contribution ranking** with badges and a commit-heat sparkbar,
  framed throughout as a conversation starter rather than a performance rating.

**Team Focus**

- **Focus dashboards** showing what a team actually worked on — including the
  work that never reached the tracker, with that coverage gap reported on
  screen rather than silently excluded.
- **Time rules**: configurable status buckets that map each source's own status
  vocabulary onto one five-stage delivery funnel.

**Timesheets and cost**

- Timesheets with **CapEx/OpEx classification**, a blended-rate cost layer on
  the capitalization report, a configurable per-day cap, and a paginated
  top-epics leaderboard.

**Roadmaps and comparison**

- **Auto-generated Gantt roadmaps** built from live board data — size-driven
  bars, parallel lanes per team, and a today line.
- **Comparison dashboards** across boards and teams, plus period-over-period
  comparison widgets.

**Engineering Intelligence**

- A board-scoped **Intelligence tab** with a DORA scorecard, investment
  allocation, review mix (bot vs human), velocity with confidence, rework rate
  and backlog age, over a ClickHouse store that is part of the install.

**Sources**

- **Azure DevOps** project sync (optionally every repository in the project),
  **GitLab** project sync, **GitHub** bulk repository ingestion, multi-board
  sync, a two-level Sources UI, and source-token health surfaced before a sync
  silently goes stale.

**Recruitment**

- Recruitment board templates, a calendar source, and onboarding a candidate
  straight into the org tree.

**Advisor**

- A **local-LLM advisor** (with an MCP bridge) that answers questions about
  your own delivery data. Inference runs on your box; nothing is sent anywhere.

**Multiple organizations and access control**

- Organization switcher and per-organization tenancy, board sharing with
  board-level RBAC, a database-backed first admin, and a `bootstrap:admin` CLI.

**Install and operations**

- `scripts/init-env.sh` — one command that writes `.env` and generates a random
  password for every credential, so no two installs share one.
- `scripts/test-account.sh` — a signed-in, populated account on a fresh install,
  removable in two commands.
- App-wide dark mode, a mobile-responsive web app, a Keycloak login theme,
  self-service registration, and federated sign-out against the install's own
  Keycloak.

### Changed — BREAKING for existing installs

The last of the old `vp-cockpit` name is gone. Everything an operator can see
now says `deckgauge`:

- **Containers** — the `container_name` default moved from `vp-cockpit-*` to
  `deckgauge-*` (override with `CONTAINER_PREFIX`).
- **Compose project / image names** — `scripts/deploy-staging.sh` now exports
  `COMPOSE_PROJECT_NAME=deckgauge`, so built images are `deckgauge-api`,
  `deckgauge-web`, `deckgauge-worker`. The Phase 3 and test stacks moved to
  `deckgauge-next` and `deckgauge-test` to match.
- **Keycloak** — realm `vp-cockpit` → `deckgauge`, client `vp-cockpit-web` →
  `deckgauge-web`, login theme directory `keycloak/themes/vp-cockpit/` →
  `keycloak/themes/deckgauge/`, and the default client secret →
  `deckgauge-secret`.
- **ClickHouse** — the read-only console user `vp_cockpit_console` →
  `deckgauge_console` (`CLICKHOUSE_CONSOLE_USER` still overrides it).
- **`.env` must be edited by hand** — `.env.example` *assigns* `KEYCLOAK_ISSUER`,
  `KEYCLOAK_CLIENT_ID` and `KEYCLOAK_JWKS_URI`, and the documented setup copies it
  to a gitignored `.env` no release can reach. Compose interpolates all three, so
  a stale `.env` silently overrides the renamed defaults and every login fails
  with `invalid_client`. `rename-keycloak-realm.sh` refuses to run until they are
  fixed and names them. `KEYCLOAK_CLIENT_SECRET` is deliberately never rotated.
- **`NEXTAUTH_SECRET`'s default** moved to `deckgauge-nextauth-secret`, so an
  install on the compose default has every existing session cookie become
  undecryptable. Subsumed in practice by the forced re-login the realm rename
  already causes, but it is an independent cause.
- **Browser state** — the collapsed-groups `localStorage` prefix moved to
  `deckgauge:collapsedGroups:`. Each viewer's collapsed board groups expand once
  on their next visit and then persist again. No migration shim: the state is
  cosmetic, per-browser, and rebuilt by using the board.
- **Backup archives** — new archives are `deckgauge-backup-*.tar.gz`. Rotation
  in `scripts/backup-weekly.sh` and `deploy/backup-to-r2.sh` deliberately still
  matches the old prefix, so archives taken before the rename are not stranded.

**Fresh installs need nothing.**

**This repo's own staging needs `scripts/migrate-project-rename.sh` FIRST.**
Compose prefixes named volumes with the project name, and `deploy-staging.sh`
pinned that to `vp-cockpit`, so every byte of staging — Postgres, the Keycloak
database, ClickHouse, uploads — lives in `vp-cockpit_*` volumes. `up -d` does
not error on the missing `deckgauge_*` ones; it creates them empty and the stack
comes up healthy and blank. The script copies the data across and deletes
nothing, and `deploy-staging.sh` now refuses to deploy until it has run. A
public install is unaffected: its project name comes from the clone directory,
which the README already names `deckgauge`.

Any **existing** install must then run
`scripts/rename-keycloak-realm.sh` once after upgrading: `--import-realm` only
ever populates an EMPTY Keycloak database, so the renamed `realm-export.json`
never reaches a stack that has already started, and api/web would ask for a
realm Keycloak does not serve. The script is idempotent, migrates realm, client
and theme, and leaves an operator-chosen client secret alone. Everyone signs in
once more afterwards — tokens minted by the old realm are no longer valid.

Not renamed, deliberately: the `cockpit` Postgres and ClickHouse **database**
names, and the `COCKPIT_*` role env vars. Those are data-layer identifiers
embedded in live databases and several hundred query strings; moving them is a
data migration, not a rename.

### Security

- **The committed default credentials are gone.** `cockpit`/`cockpit` and
  `admin`/`admin` no longer appear as defaults anywhere, and
  `docker-compose.yml` now *requires* each credential (`${VAR:?}`) instead of
  falling back to a literal — a stack with no `.env` refuses to start rather
  than booting on a password published in this repository. `scripts/init-env.sh`
  is the supported way to create one; `./scripts/init-env.sh --check` reports
  what an existing file is missing.
- **Every published port honours `BIND_HOST`.** Set `BIND_HOST=127.0.0.1:` (note
  the trailing colon) and nothing is reachable from off the machine. The default
  is still all interfaces, which is right for a laptop and wrong everywhere
  else; `scripts/check-bind-host.sh` asserts the mechanism stays wired.

## [v1.3.0] — 2026-06-03 — Phase 3: Engineering Intelligence

The largest single phase. Adds a ClickHouse-backed analytics tier alongside
the existing Postgres operational store, four code-host integrations (Jira,
GitHub, GitLab, Azure DevOps) writing rich event data to ClickHouse, and a
new `/intelligence` dashboard surface in the web app.

### Added

**Infrastructure (Sprint 0)**
- ClickHouse service in `docker-compose.yml` (24.3-alpine, 1 GB memory cap,
  `cockpit` database, `cockpit:cockpit` credentials).
- `docker-compose.phase3.yml` — overlay so Phase 3 staging runs on
  3010/3011/8124/8081/5434/6380 alongside the existing staging on 3000/3001.
- `scripts/deploy-phase3.sh` — deploy script + bash ClickHouse migration
  runner.
- `clickhouse/config/memory.xml` — `<listen_host>0.0.0.0</listen_host>` +
  `max_server_memory_usage = 800 MiB` + cache caps.
- `clickhouse/schemas/*.sql` — 16 DDL files: 14 raw `ReplacingMergeTree`
  tables (jira/github/gitlab/ado/developer), 3 `AggregatingMergeTree` state
  tables, 6 MaterializedViews (developer weekly PR metrics, Jira flow
  efficiency, commit activity heatmap).

**Data layer (Sprint 1)**
- `packages/db/src/clickhouse.ts` — `clickhouse` singleton + `chInsertMany`.
- `packages/db/src/clickhouse-migrate.ts` — TS migration runner + 8 unit tests.
- Prisma model split (EI-001): added `GitLabInstance`, `JiraProjectSync`,
  `BoardJiraSource`, `GitHubRepoSync`, `BoardGitHubSource`,
  `AzureDevOpsProjectSync`, `BoardAdoSource`, `GitLabProjectSync`,
  `BoardGitLabSource`; added `Board.ticketKeyPrefixes`; added 4 nullable
  FKs on `SyncRun` referencing the new project-sync models.
- New adapters in `@deckgauge/shared`: `GitHubPrAdapter`,
  `GitHubCommitAdapter`, `GitLabPrAdapter`, `GitLabCommitAdapter`,
  `AdoPrAdapter`, `JiraIntelligenceAdapter`. Each ships with a `*Port`
  interface and `Fake*Adapter`.
- `detectAiAssistance` — weighted-confidence AI-assistance signal extraction
  (co-author trailers, message markers, branch prefixes, author logins).
- `extractTicketKeys` — scoped and any-prefix ticket-key extraction from
  text + branch names.
- Zod intelligence schemas in `packages/shared/src/intelligence-schemas.ts`.

**Workers (Sprint 2)**
- `gitlab-sync` BullMQ queue + handler — net-new GitLab integration.
- `jira-intelligence-sync`, `github-intelligence-sync`,
  `ado-intelligence-sync` BullMQ queues — write rich event data to
  ClickHouse alongside the existing Postgres sync queues.
- `packages/db/src/migrate-sync-configs.ts` — idempotent migration of
  legacy `*SyncConfig` rows into the new `*ProjectSync` + `Board*Source`
  model split (per planning/MULTI-BOARD-SYNC.md §6).
- `packages/db/src/backfill-to-clickhouse.ts` — backfills existing
  Postgres `jira_epics`, `jira_issues`, `github_milestones`,
  `github_issues`, `azure_devops_work_items` rows into ClickHouse.
- Drop-legacy-tables Prisma migration
  `20260603120000_drop_legacy_phase3_tables/migration.sql` (hand-written
  SQL to bypass the 2026-05-11 shadow-DB conflict).

**Intelligence API (Sprint 3)**
- `apps/api/src/intelligence/clickhouse-intelligence.service.ts` — five
  query methods: team overview, developer weekly time series, anomaly
  detection (90-day baseline vs last 2 weeks), AI breakdown, ticket
  coverage, plus EI-021 unified ticket timeline.
- `intelligence.routes.ts` Fastify plugin — endpoints:
  - `GET /intelligence/overview`
  - `GET /intelligence/developers/:login/weekly`
  - `GET /intelligence/anomalies`
  - `GET /intelligence/ai-breakdown`
  - `GET /intelligence/coverage`
  - `GET /intelligence/tickets/:key`
  - `POST /intelligence/sync` — enqueues manual sync on the BullMQ queues.
- GitLab CRUD endpoints under `/gitlab/instances` + `/gitlab/project-syncs`.
- `LegacyDataClickHouseService` — feature-flagged
  (`INTELLIGENCE_DATA_SOURCE=clickhouse`) alternative for the legacy
  `/jira/epics`, `/jira/issues`, `/github/milestones`, `/github/issues`
  endpoints. Returns the same response shape but queries ClickHouse.

**Front-end (Sprint 4)**
- `/intelligence` overview dashboard — 4 metric cards (PRs merged, median
  cycle, active devs, AI %).
- `/intelligence/developers` + `/intelligence/developers/[login]` — list
  and per-developer weekly time series.
- `/intelligence/ai` — AI-assistance breakdown by author.
- `/intelligence/prs` — PR explorer (overview cards).
- `/intelligence/tickets` + `/intelligence/tickets/[key]` — unified ticket
  timeline lookup.
- `MetricCard`, `AiBadge`, `HeatmapCalendar`, `DeveloperRow`,
  `CycleTimeFunnel` — dependency-free UI primitives.
- `GitLabSetupWizard` component on Settings.
- `apps/web/app/actions/intelligence.ts` — server action for manual sync.
- 4 new MetricCard component tests.

### Changed
- `docker-compose.yml` — added ClickHouse service; raised api/web/clickhouse
  memory limits where needed.
- `hooks/post-commit` — auto-deploys Phase 3 staging on commits to
  `feature/phase-3-intelligence`.
- `CLAUDE.md` — Phase 3 reading-order block + branching rule.

### Deferred
- Removing the legacy `*SyncConfig` Prisma models entirely. Kept for now
  alongside the new `*ProjectSync` / `Board*Source` tables until all read
  paths cut over.
- Wiring the LegacyDataClickHouseService into the existing /jira/* + /github/*
  routes by default. Available today behind `INTELLIGENCE_DATA_SOURCE=clickhouse`
  env var.
- Broader UI drill-down filters in `/intelligence/prs` (placeholder cards
  today).

### Notes for operators
- Run `pnpm migrate:clickhouse` after every deploy to apply DDL migrations.
- Run `pnpm --filter @deckgauge/db exec tsx src/backfill-to-clickhouse.ts`
  once per environment to seed ClickHouse from legacy Postgres data.
- Run `pnpm --filter @deckgauge/db exec tsx src/migrate-sync-configs.ts`
  once per environment to replicate legacy sync configs into the new
  multi-board model.
- The 2026-05-11 historical migration-history conflict (duplicate
  `github_issue_id` ADD COLUMN) still blocks `prisma migrate dev` on a
  fresh shadow DB. New Phase 3 schema additions were applied via
  `prisma db push`. The drop-legacy-tables migration is hand-written SQL.

## [v1.2.x] — pre-2026-06-03 — Phase 1 / 1.5 / 1.8 / 2

The running log of changes prior to v1.3.0 is kept in the development
repository. Major pre-Phase-3 capabilities:

- Monday-style project board with manual + Jira/GitHub/ADO-synced projects.
- Per-engineer workload view.
- Role-based access via Keycloak (OWNER / EDITOR / VIEWER).
- Dashboard widgets and board views.
- Server-side pagination, optimistic UI, revalidation tags.
