# Plugins are not ported to the cloud

Decided 2026-08-22. Recorded here because the absence of a feature is
invisible, and the next person to compare the two products will find six
routes in the old one and nothing here.

## What the old system did

`internal/extensions` is a process manager and a reverse proxy. Installing a
plugin means:

1. Upload a zip, or give a URL the server downloads and checks against a SHA.
2. Unpack it to `<plugin-dir>/<id>/` on the machine.
3. Read its manifest and, if it declares a backend, **`exec` the executable it
   shipped**, on a randomly chosen local port.
4. Serve its static assets straight off disk at `/plugin-assets/:id/*`.
5. Reverse-proxy the plugin's own requests to that local port, stripping
   `Authorization`, `Cookie` and `X-CSRF-Token` and adding `X-VoDoge-Plugin-ID`.
6. Launch its pages with a one-time HMAC capability token, 30 minute expiry.

The isolation is thoughtful for what it is: the plugin never sees the operator's
credentials, and the capability token bounds a session.

## Why it cannot come across

That design rests on an assumption that holds on a single-tenant box and fails
here: **the machine belongs to the person installing the plugin.**

In the cloud one process serves every tenant. `exec` of an uploaded binary means
tenant A's code runs on the host holding tenant B's data, with the full
privileges of the process — the filesystem, the database socket, the internal
network. None of the isolation this product relies on operates at that level:
RLS is enforced by PostgreSQL against a session variable, and a plugin backend
does not go through PostgreSQL sessions at all. It goes around them.

So this is not a question of effort. Porting it as designed would remove the
tenant isolation everything else here is built to preserve.

## What was decided

Cut. The user confirmed no one uses the plugin system.

## What to do if it is ever wanted again

Two shapes work, and the choice depends on what plugins are actually for:

- **Extending hardware behaviour** — ship them to the edge instead. An edge box
  belongs to one tenant, so the old trust model holds unchanged. The cloud
  distributes and manages the manifest; the code runs where the modems are.
  Costs: cross-compilation for the edge's architectures, and plugin
  communication has to go through the command relay.

- **Customising the interface** — allow front-end-only plugins: static assets
  plus the platform's own API, no uploaded executables, isolated by iframe and
  CSP, keeping the capability-token scheme. Much smaller, and it covers report
  and dashboard customisation, which is what most plugin systems end up being
  used for.

What does not work is the middle: uploading executables to shared
infrastructure. If that is ever required, it needs real sandboxing — a
container or VM per plugin with its own network policy — which is a platform
project, not a feature.
