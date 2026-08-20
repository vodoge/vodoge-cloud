# Cloud Deployment

This Compose project is an isolated foundation for host `43.108.53.126`:

- PostgreSQL `18.4` with its own named volume;
- Redis `8.8.0` with AOF persistence and a password;
- a one-shot migration job; and
- the initial gateway health process on `127.0.0.1:18080`.

It does not use the host's existing PostgreSQL 16 instance, ports `80`/`443`,
or the existing `vodoge.com` Caddy route.

## First start

Run as root in the repository checkout on the deployment host:

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
# Replace the three password placeholders with distinct random values.
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d postgres redis
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile migrate run --rm migrate
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d gateway
curl --fail http://127.0.0.1:18080/healthz
```

`migrate` is intentionally opt-in. The script skips each currently known
migration only after its marker table exists, so normal Gateway restarts do not
replay schema creation.

## Public Routing

The foundation binds its only host port to loopback. Add a dedicated Caddy site
from `Caddyfile.snippet` only after DNS is ready. The public site must remain
TLS 1.3-only. Device mTLS WSS is not exposed by this initial health service;
the later WSS gateway will have its own mTLS configuration and tests.

## Operations

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --follow gateway
docker compose --env-file deploy/.env -f deploy/compose.yaml exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Never run `docker compose down --volumes` on a live instance because that
removes the isolated PostgreSQL and Redis data volumes.
