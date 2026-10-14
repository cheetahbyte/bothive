# Bothive

Vocabulary: see GLOSSARY.md. Decisions: docs/adr/.

## Commands

- Install: `bun install --frozen-lockfile`
- Lint: `bun run lint`
- Format: `bun run format`
- Format check: `bun run format:check`
- Typecheck: `bun run typecheck`
- Migrate: `bun run migrate` (needs `DATABASE_URL`)
- Generate migration after schema change: `bun run db:generate`
- Test: `TEST_DATABASE_URL=<postgres url> bun run test`
- Admin CLI: `bun run cli -- <user|token|migrate> ...`
- API: `bun run api`
- Worker: `bun run worker`

## Rules

- Node 22 runs everything; Bun is only the package manager.
- Tests drive the HTTP API and CLI against a real PostgreSQL. No mocks of the database.
- Local test database: `pogg create bothive`, then `TEST_DATABASE_URL=$(pogg url bothive)` (add `sslmode=disable` for a local server without SSL).
