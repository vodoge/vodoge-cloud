# Database Foundation

One PostgreSQL holds the tenant directory and all business rows. Isolation is
the `tenant_id` column plus RLS, not a database per tenant or per region.
`region` is a field on `app.tenants` and on device certificates.

## Apply order

Run `bootstrap/roles.sql` once as a PostgreSQL administrator, then apply each
file in `migrations/` in lexical order with a non-superuser migration owner.
The migration owner must not be used by the console or gateway at runtime.

The runtime request rule is mandatory:

```sql
BEGIN;
SET LOCAL app.tenant_id = '<authenticated-tenant-uuid>';
-- Every tenant-scoped query is here.
COMMIT;
```

`SET LOCAL` is intentional. A connection returned to a pool cannot retain a
previous request's tenant context. The RLS policy denies rows when the setting is
missing; it never falls back to a default tenant.

## Command delivery

`app.commands` is authoritative. `app.command_outbox` is a durable request to
wake a gateway, not a queue whose deletion means the command is complete. The
command and outbox record are committed by `app.enqueue_command` in one
transaction. Redis Pub/Sub can lose a wakeup without losing the command because:

1. The dispatcher leases and publishes outbox wakeups only after the transaction
   commits.
2. A gateway queries `app.commands` for the connected device whenever it accepts
   a connection and on a bounded periodic scan.
3. The edge persists a command ID before acknowledging it and returns the same
   receipt/result when delivery is repeated.

The dispatcher uses tenant-scoped `SECURITY DEFINER` procedures through the
`vodoge_dispatcher` role. Do not give the console or gateway's normal tenant
role direct access to `app.command_outbox`. It also cannot insert directly into
`app.commands`; `app.enqueue_command` is the only command creation path because
it atomically creates the outbox record.

## SQL checks

Run these against a disposable database as the migration administrator:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bootstrap/roles.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_regional_data.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0002_command_dispatch_lifecycle.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0003_ingress.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0004_accept_ingress.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0005_tenants.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/app_role_not_superuser.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/rls_coverage.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/tenants.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/tenant_isolation.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/command_outbox.sql
```

The tests deliberately switch to `vodoge_app`; testing RLS as a superuser would
produce a false result because superusers bypass RLS.

Apply every file in `migrations/` in lexical order. `app.resolve_tenant(slug)`
is the Host-lookup path; it does not use `SET LOCAL`. Every other tenant-scoped
query still must.
