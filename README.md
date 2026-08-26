# VoDoge Cloud

VoDoge Cloud is the multi-tenant control plane for VoDoge Edge devices. It is
the authoritative home for tenant data, device commands, messaging history,
rules, audit records, and the browser console.

## License, and where to get the source

This repository is under one license: the Apache License, Version 2.0. The full
text is in [`LICENSE`](LICENSE), it applies to every path here, and there is no
per-path exception. Third-party attribution is in [`NOTICE`](NOTICE).

The source is published, free of charge and without an account, at
<https://github.com/yuanshuai1122/vodoge-cloud>.

`NOTICE` is not a claim that every dependency is permissive, and it is worth
reading before you redistribute a build. The gateway's eleven third-party Go
modules are MIT or BSD. Of the console's sixteen non-optional runtime packages,
fifteen are MIT/ISC/BSD-3-Clause/0BSD/Apache-2.0 and one — `caniuse-lite` — is
CC-BY-4.0, which binds you to attribution. Separately, `next` declares `sharp`
as an *optional* dependency, and fourteen of `sharp`'s platform binaries carry
LGPL-3.0-or-later; `NOTICE` section 4 records which of the two recipes in
`deploy/` strips them out and which does not.

## Where this actually runs

There is exactly **one** cloud host today, and **one** edge deployment. Nothing
else exists — no fleet, no staging tier, no second region.

| Role | Host | Notes |
| --- | --- | --- |
| Cloud control plane (this repo) | `43.108.53.126` | Gateway + console + PostgreSQL + Redis, via Compose |
| Edge agent | `192.168.6.83:2222` | Local VMware VM, EC20 modems attached |
| Base domain | `vodoge.com` | |
| First tenant | `a.vodoge.com` | That tenant is us |

The Compose project is isolated from the host's pre-existing PostgreSQL 16,
ports `80`/`443`, and the existing `vodoge.com` Caddy route — see
[`deploy/README.md`](deploy/README.md).

`region` is a column on `tenants` and a field in the device certificate. It is
**not** a second database or a second site. Docs that say "regional data plane"
describe a split that could happen later, not current infrastructure.

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
docs/               Protocol semantics, roadmap, and the handoff plan
```

## Picking up the work

Start at **[docs/execution-plan.md](docs/execution-plan.md)**. It carries the
environment, the build-and-deploy steps for each component, the traps that have
already bitten someone, and the phased task list with real acceptance criteria.

[docs/feature-matrix.md](docs/feature-matrix.md) says what exists today,
line by line, against the previous single-machine product and against VoCat.

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
