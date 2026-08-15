<!--
PUBLIC-FACING README for the open-source Deckgauge repo (published as README.md).
Separate from the private repo's own README. Keep it public-appropriate.
TODO before launch: drop real product GIFs/screenshots into docs/media/ and reference them
in the "See it in action" section (replace the placeholder comments).
-->

<div align="center">

# Deckgauge

### Open-source development intelligence — one board across all your dev tools.

*See how your software really gets built.*

Turn **Jira, GitHub, GitLab, and Azure DevOps** into one board with the widgets, dashboards,
rankings, and roadmaps engineering leaders use to see what’s really going on.

[![License: FSL-1.1](https://img.shields.io/badge/license-FSL--1.1-0c8f83)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Codpal-Limited/deckgauge?style=social)](https://github.com/Codpal-Limited/deckgauge)

[**Website**](https://deckgauge.com) · [**Docs**](https://deckgauge.com/docs) · [**Enterprise**](https://deckgauge.com/enterprise)

</div>

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
docker compose run --rm api sh -c "cd /app/packages/db && npx prisma db push --skip-generate"
```

Full setup — connecting sources, SSO, access control — is in the [docs](https://deckgauge.com/docs).

---

## What you get

- **📊 Monitoring & visibility** — DORA, flow, throughput, review time, WIP as widgets you watch, centralized across all four tools.
- **🏆 Automatic ranking** — rank contributors by PRs, tickets, commits, and review comments (weights you choose) to find your champions; org-tree badges for delivery streaks and who’s gone quiet.
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
