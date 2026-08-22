# Cloud runbook

What to actually do on `43.108.53.126`, written from doing it. `README.md`
covers what the Compose project is; this covers operating it.

## The constraint that shapes everything

The host has **2 vCPU and 1.6 GB of RAM**. It cannot build this software. An
attempt to run `go build` there starved sshd badly enough that the box stopped
accepting connections for several minutes, and `next build` is heavier still.

So both images are produced elsewhere and the host only copies a finished
artifact in:

| Service | Built where | Host Dockerfile |
| --- | --- | --- |
| gateway | workstation, `GOOS=linux GOARCH=amd64` | `Dockerfile.gateway.prebuilt` |
| console | workstation, `next build` standalone | `Dockerfile.console.prebuilt` |

`Dockerfile.gateway` and `Dockerfile.console` still build from source. They are
correct and are what a CI runner should use; they are simply not usable on this
host.

## Deploying the gateway

On the workstation:

```sh
cd apps/gateway
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o /tmp/vodoge-gateway ./cmd/gateway
scp /tmp/vodoge-gateway root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

On the host:

```sh
cd /opt/vodoge-cloud/deploy && docker build -t vodoge-cloud-gateway -f Dockerfile.gateway.prebuilt .
cd /opt/vodoge-cloud && docker compose --env-file deploy/.env -f deploy/compose.yaml \
  up -d --no-build --force-recreate gateway
```

`--no-build` matters: without it Compose tries to build from `Dockerfile.gateway`
and the host runs out of memory.

## Deploying the console

Next.js traces `sharp` into the standalone bundle even with image optimisation
off, and its native binary matches the machine that ran the build. Remove it —
the console renders no images, so nothing loads it.

On the workstation:

```sh
cd apps/console
NEXT_TELEMETRY_DISABLED=1 VODOGE_GATEWAY_URL=http://gateway:8080 npm run build
rm -rf .next/standalone/node_modules/@img
mkdir -p dist/public && cp -r .next/standalone/. dist/
rm -rf dist/.next/static && mkdir -p dist/.next/static && cp -r .next/static/. dist/.next/static/
cp -r public/. dist/public/
tar -czf console-dist.tgz -C dist .
scp console-dist.tgz root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

Then the same `docker build` / `up -d --no-build` pair with
`Dockerfile.console.prebuilt` and service `console`.

Copy `.next/static` into a *fresh* directory each time. `cp -r a b` creates
`b/a` when `b` already exists, which silently produces `.next/static/static`
and a console that serves no CSS.

## The contract lives in two places

`packages/contract/` is the source of truth. The edge repository vendors a copy
of the schema and the generator so it can build and run CI without this
repository beside it.

The cost is silent drift, and it has already bitten once: editing the schema
here and regenerating the edge's Rust leaves the edge's *schema* stale, so its
"generated types match schema" check compares new code against an old schema
and fails for a reason that reads like nonsense.

So syncing is one command that does all three parts:

```sh
./scripts/sync-contract.sh
```

Run it after any schema change, before pushing either repository.

## Rate limits

| Endpoint | Limit | Keyed by |
| --- | --- | --- |
| `POST /v1/auth/login` | 5, then one per 12s | client address |
| `POST /v1/auth/password` | 5, then one per 12s | client address |
| `POST /v1/commands` | 30, then two per second | tenant |

Sign-in is keyed by address rather than by account on purpose: limiting by
account lets anyone lock a colleague out by failing their password five times,
which turns a defence into a denial of service.

Commands are keyed by tenant rather than by caller, because they cost a device
real time — an operator scan takes the radio away for over a minute — and two
operators in one tenant should not be able to queue twice as much work for the
same hardware.

The key is the socket's remote address, not `X-Forwarded-For`. If a proxy is
ever put in front of this, that has to change deliberately — until then a
caller setting the header would be choosing their own bucket, which is the
same as having no limit.

## Networks

`backend` is `internal: true`. **Docker silently ignores published ports for a
container attached only to an internal network** — the binding stays in
`HostConfig.PortBindings` and never appears in `NetworkSettings.Ports`, with no
error anywhere. Any service that must be reachable from the host has to join
`edge` as well. Both the gateway and the console do.

## Migrations

```sh
/opt/vodoge-cloud/bin/migrate.sh packages/db/migrations/00NN_name.sql
```

Two things about the schema that are not obvious:

- `SET row_security = off` inside a `SECURITY DEFINER` function does **not**
  bypass RLS. Under `FORCE ROW LEVEL SECURITY` it raises unless the function's
  owner can bypass policies. The three pre-context resolvers are owned by
  `vodoge_resolver`, a `NOLOGIN BYPASSRLS` role that owns nothing else and can
  only read three tables. Anything that writes stays inside the policies.
- Object ownership must be stated explicitly. `0010` did not, so the schema
  depended on which account applied it; `0011` corrects that.

## Creating an operator

```sh
docker cp /opt/vodoge-cloud/deploy/vodoge-admin vodoge-cloud-gateway-1:/usr/local/bin/
DBURL=$(docker inspect vodoge-cloud-gateway-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '^VODOGE_DATABASE_URL=' | cut -d= -f2-)
docker exec -it -e VODOGE_DATABASE_URL="$DBURL" vodoge-cloud-gateway-1 \
  /usr/local/bin/vodoge-admin -tenant a -email you@example.com
```

The password is read from stdin, never a flag: an argument lands in shell
history and in the process list. Minimum twelve characters.

`-disable` deactivates an account and deletes its live sessions in the same
transaction, because otherwise it keeps working until the session expires.

## Removing a tenant

Do not. `audit_log` has a foreign key to `tenants` with no cascade, so any
tenant that has ever been signed in to cannot be deleted — and deliberately so:
the audit trail is the last thing that should disappear with an account.

