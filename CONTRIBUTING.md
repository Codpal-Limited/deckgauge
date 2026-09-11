# Contributing to Deckgauge

Thanks for your interest in improving **Deckgauge** — the open-source engineering-intelligence platform. Contributions of every kind are welcome: bug reports, features, docs, and fixes.

## Ways to contribute

- 🐛 **Report a bug** — open an issue with clear steps to reproduce.
- ✨ **Propose a feature** — open an issue describing the problem first, then your idea.
- 📖 **Improve the docs** — see [deckgauge.com/docs](https://deckgauge.com/docs).
- 🔧 **Send a pull request** — see the workflow below.

## Development setup

Deckgauge is a **pnpm + Turborepo monorepo** (Next.js web, Fastify API, BullMQ worker, Postgres, Redis, ClickHouse, Keycloak).

```bash
git clone https://github.com/Codpal-Limited/deckgauge
cd deckgauge
./scripts/init-env.sh          # writes .env, generating every credential
docker compose up -d
# create the database schema
docker compose run --rm -T api sh -c "cd /app/packages/db && npx prisma db push"
# create the ClickHouse analytics tables
bash scripts/apply-clickhouse-schemas.sh
```

`./scripts/init-env.sh` replaces the old `cp .env.example .env`, which no longer
produces a usable file: every credential in the template is empty and
`docker-compose.yml` declares each one required, so a hand-copied `.env` stops at
`docker compose up` with the variable named. The script refuses to overwrite an
existing `.env` — use `./scripts/init-env.sh --check` to see what one is missing.

Keep the `-T`: it makes `db push` non-interactive. On a database that already holds tables the
Prisma schema does not declare **and that are not empty**, the command then fails with exit 1
instead of blocking on a `(y/N)` data-loss prompt. Do not answer that by adding `--accept-data-loss` — it drops those
tables. It means the database is not a fresh install.

Then open **http://localhost:3000**. Full setup — connecting sources, SSO, access control — is in the [docs](https://deckgauge.com/docs).

For iterating on the code directly: `pnpm install` then `pnpm dev`.

## Before you open a PR

Please make sure these pass:

```bash
pnpm lint
pnpm build
pnpm test
```

`pnpm test` runs every workspace. Each one provisions its own Postgres database
automatically the first time you run it — you only need the test containers up
(`docker compose -p deckgauge-test -f docker-compose.test.yml up -d`).

That command also runs **strict integration mode**: an integration suite that cannot
run — because ClickHouse is unreachable, say — fails the gate with a named reason
rather than reporting as a skip. Running one workspace on its own
(`pnpm --filter @deckgauge/api test`) is lenient and skips instead, with the same
message telling you what to start.

- Add tests for new business logic (validators, services, transforms). Tests use **Vitest**.
- Follow the existing style — Prettier (single quotes, 2-space indent, 100-char width); ESLint must pass.
- Update docs when behavior changes.

## Pull request guidelines

- Branch from `main` as `feature/<slug>` or `fix/<slug>`.
- Keep PRs **focused and small**; explain the *what* and the *why*.
- Reference the issue it addresses.

## Developer Certificate of Origin (DCO)

By contributing, you certify the [DCO](https://developercertificate.org). Sign off your commits:

```bash
git commit -s -m "your message"
```

Signing off lets your contribution be used across Deckgauge's editions (community and enterprise).

## Code of conduct

Be respectful and constructive. Harassment, discrimination, or abuse won't be tolerated.

## License

Deckgauge is licensed under the **Functional Source License (FSL-1.1-Apache-2.0)**. By contributing, you agree your contributions are provided under the same license. See [`LICENSE`](LICENSE).

## Questions?

Open an issue or discussion, or email **support@codpal.com**.
