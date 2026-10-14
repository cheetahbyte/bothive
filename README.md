# Bothive

Self-hostable platform for persistent, independently owned AI bots. See `GLOSSARY.md` and `docs/adr/`.

## Start the stack

```sh
export POSTGRES_PASSWORD=$(openssl rand -hex 16)
docker compose up -d postgres
docker compose run --rm api node dist/cli/main.js migrate
docker compose up -d api
docker compose run --rm api node dist/cli/main.js user create alice
docker compose run --rm api node dist/cli/main.js token issue alice
```

The token is shown once. Use it as a bearer token:

```sh
curl -H "Authorization: Bearer <token>" http://localhost:3000/bots
```

Revoke with `token revoke <token-id>`. Configuration is in `.env.example`.
