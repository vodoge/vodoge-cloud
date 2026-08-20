# VoDoge Cloud

VoDoge Cloud is the multi-tenant control plane for VoDoge Edge devices. It is
the authoritative home for tenant data, device commands, messaging history,
rules, audit records, and the browser console.

## Current scope

The first implementation slices establish the contracts that the edge and cloud
cannot safely improvise later:

- `packages/contract` is the single JSON Schema source for edge-to-cloud
  messages, resume, acknowledgements, command receipts, and command results.
- `apps/gateway` provides a Go TLS transport foundation that requires mTLS and
  TLS 1.3.
- `packages/db` defines the regional PostgreSQL tenant boundary, durable command
  outbox, idempotency, and RLS tests.

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
apps/gateway/       Go long-connection gateway foundation
packages/contract/  Versioned edge-cloud protocol schema
packages/db/        PostgreSQL regional data-plane migrations and SQL checks
docs/                Protocol and delivery semantics
```

## Checks

The gateway tests run with Go:

```sh
cd apps/gateway
go test ./...
```

Database tests require a disposable PostgreSQL instance; see
`packages/db/README.md` for the migration and test order.
