# VoDoge Console

Next.js App Router skeleton for C-07 (multi-tenant Host routing) and the C-07b
i18n start (zh/en).

The parent domain is `vodoge.com`. It is **not** a tenant. The first tenant is
`a.vodoge.com` (slug `a`). Unknown subdomains 404 and never fall back to `a`.

## Run

```sh
cp .env.example .env
# /etc/hosts: 127.0.0.1 a.vodoge.com
npm install
npm run dev
```

Open `http://a.vodoge.com:3000`. Middleware reads `Host` / `X-Forwarded-Host`
and calls gateway `GET /v1/tenants/{slug}`. Successful lookups stay in process
memory; a cached region cannot be overwritten.

| Host | Result |
|---|---|
| `a.vodoge.com` | Tenant `a` after a directory hit |
| `vodoge.com`, `www.vodoge.com` | Static “not a tenant” page |
| `{unknown}.vodoge.com` | 404 |
| anything else | 404 |

```
VODOGE_BASE_DOMAIN=vodoge.com
VODOGE_GATEWAY_URL=http://127.0.0.1:18080
```

Set `VODOGE_BASE_DOMAIN=localhost` to use `a.localhost` in development.

## Tests

Host parse and tenant caching are pure functions / in-memory helpers. They do
**not** start Next.js or the gateway:

```sh
npm test
```

That runs `node:test` for `lib/host.test.ts`, `lib/tenant.test.ts`,
`lib/i18n.test.ts`, and `scripts/check-i18n.mjs`. The i18n script fails if `zh`
and `en` keys differ, or if a string is empty. A missing `t()` key renders as
`⟦key⟧` so it is visible in the UI.

## Pages

- `/` — placeholder device list (C-08 will load real devices and SMS)
- `/login` — login stub; no SMS auth yet

The header shows the tenant slug and `tenants.region` (`cn` or `intl`).
Language is a `vodoge.locale` cookie (`zh` default).
