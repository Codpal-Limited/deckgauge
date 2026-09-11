<!--
PUBLIC-FACING README for the open-source Deckgauge repo (published as README.md).
Separate from the private repo's own README. Keep it public-appropriate.

The demo credentials in "Try it live" are THE published copy, and this channel is
deliberately not gated: deckgauge.com sends visitors through a form at /try/ that asks for a
name, company and email before handing the login back, and a reader of this file gets it
without that. Anyone who would rather not leave an email can therefore have the demo in two
clicks, on purpose.

On the marketing site — a separate codebase, not part of this repo — the pair lives only in
that deployment's environment and is read at request time, never compiled into a page. So if
the demo password rotates there are exactly two places to change: that environment, and the
line below. Nothing shares a module across the two, and nothing can.

A corollary worth stating plainly, since "we added a gate" invites the opposite inference:
the demo is NOT access-controlled. The gate is a capture device on one channel.

The "See it in action" GIFs are served from deckgauge.com/media/ rather than
committed here, so they stay out of the clone and can be updated without a
publish. Verify they still resolve before a launch — a broken hero image is the
first thing a visitor sees.
-->

<div align="center">

# Deckgauge

### Source-available development intelligence — one board across all your dev tools.

*See how your software really gets built.*

Turn **Jira, GitHub, GitLab, and Azure DevOps** into one board with the widgets, dashboards,
rankings, and roadmaps engineering leaders use to see what’s really going on.

