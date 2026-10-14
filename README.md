# Bothive

Self-hostable platform for persistent, independently owned AI bots. See `GLOSSARY.md` and `docs/adr/`.

## Start the stack

```sh
export POSTGRES_PASSWORD=$(openssl rand -hex 16)
docker compose up -d postgres
docker compose run --rm api node dist/cli/main.js migrate
docker compose up -d api worker
docker compose run --rm api node dist/cli/main.js user create alice
docker compose run --rm api node dist/cli/main.js token issue alice
```

The token is shown once. Use it as a bearer token:

```sh
curl -H "Authorization: Bearer <token>" http://localhost:3000/bots
```

Revoke with `token revoke <token-id>`. Configuration is in `.env.example`.

## Configuration

See `.env.example` for all options and defaults:
- `DATABASE_URL`: PostgreSQL connection URL.
- `PORT`: HTTP API port (default: 3000).
- `WORKER_BOT_ID`: Optional bot ID to scope a worker to a single Bot.
- `JOB_LEASE_DURATION_MS`: Duration of a Job execution lease (default: 30000).
- `JOB_RENEW_INTERVAL_MS`: Interval between lease renewals during a Run (default: 10000).
- `JOB_BACKOFF_BASE_MS`: Base duration for retry exponential backoff (default: 1000).
- `JOB_MAX_ATTEMPTS`: Maximum execution attempts before failing (default: 3).
- `RUN_TIMEOUT_MS`: Time limit for a single Run attempt before aborting (default: 60000).

