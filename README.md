# VoDoge Cloud

VoDoge Cloud is the multi-tenant control plane for VoDoge Edge devices. It is
the authoritative home for tenant data, device commands, messaging history,
rules, audit records, and the browser console.

## Current scope

The first implementation slices establish the contracts that the edge and cloud
cannot safely improvise later:

- `packages/contract` is the single JSON Schema source for edge-to-cloud
  messages. Go and TypeScript types are generated from it; CI fails if they drift.
- `apps/gateway` provides a Go TLS 1.3 mTLS transport foundation and an in-memory
  slug-to-tenant cache.
- `packages/db` is one PostgreSQL: tenant directory, devices, messages, commands,
  RLS, and an immutable `region` field on `app.tenants`. Isolation is `tenant_id`,
  not a database per tenant or per region.

## Non-negotiable invariants

- Device connections are outbound WSS with mTLS and TLS 1.3 only.
- Redis is a wakeup and routing accelerator, never the durable command queue.
- PostgreSQL commands and their outbox records commit atomically.
- A device reconnect and periodic reconciliation recover from a lost Pub/Sub
  wakeup.
- Tenant context is established transaction-locally and enforced with PostgreSQL
  row-level security. Missing context returns no rows.

## Layout

```
apps/console/       Next.js tenant console (Host routing + zh/en i18n)
apps/gateway/       Go long-connection gateway foundation
packages/contract/  Versioned edge-cloud protocol schema
packages/db/        PostgreSQL migrations and SQL checks (shared tables + RLS)
docs/                Protocol and delivery semantics
```

## Checks

The gateway tests run with Go:

```sh
cd apps/gateway
go test ./...
```

Console Host parse, tenant cache, and i18n key checks (no gateway required):

```sh
cd apps/console
npm test
```

Database tests require a disposable PostgreSQL instance; see
`packages/db/README.md` for the migration and test order.