Offboard by setting `status` instead:

```sql
UPDATE app.tenants SET status = 'disabled' WHERE slug = 'name';
```

`status` is enforced at the gateway boundary: a tenant that is not `active` is
refused before authentication runs, so a suspended tenant cannot be probed for
whether a credential is valid, and cannot mint a new session — which is the one
thing offboarding has to stop.

## Drills

Both were run against this deployment on 2026-08-22.

**Outage (`X-04`).** Block the uplink from the edge and confirm nothing is lost:

```sh
# On the edge host. The rule removes itself, so a dropped session cannot
# leave the box cut off.
iptables -I OUTPUT -d 43.108.53.126 -p tcp --dport 444 -j DROP
sleep 180
iptables -D OUTPUT -d 43.108.53.126 -p tcp --dport 444 -j DROP
```

Result: the edge queued locally and kept its panel and AT console fully
working with the cloud unreachable; the mode badge flipped to `local` on its
own. After restore the backlog drained with **zero gaps** — 28200 rows,
sequence 1 to 28200, no missing ranges.

**Isolation (`X-05b`).** With a second tenant and a session belonging to it:

| Attempt | Result |
| --- | --- |
| Read own tenant | 200 |
| Same session against another tenant's Host | 403 |
| No credential at all | 401 |
| Another tenant's rows under this tenant's SQL context | 0 rows |
| No SQL tenant context at all | 0 rows |
| Insert a row carrying another tenant's id | rejected by policy |

The wrong-region device check (`X-05b`'s second half) is covered by unit tests
and the region values were confirmed to differ live, but no device certificate
from another region has been presented to this gateway.

## Backups

A dump runs at 03:30 daily (`vodoge-backup.timer`), deliberately half an hour
after TREK's on the same box — two `pg_dump`s at once on 2 vCPU starve sshd,
which has happened here before.

It produces two things:

| Path | For | Leaves the machine |
| --- | --- | --- |
| `/opt/vodoge-cloud/stage/` | fast local rollback, 3 days | no |
| `/srv/vodoge-export/vodoge/` | the NAS pulls this over SFTP | yes |

The export carries the dump, the role definitions, the migrations, the compose
file, a redacted `.env`, and a `MANIFEST` with checksums and row counts.

It does **not** carry passwords. Role password hashes are stripped, because a
restore needs each role's *attributes* — `vodoge_resolver` must be `BYPASSRLS`,
`vodoge_app` must not be — and not its password, which lives in the password
manager alongside `.env`. Redis is not backed up either: it holds presence and
wakeup hints, all of which come back from PostgreSQL and a device reconnect.

The script refuses to overwrite a good backup with a bad one. It checks that
`pg_restore --list` can read the archive, and that the archive contains at
least five tables' worth of data — an empty dump passes `--list` perfectly
well, and connecting to the wrong database is the way to produce one.

### Restoring

```sh
docker exec -i vodoge-cloud-postgres-1 psql -U vodoge -d postgres   -c 'CREATE DATABASE vodoge_restored'
docker exec -i vodoge-cloud-postgres-1 psql -U vodoge -d postgres   < roles.sql
docker exec -i vodoge-cloud-postgres-1 pg_restore -U vodoge -d vodoge_restored   < vodoge.dump
```

Then set the role passwords from the password manager, and check the row
counts against the `MANIFEST` **before** pointing anything at it. That is what
catches restoring yesterday's snapshot, or a restore that only half completed,
while it is still cheap to notice.

Restore was drilled on 2026-08-22 against a scratch database: every row count
matched the manifest, and all 21 RLS policies came back with `FORCE` intact on
all 21 tables. Verifying the policies matters more than the rows — a database
that restored without them starts, queries, and shows every tenant everyone
else's data.

## Migrations

Applied through `bin/migrate.sh`, which records each one in
`app.schema_migrations` and skips what is already applied. It refuses to
re-apply a file whose contents have changed since it ran: a changed file under
the same number is the failure ordinary version tracking misses entirely.

Before 0020 there was no record at all of which migrations had run, so the only
evidence that one had been applied was that its columns existed. That is enough
day to day and useless when restoring a dump and needing to know which version
it holds.

## Migrations that cannot run in a transaction

`ALTER TYPE ... ADD VALUE` is refused inside a transaction block, so `0015` and
`0018` — which add command kinds — deliberately have no `BEGIN`/`COMMIT`. Every
statement in them is idempotent on its own, which is what makes a partial
re-run safe.

Adding a command kind to `app.command_kind` is not optional. Without it the
gateway accepts the request, the INSERT fails on the enum, and the operator
sees a queue error for a command that was perfectly valid.

## Proxy configuration

The listeners run on the edge, bound to a modem's interface so traffic leaves
over that SIM. The cloud stores desired state and pushes it; the device
reconciles.

Two consequences worth knowing when something looks wrong:

- A listener with no interface **refuses to start** and reports which modem.
  That is deliberate — the alternative is a listener that quietly uses the
  box's default route, which looks correct from every angle except the exit IP.
- Saving any instance pushes the device its **whole** configuration, not the
  row that changed. A device that missed an earlier change would otherwise stay
  wrong forever.

Binding needs `CAP_NET_RAW` for `SO_BINDTODEVICE`. If every listener reports a
bind failure naming the interface, check the service's capabilities before
looking anywhere else.

## Checking health

```sh
curl --fail http://127.0.0.1:18080/healthz
docker exec vodoge-cloud-postgres-1 psql -U vodoge -d vodoge -tAc \
  "SELECT count(*), max(seq) FROM app.ingress"
docker logs vodoge-cloud-gateway-1 --since 10m | grep WARN
```

A `device session ended` warning around a deploy is the edge reconnecting and
is expected. One at any other time is worth reading.