[![License: FSL-1.1](https://img.shields.io/badge/license-FSL--1.1-0c8f83)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Codpal-Limited/deckgauge?style=social)](https://github.com/Codpal-Limited/deckgauge)

[**Live demo**](https://demo.deckgauge.com) · [**Website**](https://deckgauge.com) · [**Docs**](https://deckgauge.com/docs) · [**Enterprise**](https://deckgauge.com/enterprise)

</div>

---

## Try it live — no install

A hosted Deckgauge, seeded with a fictional company: two boards carrying 240 items, a
roadmap, comparison dashboards, a 25-person org chart, timesheets, and six months of
engineering history behind the intelligence widgets.

**[demo.deckgauge.com](https://demo.deckgauge.com)** — sign in with `test@test.com` / `test`

The demo is shared by everyone who visits and is reset periodically, so treat anything you
change there as temporary. Do not put real data in it. For a private instance with your own
sources connected, install it below — it takes one command.

---

## See it in action

### One board across all your dev tools

Pull Jira, GitHub, GitLab, and Azure DevOps into a single Monday-style board — grouped,
owned, status-tracked, sized, and classified CapEx/OpEx. Discuss any item inline.

![Deckgauge board — owners, status, effort sizing, CapEx/OpEx classification, and inline item comments](https://deckgauge.com/media/board.gif)

### Auto-generated roadmaps

Timelines built straight from live board data — parallel lanes per team, effort-sized bars,
and a today line.

![Deckgauge roadmap — a timeline auto-built from board data, with per-lane bars and a today line](https://deckgauge.com/media/roadmap.gif)

### Org chart & team structure

Import your org from CSV/Excel (or sync your directory) — a live reporting tree, per-team
boards, and private 1:1 / review notes on every person.

![Deckgauge org chart and team board — reporting hierarchy, a per-team board, and 1:1 notes](https://deckgauge.com/media/org.gif)

📺 **Full live tour → [deckgauge.com](https://deckgauge.com)** — plus the intelligence
dashboard, the ranking leaderboard, and CapEx/OpEx reporting.

---

## ⚡ Install with your AI agent — one line

Paste this into your AI coding agent (**Claude Code, Cursor, Copilot agent**, or any agent
that can run commands). It fetches the setup skill and installs Deckgauge on your machine:

```
curl -fsSL https://deckgauge.com/install.md
```

That’s it — the agent clones the repo, starts the stack, sets up the database, and hands you back
`http://localhost:3000`.

---

## Install it yourself (Docker)

```bash
git clone https://github.com/Codpal-Limited/deckgauge
cd deckgauge
./scripts/init-env.sh
docker compose up -d
# create the schema (-T keeps it non-interactive; if it fails, see CONTRIBUTING.md
# — do NOT add --accept-data-loss, it drops tables)
docker compose run --rm -T api sh -c "cd /app/packages/db && npx prisma db push"
# create a signed-in-and-populated demo account
./scripts/test-account.sh
```

Then open `http://localhost:3000` and sign in with **`test@test.com`** /
**`test`**. You land on a working product: two boards carrying 240 items, a
roadmap, a Platform-vs-Mobile comparison dashboard, a 25-person org chart,
timesheets, and six months of engineering history behind the Engineering
Intelligence and Team Focus dashboards. The org-tree sync that fills the
per-engineer views runs as part of that command, so nothing is left to press.

`./scripts/init-env.sh` writes `.env` and generates a random password for
Postgres, ClickHouse, Keycloak's database, the Keycloak admin console, the OIDC
client and the session-signing key — this install's own, not one shared with
every other clone. It refuses to overwrite an existing `.env`; use
`./scripts/init-env.sh --check` on one. There is no `cp .env.example .env` step
any more, and copying that file by hand does not work: every credential in it is
empty and `docker-compose.yml` requires them, so the stack stops at `up` with the
variable named rather than booting on a password published in this repository.

> **Before you expose this install to anything.** `test@test.com` has a
> password everybody knows, and `docker-compose.yml` publishes its ports on all
> interfaces by default (`BIND_HOST` is unset). That is fine on a laptop and not
> fine anywhere else: remove the account (below) and set `BIND_HOST=127.0.0.1:`
> in `.env` — note the trailing colon — before the machine is reachable by
> anyone but you.

**Remove them in this order — data first, then the account.** Neither touches a
board you made yourself, but the sequence matters:

```bash
# 1. the demo data, keeping the account
docker compose run --rm api npx tsx /app/packages/db/src/demo/seed-demo.ts --remove

# 2. then the account and its grants
./scripts/test-account.sh --remove
```

Removing the account deletes its `User` row, and every grant — `OrgMembership`,
`BoardAccess`, `OrgTreeAccess`, `RoadmapAccess`, `ComparisonAccess` — cascades
with it. `test@test.com` is the only member of a stock install, so once it is
gone the organization has no active admin, and `seed-demo.ts --remove` looks one
up before it removes anything: it refuses, and the demo content is stranded —
in the database, visible to nobody, removable by nothing.

**Prefer to start empty and register your own account?** Skip
`scripts/test-account.sh` entirely. Open `http://localhost:3000`, sign in, and
create your organization — only the first person to sign in can, and Deckgauge
never creates one for you. You can still seed the demo content into it
afterwards:

```bash
docker compose run --rm api npx tsx /app/packages/db/src/demo/seed-demo.ts
# fills the per-engineer leaderboard, heat strip and per-employee board lists,
# which are computed by the org-tree sync rather than written by the seeder
docker compose run --rm -e DECKGAUGE_ORG_SLUG=your-org-slug \
  worker npx tsx /app/apps/worker/src/scripts/trigger-org-sync.ts
```

You need nothing further on a fresh install: the first account to sign in is
granted admin automatically, which is the same grant that lets you create the
organization at all — so the Engineering Intelligence dashboards and the org
chart's salary column both work for you.

That only changes if yours is **not** the first account (you ran
`scripts/test-account.sh` earlier, or someone else registered first). Analytics
then falls back to the `cockpit-admin` Keycloak realm role rather than your
organization role — the cross-cutting people-analytics reads carry no board id to
check — so grant it and sign out and back in to re-mint the token:

```bash
docker compose exec keycloak sh -c '
  /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 \
    --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" \
    --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" &&
  /opt/keycloak/bin/kcadm.sh add-roles -r deckgauge \
    --uusername you@example.com --rolename cockpit-admin'
```

The `config credentials` line is required: `kcadm.sh` stores its session in a
config file the container does not ship with, and an unauthenticated call hangs
instead of failing. It reads the admin credentials from the container's own
environment, so you never type or paste them — unless you rotated
`KEYCLOAK_ADMIN_PASSWORD` after first boot, in which case those variables hold a
password the master realm no longer has and you must pass the real one.

Full setup — connecting sources, SSO, access control — is in the [docs](https://deckgauge.com/docs).

### Upgrading an existing install

**Back up first.** `docker compose up -d` after a `git pull` starts whatever
image versions that commit pins, and two of those upgrade your data in place:

```bash
./scripts/backup.sh      # Postgres, Keycloak, ClickHouse, uploads
git pull && docker compose up -d
```

Keycloak migrates its own database schema on first start of a new version and
that migration is **one-way** — rolling the image back does not roll the schema
back. ClickHouse likewise upgrades its data directory in place. Both are
routine and neither needs manual steps; the backup is what makes them
reversible if something about your install is unusual.

Your existing `.env` keeps working across ordinary upgrades. The compose file
passes only the variables it names, so keys that later releases stop using are
ignored rather than breaking startup. (Two releases do need an `.env` edit: the
default-credential change immediately below, and the `deckgauge` rename after
it.)

#### One-time step when upgrading past the default-credential change

`docker-compose.yml` used to default every credential — `POSTGRES_PASSWORD` to
`cockpit`, `KEYCLOAK_ADMIN_PASSWORD` to `admin`, and so on — so an install could
run without ever setting them. Those fallbacks are gone: each is now
`${VAR:?…}`, and compose refuses to start while one is missing. Nothing is
rotated and no data moves; the values simply have to be written down.

Run `./scripts/init-env.sh --check`. It lists exactly what your `.env` is
missing and changes nothing. In practice that is `CLICKHOUSE_USER` and
`CLICKHOUSE_PASSWORD`, which existed only inside `docker-compose.yml` before, and
possibly `KEYCLOAK_CLIENT_SECRET` and `NEXTAUTH_SECRET`.

**Set them to the values your install is already using, not to fresh ones.**

```
CLICKHOUSE_USER=cockpit
CLICKHOUSE_PASSWORD=cockpit
KEYCLOAK_DB_PASSWORD=keycloak
KEYCLOAK_CLIENT_SECRET=deckgauge-secret
NEXTAUTH_SECRET=change-me-in-production
```

Postgres, ClickHouse and Keycloak's database each read their password only on
**first** start, so a new one here does not rotate anything — it locks the stack
out of its own volume, and the failure that follows is an authentication error
pointing at nothing. Rotating for real means `ALTER USER` on the running server
(or `docker compose down -v`, which deletes the data). A fresh
`NEXTAUTH_SECRET` is safe and signs everyone out once.

**Two of the five are rotatable, and you should rotate both — just not by
editing this file alone.** Writing `KEYCLOAK_CLIENT_SECRET=deckgauge-secret`
above is correct *today*, because that is what your realm already holds and
`--import-realm` will not change a realm that exists. But it is a value
published in this repository, so leaving it there permanently re-pins your
install to a secret anyone can read. Rotate it on the RUNNING Keycloak and put
the new value in `.env`:

```bash
NEW=$(openssl rand -hex 32)
CID=$(docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh get clients \
        -r deckgauge -q clientId=deckgauge-web --fields id --format csv --noquotes)
docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh update "clients/$CID" \
        -r deckgauge -s secret="$NEW"
# then set KEYCLOAK_CLIENT_SECRET=$NEW in .env and: docker compose up -d web keycloak
```

(`kcadm.sh` needs `config credentials` first — the block further up shows the
form.) `NEXTAUTH_SECRET` is the other one, and it needs nothing but a new value.
The remaining three are volume-initialisation passwords and are not rotatable
this way.

#### One-time step when upgrading past the `deckgauge` rename

Releases before this one shipped under the project's old internal name,
`vp-cockpit`. Containers, the Compose project, the Keycloak realm and its web
client have all moved to `deckgauge`. Fresh installs get the new names and need
nothing. An **existing** install needs two things after `git pull`.

**First, edit `.env`.** This matters more than it looks. `.env.example` *assigns*
these keys rather than commenting them, and the setup step at the time was
`cp .env.example .env` — so your `.env` almost certainly names the old realm, and
compose interpolates it, meaning your stale value overrides the new default.
Change the realm segment in these, wherever they appear:

```diff
- KEYCLOAK_ISSUER=http://localhost:8080/realms/vp-cockpit
+ KEYCLOAK_ISSUER=http://localhost:8080/realms/deckgauge
- KEYCLOAK_CLIENT_ID=vp-cockpit-web
+ KEYCLOAK_CLIENT_ID=deckgauge-web
- KEYCLOAK_JWKS_URI=http://keycloak:8080/realms/vp-cockpit/protocol/openid-connect/certs
+ KEYCLOAK_JWKS_URI=http://keycloak:8080/realms/deckgauge/protocol/openid-connect/certs
```

Leave `KEYCLOAK_CLIENT_SECRET` **exactly as it is** — the migration does not
change the client secret, so whatever you have now stays correct.

**Then migrate Keycloak**, which imports `keycloak/realm-export.json` only into
an empty database and so never sees the rename on its own:

```bash
docker compose up -d                    # bring the stack up on the new names
./scripts/rename-keycloak-realm.sh      # rename the realm, client and theme
docker compose up -d --force-recreate api web
```

The script refuses to run until that `.env` edit is done, and names the exact
lines if you skipped it. It is idempotent, reads the running Keycloak rather
than guessing, and skips anything already migrated. If your clone directory is
not named `deckgauge`, tell it which Compose project to use:
`COMPOSE_PROJECT_NAME=<your-dir> ./scripts/rename-keycloak-realm.sh`.

Everyone signs in once more afterwards — tokens issued by the old realm are no
longer valid, and `NEXTAUTH_SECRET`'s default moved too, so existing session
cookies stop decrypting.

Two cosmetic leftovers are harmless and can be removed at your leisure: the
old `vp-cockpit-*` containers (`docker rm`) and the old images
(`docker image prune`). Backups already in `./backups/` keep their old
filenames and stay restorable — `scripts/restore.sh` takes the path you give
it and does not care what the archive is called.

---

## What you get

- **📊 Monitoring & visibility** — DORA, flow, throughput, review time, WIP as widgets you watch, centralized across all four tools.
- **🤝 Contribution insight, not a scoreboard** — see PRs, tickets, commits and review comments per person, with weights you choose, to recognise the people carrying the load and spot who has gone quiet because they are stuck. Decision support with a human in the loop — never an automated performance rating. Team and org totals are the default view; per-person detail is there when you need it.
- **🗂️ Alignment dashboards** — pull imported issues into one board for leadership meetings: comment conclusions, re-prioritize, set due dates, resync for live status.
- **🛣️ Auto-generated roadmaps** — timelines built from live board data, with progress and a today line.
- **💰 CapEx / OpEx for finance** — audit-ready software capitalization, inferred from activity, no manual timesheets.
- **👥 Team management & reviews** — dated, private notes so 1:1s and performance reviews are grounded in real examples.

Source-available. Multi-tool. No lock-in. Read the queries, run it yourself, trust the numbers.

---

## 🤖 Ask the Advisor — powered by *your* Claude Code or Codex

Deckgauge has an in-app Advisor panel that answers questions about a board.
If you already have [Claude Code](https://docs.claude.com/en/docs/claude-code)
or [Codex](https://github.com/openai/codex) installed and signed in, it runs on
**your** local agent — no API key, no model configuration, no separate LLM bill,
and your model credentials never touch Deckgauge.

```bash
pnpm deckgauge:advisor   # detects your local agent and connects the panel to it
```

Open a board's Advisor panel while signed in and it authenticates itself with
your existing session. The agent reads board data only through Deckgauge's
read-only, board-scoped MCP tools — every call re-checks your board access
server-side. The bridge also asks the agent to hand it permission decisions, and
auto-denies file edits and shell commands whenever it gets them; if an agent
won't do that, the bridge says so rather than pretending otherwise. It runs a
full local coding agent on your behalf, so read the security model before
pointing it at anything you care about.

No local agent? The panel falls back to a server-side provider (an Anthropic key
or your own Ollama server), configured in **Settings → Advisor**.

Details, including the full security model: [`docs/advisor-local-agent.md`](docs/advisor-local-agent.md)
and [`docs/advisor-mcp.md`](docs/advisor-mcp.md).

---

## Editions

- **Community** — free and source-available, **uncapped** (analyze any number of developers), under the license below. This is the whole product: no metric, board, dashboard or connector is held back for a paid tier.
- **Enterprise** — we host and operate it for you, or you take a commercial license for your own environment, with support attached. Published price, no sales call: [deckgauge.com/pricing](https://deckgauge.com/pricing) · **support@codpal.com**

  What that adds is hosting, support and a commercial license — **not** features taken out of the free core. SSO through Keycloak and the salary / manager-note visibility rules are in the Community edition and stay there. Aggregate-only (works-council) mode, audit logs and SCIM are **designed and not built**: we build them for the customer whose rollout needs one, on an agreed timeline. [deckgauge.com/enterprise](https://deckgauge.com/enterprise) says which is which.

## Advisory & support

Deckgauge is built and maintained by **[CodPal](https://codpal.com)** — fractional CTO-as-a-service for startups and scale-ups. The platform is source-available under the FSL (see [License](#license)) and stands on its own. If you want help acting on what it surfaces — reading your DORA metrics, clearing delivery bottlenecks, or standing up engineering leadership — CodPal offers a **[Deckgauge Engineering Health Check](https://deckgauge.com/health-check)**: a fractional CTO reviews your dashboard and hands you a one-page assessment plus your top three fixes. → **support@codpal.com**

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributors sign off under the DCO/CLA so the code can be used across editions.

## License

**Functional Source License (FSL-1.1-Apache-2.0)**, SPDX id `FSL-1.1-ALv2`. The short
version, because it is the first thing people ask:

**Free to run, at any size, forever.** No developer cap, no seat count, no feature gate on
metrics, no expiry, no license key to run it, nothing that phones home. Running it commercially is fine — including
inside a company that competes with us. Read it, change it, fork it, redistribute it. The one
thing you may not do is offer Deckgauge to other people as a commercial product or service
that substitutes for it, which is to say: do not resell it as a competing hosted service.

**And it converts.** Every release carries an irrevocable Apache-2.0 grant that takes effect
on its second anniversary. `v2.0.0` was published on 11 September 2026, so it is Apache-2.0
licensed from **11 September 2028**. Later releases convert on their own dates.

Why not Apache-2.0 today, what the choice costs us, and the cases people assume are forbidden
and are not: **<https://deckgauge.com/license/>**. The licence itself governs and is in
[`LICENSE`](LICENSE).
