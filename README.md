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

### Open-source development intelligence — one board across all your dev tools.

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
cp .env.example .env
docker compose up -d
# create the schema, then open http://localhost:3000
docker compose run --rm api sh -c "cd /app/packages/db && npx prisma db push"
```

Then open `http://localhost:3000`, sign in, and create your organization —
only the first person to sign in can, and the demo below attaches to it. It
never creates one for you.

**Want something to look at?** One command fills your organization with a
fictional company: two boards carrying 240 items, a roadmap, a
Platform-vs-Mobile comparison dashboard, a 25-person org chart, timesheets,
and six months of engineering history behind the intelligence dashboards.

```bash
docker compose run --rm api node /app/packages/db/dist/demo/seed-demo.js
```

One more step to see the per-engineer views: open the demo org chart and press
**Sync**. The org tree, roles, locations and timesheets are there as soon as
the seed finishes, but the per-engineer leaderboard, the heat strip and the
per-employee board list are computed by the org-tree sync from the seeded
activity — they stay empty until it has run once.

Remove it whenever you like, and only it — your own boards, connections, and
data are untouched:

```bash
docker compose run --rm api node /app/packages/db/dist/demo/seed-demo.js --remove
```

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
ignored rather than breaking startup. (The one release that does need an `.env`
edit is the `deckgauge` rename, immediately below.)

#### One-time step when upgrading past the `deckgauge` rename

Releases before this one shipped under the project's old internal name,
`vp-cockpit`. Containers, the Compose project, the Keycloak realm and its web
client have all moved to `deckgauge`. Fresh installs get the new names and need
nothing. An **existing** install needs two things after `git pull`.

**First, edit `.env`.** This matters more than it looks. `.env.example` *assigns*
these keys rather than commenting them, and the documented setup is
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

Open source. Multi-tool. No lock-in. Read the queries, run it yourself, trust the numbers.

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

- **Community** — free and open source, **uncapped** (analyze any number of developers), under the license below.
- **Enterprise** — SSO, advanced access control, aggregate-only (works-council) mode, audit logs, and support — as a managed **SaaS** or in your own environment with a commercial license. → [deckgauge.com/enterprise](https://deckgauge.com/enterprise) · **support@codpal.com**

## Advisory & support

Deckgauge is built and maintained by **[CodPal](https://codpal.com)** — fractional CTO-as-a-service for startups and scale-ups. The platform is fully open source and stands on its own. If you want help acting on what it surfaces — reading your DORA metrics, clearing delivery bottlenecks, or standing up engineering leadership — CodPal offers a **[Deckgauge Engineering Health Check](https://deckgauge.com/health-check)**: a fractional CTO reviews your dashboard and hands you a one-page assessment plus your top three fixes. → **support@codpal.com**

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributors sign off under the DCO/CLA so the code can be used across editions.

## License

**Functional Source License (FSL-1.1-Apache-2.0)** — free to use, run, and modify for any purpose except offering it as a competing hosted service; each release converts to Apache-2.0 two years later. See [`LICENSE`](LICENSE).
