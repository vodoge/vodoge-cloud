# VoDoge Cloud

The multi-tenant control plane for [VoDoge Edge](https://github.com/vodoge/vodoge-edge)
devices: the authoritative home for tenant data, device commands, messaging
history, rules, audit records, and the browser console.

An edge device is a small Linux box with USB cellular modems plugged into it,
sitting on somebody else's network. This repository is what the operator
actually looks at and clicks — and the thing the device dials outward to.

---

## What problem this solves

A cellular modem is easy to talk to when you are sitting next to it and it is
the only one. Neither stays true. Fleets grow, sites are remote, SIMs come from
different carriers with different capabilities, and the network between you and
the hardware is the least reliable part of the system.

VoDoge splits that into two halves that fail independently:

- **The edge agent owns the hardware.** It keeps polling, collecting SMS and
  serving a LAN panel whether or not the Internet exists.
- **The cloud owns the record.** Commands, message history, and audit live here,
  and reach the device when it can be reached.

The link between them is deliberately narrow: one outbound WSS connection per
device, MessagePack frames against a versioned JSON Schema, sequenced with
cumulative acknowledgement so neither side has to trust the network.

## Architecture

```
   browser                          edge site (customer premises)
      │                                     │
      │ HTTPS                               │ outbound WSS + mTLS, TLS 1.3 only
      ▼                                     ▼
┌───────────┐    ┌──────────────────────────────────┐
│  console  │───▶│             gateway              │
│ (Next.js) │    │   /v1 REST  ·  /v1/edge  socket  │
└───────────┘    └───────────┬──────────────┬───────┘
                             │              │
                     ┌───────▼──────┐  ┌────▼─────┐
                     │  PostgreSQL  │  │  Redis   │
                     │ durable, RLS │  │  wakeup  │
                     └──────────────┘  └──────────┘
```

Four containers. Only the gateway is reachable from outside, and it is the only
component that talks to a device.

**PostgreSQL is the durable one.** Commands and their outbox records commit in
one transaction. **Redis is an accelerator, never the queue** — lose it and
delivery gets slower, not wrong: a device reconnect and periodic reconciliation
recover from a dropped wakeup.

**Tenant isolation is row-level security, not a database per tenant.** Tenant
context is set transaction-locally; with no context, every query returns nothing.
`FORCE ROW LEVEL SECURITY` is on, so even the table owner is subject to it —
nothing in the system can enumerate across tenants.

## Deploying

What follows is the real procedure, with hostnames and identifiers replaced by
placeholders. Substitute your own throughout:

| Placeholder | Meaning |
| --- | --- |
| `CLOUD_HOST` | the machine running Compose |
| `EDGE_HOST` | an edge machine |
| `TENANT_ID` | a tenant UUID from `app.tenants` |
| `example.com` | your base domain |

### 1. Prerequisites

Docker with the Compose plugin, on a host with a public address and a DNS name.
Nothing else is required on the host: PostgreSQL, Redis, Go and Node all arrive
in containers or in the build.

### 2. Certificates

The gateway needs two things: a **server** certificate for the name devices will
dial, and a **device CA** whose key it uses to sign client certificates.

```sh
mkdir -p deploy/certs && cd deploy/certs

# Device CA. Its private key never leaves the cloud host.
openssl ecparam -genkey -name prime256v1 -out device-ca.key
openssl req -x509 -new -key device-ca.key -sha256 -days 3650 \
    -subj "/CN=VoDoge Device CA" -out device-ca.crt

# Server certificate for the gateway, signed by the same CA.
openssl ecparam -genkey -name prime256v1 -out gateway.key
openssl req -new -key gateway.key -subj "/CN=gw.example.com" -out gateway.csr
openssl x509 -req -in gateway.csr -CA device-ca.crt -CAkey device-ca.key \
    -CAcreateserial -days 825 -sha256 -out gateway.crt
```

Keep `device-ca.key` at mode `600`. Anything holding it can mint a device
identity for any tenant.

### 3. Configure

Copy the example environment file and fill it in:

```sh
cp deploy/.env.example deploy/.env
```

`.env` holds credentials and ports only. Connection strings are assembled from
them inside `compose.yaml`, and every one is declared `${VAR:?...}` — a missing
value fails the `up` with the name of what is missing rather than starting a
service that cannot reach its database.

What you must fill in:

| Variable | Notes |
| --- | --- |
| `POSTGRES_DB` `POSTGRES_USER` `POSTGRES_PASSWORD` | the database superuser |
| `VODOGE_OWNER_USER` `VODOGE_OWNER_PASSWORD` | owns the schema |
| `VODOGE_APP_USER` `VODOGE_APP_PASSWORD` | what the gateway connects as, and the role RLS policies are written against |
| `REDIS_PASSWORD` | |
| `VODOGE_BASE_DOMAIN` | tenants are subdomains of it |
| `VODOGE_OPS_TENANT` `VODOGE_OPS_TOKEN` | the first tenant and its bootstrap token |

Ports default sensibly and are worth knowing:

| Variable | Default | Exposure |
| --- | --- | --- |
| `VODOGE_GATEWAY_PORT` | `18080` | loopback only — the console and your proxy |
| `VODOGE_CONSOLE_PORT` | `13000` | loopback only |
| `VODOGE_EDGE_TLS_PORT` | `444` | **public** — the only port devices dial |

Certificate paths are fixed at `/certs/...` inside the container and come from
the `deploy/certs` directory you populated above.

### 4. Bring it up

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
```

The `migrate` service runs every migration in order and exits; the other four
stay up. Confirm the gateway came up with mTLS enabled:

```sh
docker logs vodoge-cloud-gateway-1 | grep "gateway listening"
```

`"mtls":true` in that line is the check that matters. Without it the gateway is
accepting unauthenticated device connections.

### 5. Reverse proxy

Point your proxy at the loopback console and gateway ports. The device port is
**not** proxied — devices do mTLS straight to it, and terminating TLS in front
of it would discard the client certificate the gateway authenticates with.

### 6. Enrolling a device

Create a one-time code, then run the edge agent's enrollment with it. The code
is consumed exactly once and yields a fresh device with its own certificate.

In the console, **Devices → Enrollment and certificates**: *Mint a code* mints
one and shows it, and *Revoke* in the certificates table below takes one back.
Both need an admin session; a read-only account is offered neither control.

> **The code is shown once, and that is not merely a UI choice.** `GET
> /v1/enrollment-codes` returns each code's id, expiry and whether it has been
> used — never the code — and the audit entry for minting one records only the
> expiry. Write it down while it is on screen; nothing hands it back. Only the
> database still holds it, because `POST /v1/enroll` compares against it.

By API instead:

```sh
curl -X POST https://console.example.com/v1/enrollment-codes \
     -H "Cookie: <your console session>"
```

Enrollment always creates a **new** device. To move an existing device to
replacement hardware without losing its history, see
[Replacing an edge machine](#replacing-an-edge-machine).

### Updating

The gateway and console are built outside the containers and copied in, so a
deploy is a build, a transfer, and a recreate:

```sh
# Gateway
cd apps/gateway
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
    -o /tmp/vodoge-gateway ./cmd/gateway
scp /tmp/vodoge-gateway root@CLOUD_HOST:/opt/vodoge-cloud/deploy/
```

> **Verify the hash after every transfer.** `sha256sum` on both ends, not
> file size and not scp's exit code. A transfer over a flaky link has produced
> a file of identical size and different content, and the symptom was a process
> that started, listened, and logged nothing at all.

Then rebuild the image from the prebuilt binary and recreate just that service:

```sh
ssh root@CLOUD_HOST 'cd /opt/vodoge-cloud/deploy \
  && docker build -q -t vodoge-cloud-gateway -f Dockerfile.gateway.prebuilt . \
  && cd /opt/vodoge-cloud \
  && docker compose --env-file deploy/.env -f deploy/compose.yaml \
       up -d --no-build --force-recreate gateway'
```

### Migrations

Applied in filename order by the `migrate` service. To apply one by hand, use
the **runner** — never `psql -f` directly:

```sh
scp packages/db/migrations/*.sql root@CLOUD_HOST:/opt/vodoge-cloud/packages/db/migrations/
ssh root@CLOUD_HOST 'cd /opt/vodoge-cloud \
  && PG_CONTAINER=vodoge-cloud-postgres-1 PG_USER=vodoge PG_DB=vodoge \
     ./bin/migrate.sh packages/db/migrations/*.sql'
```

It skips what `app.schema_migrations` already records, applies the rest, and
records each one with its sha256. Pass every file, not just the new one: the
skip is cheap and the checksum comparison is the only thing that ever notices an
applied migration being edited afterwards.

> ⚠️ **This section used to show a bare `docker exec … psql -f`, and that is how
> five migrations came to be applied without being recorded.** The ledger sat at
> 66 while the database was actually at 71 — and the ledger is what a restore
> reads to decide what to replay, so the one artifact disaster recovery depends
> on was silently wrong. Found on 2026-09-17 while checking something else.
>
> Running the real runner afterwards also surfaced an older one: production's
> recorded sha256 for `0066_modem_registry` matched **no committed version of
> that file**. It was applied during the 2026-09-10 incident and the file was
> corrected afterwards — exactly what "a migration, once applied, must not be
> edited" exists to prevent. Reconciled by deleting the stale row and letting the
> runner re-apply (0066 is `IF NOT EXISTS` / `DROP … IF EXISTS` /
> `CREATE OR REPLACE` throughout, and production's schema already matched the
> committed version, both checked first).

CI replays **every** migration against an empty database on each push. That is
what proves the set can be restored, which is a different claim from "it worked
against the one live database".

### Restoring from nothing

⚠️ **Replaying the migrations is not the whole restore.** Three things the
migrations cannot establish have to be in place first, in this order. Until
2026-09-15 none of this was written down, and a database built by replaying the
70 migrations alone refused every device uplink with `permission denied for
schema app` — it looked complete (zero migration errors, RLS and every policy
byte-identical to production) and could not accept a single envelope.

1. **The roles.** `packages/db/bootstrap/roles.sql` creates two of the five the
   migrations name. `vodoge_owner`, `vodoge_gateway` and `vodoge_resolver` come
   from the installer, and two of them are `LOGIN` with passwords — inherently
   an install step, because a password cannot live in a migration.
2. **The database owner.** `deploy/postgres-init/10-create-owner.sh` runs
   `ALTER DATABASE … OWNER TO vodoge_owner`, and it only runs from
   `docker-entrypoint-initdb.d` — i.e. on a *fresh* data directory. Restoring
   into an existing cluster skips it, and then `vodoge_owner` cannot create
   anything.
3. **The migrations**, all of them, with `deploy/bin/migrate.sh`.

> `deploy/migrate.sh` (the other runner) applies 0001–0009 as `vodoge_owner` and
> is how production got its ownership. Do not rely on that: since 0071 the
> migrations set ownership explicitly, so any runner produces the same result.
> That is the point of 0071 — before it, *who ran the migration* decided who
> owned the object, and 0001–0009 contain no `OWNER TO` at all.

`packages/db/tests/a_replayed_database_accepts_an_uplink.sql` is what keeps this
honest: it switches to `vodoge_gateway` and drives a real `accept_ingress` plus a
real `enqueue_command` against the replayed database. It is the only test in the
suite that runs as anything other than a superuser — which is why the suite was
structurally blind to this whole class until it existed.

### Replacing an edge machine

Rebuilt hardware keeps its identity only if you carry two things across.

**The certificate.** Enrollment mints a new device every time, so re-enrolling
orphans the old device's history. Instead, generate a key and CSR on the new
machine and sign it with the device CA using the *existing* device's UUID:

```
CN = <device-id>   O = <tenant-id>   OU = <region>
```

with `keyUsage=digitalSignature`, `extendedKeyUsage=clientAuth`, ECDSA/SHA-256.
The private key stays on the edge machine; only the CSR travels.

**The uplink sequence.** The cloud remembers how many envelopes it has received.
A rebuilt agent starts numbering at 1 and the uplink refuses to proceed:

```
ack cursor 119517 exceeds last allocated sequence 5
```

That refusal is correct — those sequence numbers are already spent. The edge
repository carries a command for it (`uplink-rescue <that first number>`), which
renumbers the pending queue above the cloud's cursor in one transaction, so
nothing queued is lost and nothing is reused.

> ⚠️ **Nothing needs to be read from this side.** The number the agent prints is
> the cloud's own cursor, delivered in every `ResumeAck` from
> `app.ingress_window()` — the longest contiguous run from
> `app.ingress_pruned.pruned_through`. An earlier version of this section sent
> the operator to `SELECT MAX(seq) FROM app.ingress`, which is a *different*
> number: too high whenever the device has rows above that contiguous prefix
> (`missing_ranges` exists to describe exactly those holes), and too low — or
> NULL — once `app.ingress` retention has deleted the acknowledged prefix, which
> is the state any device down long enough to be rebuilt will be in. There is no
> per-device cursor column to read instead; the value is computed on each call.

## Non-negotiable invariants

- Device connections are outbound WSS with mTLS and TLS 1.3 only.
- Redis is a wakeup and routing accelerator, never the durable command queue.
- PostgreSQL commands and their outbox records commit atomically.
- A device reconnect and periodic reconciliation recover from a lost wakeup.
- Tenant context is transaction-local and enforced with row-level security.
  Missing context returns no rows.
- `region` is a column and a certificate field. It is **not** a second database
  or a second site. Docs describing a "regional data plane" describe a split
  that could happen later, not current infrastructure.

## Layout

```
apps/console/       Next.js tenant console (Host routing + zh/en i18n)
apps/gateway/       Go gateway: /v1 REST and the device socket
packages/contract/  Versioned edge-cloud JSON Schema, and types generated from it
packages/db/        PostgreSQL migrations, RLS policies, SQL checks
deploy/             Compose file, Dockerfiles, migration runner
docs/               Protocol semantics, roadmap, execution plan
```

## Development

```sh
cd apps/gateway && go test ./...      # gateway
cd apps/console && npm test           # console: 367 checks, no gateway needed
cd apps/console && npm run typecheck
```

Contract types are generated, not written. If you change the schema, regenerate
or CI will fail:

```sh
python3 packages/contract/codegen/generate.py \
    --go packages/contract/go/contract.go --ts packages/contract/ts/index.ts
```

> The same schema exists in both repositories. It is the one file that will
> drift, so change it in both in the same commit.

CI also runs a cross-repository token-parity check, a lone-CR guard, and the
migration replay described above.

## License, and where to get the source

This repository is under one license: the Apache License, Version 2.0. The full
text is in [`LICENSE`](LICENSE), it applies to every path here, and there is no
per-path exception. Third-party attribution is in [`NOTICE`](NOTICE).

The source is published, free of charge and without an account, at
<https://github.com/vodoge/vodoge-cloud>.

`NOTICE` is not a claim that every dependency is permissive, and it is worth
reading before you redistribute a build. The gateway's eleven third-party Go
modules are MIT or BSD. Of the console's sixteen non-optional runtime packages,
fifteen are MIT/ISC/BSD-3-Clause/0BSD/Apache-2.0 and one — `caniuse-lite` — is
CC-BY-4.0, which binds you to attribution. Separately, `next` declares `sharp`
as an *optional* dependency, and fourteen of `sharp`'s platform binaries carry
LGPL-3.0-or-later; `NOTICE` section 4 records which of the two recipes in
`deploy/` strips them out and which does not.
