# Cloud runbook

What to actually do on `43.108.53.126`, written from doing it. `README.md`
covers what the Compose project is; this covers operating it.

## The constraint that shapes everything

The host has **2 vCPU and 1.6 GB of RAM**. It cannot build this software.

That is not a preference. On 2026-08-24 a `docker compose build gateway` run on
this host sent it into memory thrashing and **sshd and 443/444 stopped
answering for 107 minutes**. ICMP kept replying and TCP kept handshaking, so it
read as a network fault right up until every ssh attempt died with `Connection
timed out during banner exchange` — sshd could accept a connection and not fork
a child for it. It came back only after a hard reboot from the VPS console.
`next build` is heavier than `go build`, so the console side of this is worse,
not better.

Both images are therefore produced elsewhere, and the host only packages a
finished artifact:

| Service | Built where | Host Dockerfile | Artifact |
| --- | --- | --- | --- |
| gateway | workstation, `GOOS=linux GOARCH=amd64` | `Dockerfile.gateway.prebuilt` | `deploy/vodoge-gateway` |
| console | workstation, `next build` standalone | `Dockerfile.console.prebuilt` | `deploy/console-dist.tgz` |

### The rule is enforced now, not merely written down

The paragraph above predates the incident. So did the line in this runbook
saying `--no-build` matters. **Neither stopped anybody.** A rule that lives only
in a document is a rule that gets skipped by whoever did not read it that day.

`Dockerfile.gateway` and `Dockerfile.console` still build from source — they are
correct and CI should use them — but they now refuse unless told the machine can
take it:

```sh
docker compose build gateway    # fails in under a second, prints what to do
docker build --build-arg VODOGE_BUILD_FROM_SOURCE=yes \
  -f deploy/Dockerfile.gateway -t vodoge-cloud-gateway .   # works, elsewhere
```

The refusal is a build stage selected by an `ARG` in the `FROM` line, so under
BuildKit the Go and Node toolchain images are **not even pulled** before it
fails. Measured here: 0.9 s.

Two nearer-looking fixes were rejected:

- **Delete `build:` from `compose.yaml`.** Then `docker compose build gateway`
  prints `No services to build` and **exits 0** — checked on this host, Compose
  v5.4.0. The operator believes a new image exists, runs `up -d`, and gets the
  old one.
- **Point `build:` at the `.prebuilt` Dockerfile.** Then it succeeds cheaply,
  and succeeds just as cheaply against a `deploy/vodoge-gateway` that is weeks
  stale.

Both trade "the box fell over" for "the box is quietly serving old code", which
is the worse failure, because nothing about it looks wrong.

## Deploying

One command on the host, either service:

```sh
/opt/vodoge-cloud/bin/deploy.sh gateway     # or console, or both
```

It packages the artifact, recreates the container, **and then checks that the
container really is running the image it just built** before reporting success.
It also stores the artifact's sha256 as an image label, so "which build is this
container running" stops being a guess:

```sh
docker inspect vodoge-cloud-gateway-1 \
  --format '{{index .Config.Labels "vodoge.artifact.sha256"}}'
```

If `deploy.sh console` dies at `打包镜像(不编译)` printing `LGPL-3.0-or-later
payload present in console-dist.tgz`, the tarball was packed without the `rm` —
see "Producing the console artifact". Nothing was swapped: the container that
was running before is still running, still serving.

### Why it checks, and why `--force-recreate`

On 2026-08-24, while recovering from the incident above, `docker compose up -d
--no-build gateway` **left the container on the old image and exited 0**:

```text
container image   1168be0d…   ← old, unchanged
freshly built     a2edbce0…
```

The obvious reading is that Compose ignores a rebuilt tag. That reading was
tested on this host and is **wrong** — which matters, because acting on it
leaves the real hole open:

| What actually happened | `up -d --no-build` | with `--force-recreate` too |
| --- | --- | --- |
| tag rebuilt to a new image id | recreates onto the new image | same |
| `docker build` failed, or was never run, so the tag still points at the old image | does nothing, exits 0 | recreates onto the **old** image, exits 0 |

Both rows were reproduced on this host with Compose v5.4.0 and a two-line
scratch image. Compose does notice a changed image id by itself. What it cannot
notice is a build that never produced one — and that is the case that ends with
a container serving old code while every command reported success.
`--force-recreate` does not rescue it. It makes the deploy look *more* like it
happened.

So `--force-recreate` stays in every command below, because it is what makes
redeploying an unchanged tag actually restart the process, and it costs nothing.
But it is not the safety net. The safety net is comparing what is running
against what you meant to ship:

```sh
docker inspect      -f '{{.Image}}' vodoge-cloud-gateway-1   # must equal
docker image inspect -f '{{.Id}}'   vodoge-cloud-gateway     # this
```

`bin/deploy.sh` does that and refuses to report success otherwise. **"Up" is not
evidence** — "Up" is precisely what was on screen while the old binary ran.

By hand, the pair is:

```sh
docker build -f Dockerfile.<svc>.prebuilt -t vodoge-cloud-<svc> .
docker compose --env-file deploy/.env -f deploy/compose.yaml \
  up -d --no-build --force-recreate <svc>
```

`--no-build` is what keeps Compose from compiling here. Then check the two ids,
every time.
### Producing the gateway artifact

On the workstation:

```sh
cd apps/gateway
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o /tmp/vodoge-gateway ./cmd/gateway
scp /tmp/vodoge-gateway root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

The flags are not decoration. `CGO_ENABLED=0` is what lets an Alpine image run
the binary at all, and `-trimpath` plus `-ldflags="-s -w"` is what makes the
build reproducible: the same commit, built twice from a clean tree, gives a
byte-identical binary, so `sha256sum` on both ends answers "is this the artifact
I think it is".

Go stamps the commit into the binary, which is worth knowing when the hashes
disagree and nothing else explains it:

```sh
go version -m /tmp/vodoge-gateway | grep vcs.
```

`vcs.modified=true` means it was built from a dirty working tree — the same
commit built clean will not match it, and neither will match anything anyone
can reproduce later. Prefer committing first.

### Producing the console artifact

Next.js traces `sharp` into the standalone bundle even with image optimisation
off, and its native binary matches the machine that ran the build. Remove it —
the console renders no images, so nothing loads it.

```sh
cd apps/console
NEXT_TELEMETRY_DISABLED=1 VODOGE_GATEWAY_URL=http://gateway:8080 npm run build
rm -rf .next/standalone/node_modules/@img
mkdir -p dist/public && cp -r .next/standalone/. dist/
rm -rf dist/.next/static && mkdir -p dist/.next/static && cp -r .next/static/. dist/.next/static/
cp -r public/. dist/public/
tar -czf console-dist.tgz -C dist .

# Fast feedback, on the workstation, before a 24 MB scp: the fix is one `rm`
# away from here. The copy that cannot be skipped lives in
# Dockerfile.console.prebuilt and runs on the host at deploy time.
if tar -tzf console-dist.tgz | grep -Eq '@img/|libvips.*\.so'; then
  echo 'STOP — LGPL payload in console-dist.tgz, do not ship it:'
  tar -tzf console-dist.tgz | grep -E '@img/|libvips.*\.so'
else
  echo 'console-dist.tgz clean: no @img, no libvips'
fi

scp console-dist.tgz root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

That `rm` is not housekeeping, which is why there is now a check bolted to it.
`@img` is `sharp`'s native half, and on a Linux x64 workstation npm installs two
of them — `@img/sharp-libvips-linux-x64` and `@img/sharp-libvips-linuxmusl-x64`,
32 MB between them. Both are **LGPL-3.0-or-later**, both are a real
`libvips-cpp.so`, and **neither ships a LICENSE file**, so shipping one means
shipping a copyleft binary with no notice and no offer of source.
`apps/console/next.config.ts` sets `images: { unoptimized: true }`, which is
enough to stop anything *loading* them, but tracing is static and never reads
that flag — they get bundled either way.

### 发布账本（publish-ledger）：postgres 在 internal 网络上

`publish-ledger` 是绕开控制台会话的那条发布路径（理由写在它的文件头：
「发布不该需要往 shell 里敲密码」）。但它**不能直接在主机上跑** ——
`deploy/compose.yaml` 里 `backend` 是 `internal: true`，postgres 没有发布任何
端口，主机上 `ss -ltn` 也看不到它。

所以要在那个网络里起一次性容器。二进制是静态链接的（`CGO_ENABLED=0`），
所以随便一个 alpine 都能跑它：

```sh
cd /opt/vodoge-cloud/deploy
DB=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)
U=$(grep -E '^VODOGE_APP_USER=' .env | cut -d= -f2-)
P=$(grep -E '^VODOGE_APP_PASSWORD=' .env | cut -d= -f2-)
docker run --rm --network vodoge-cloud_backend \
  -e VODOGE_DATABASE_URL="postgres://$U:$P@postgres:5432/$DB?sslmode=disable" \
  -v /opt/vodoge-cloud/deploy/publish-ledger:/publish-ledger:ro \
  alpine:3.22 /publish-ledger <tenant-id>
```

产物在开发机上和网关同样地交叉编译：

```sh
cd apps/gateway
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o /tmp/publish-ledger ./cmd/publish-ledger
scp /tmp/publish-ledger root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

⚠️ 它打印的 `devices=N` 是**机队里的边缘机数**（要给几台排命令），
不是受支持硬件数。`device` 这个词在这个代码库里指两样东西 ——
一台边缘机（`catalog.Device`），和一款受支持的硬件型号
（`ledger.SupportedDevice`）。

### 管理目录：`vodoge-catalogue`

这张表没有 tenant_id，是跨租户事实，所以写入面不在控制台上（一个租户不该
能改另一个租户的机队闸）。归宿是 admin.vodoge.com，在那个站有认证之前，
这个 CLI 是唯一的写入路径 —— 和 `publish-ledger` 同一个模式。

本地交叉编译、上传，**不在云端构建**：

```sh
cd apps/gateway
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -o /tmp/vodoge-catalogue ./cmd/vodoge-catalogue
scp /tmp/vodoge-catalogue root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

云主机上（postgres 只在 internal 网络上，所以同样走一次性容器）：

```sh
DB=$(grep -E "^POSTGRES_DB=" /opt/vodoge-cloud/deploy/.env | cut -d= -f2-)
U=$(grep -E "^POSTGRES_USER=" /opt/vodoge-cloud/deploy/.env | cut -d= -f2-)
P=$(grep -E "^POSTGRES_PASSWORD=" /opt/vodoge-cloud/deploy/.env | cut -d= -f2-)
NET=$(docker inspect vodoge-cloud-postgres-1 \
        --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' | head -1)
docker run --rm --network "$NET" \
  -e VODOGE_DATABASE_URL="postgres://$U:$P@postgres:5432/$DB?sslmode=disable" \
  -v /opt/vodoge-cloud/deploy/vodoge-catalogue:/vodoge-catalogue:ro \
  alpine:3.22 /vodoge-catalogue -check
```

`-list` 看现状，`-check` 只算不写，`-add` / `-disable` / `-enable` 改。

**加第一条会被联锁拦住**：它先把机队上每一款在管的硬件列出来、标出谁会被
挡在外面，然后拒绝写入，除非再带 `-i-know-this-gates-the-fleet`。这是有意
的 —— 理由见下一节。

改完**必须跑 `publish-ledger`**，否则边缘端读到的还是上一版文档：这张表
只在渲染文档的那一刻被读。

### 🔴 `app.supported_devices` 空表**不是**「什么都不支持」

`ledger.Document` 在这张表为空时**整个不写** `[[device]]` 键，而不是写一个
空数组。边缘端的 `DeviceGate` 分得很清：没有这个段是 `NotStated`（放行），
有段而某个硬件不在里面是 `Absent`（拒）。

所以一个空的 `[[device]]` 列表会拒掉**每一块**硬件 —— 而这张表在 0057 上线
之后本来就是空的。往里加第一条之前，先明白：**加了第一条，凡是不在表里的
硬件就都不能再纳管了。** 这是这张表的全部意义，但它是一个不可逆向温和的
开关，加之前要把该加的都加齐。

### 🔴 迁移的函数属主是分裂的，`migrate.sh` 对它们跑不通

2026-09-05 应用 0056 时撞出来的。以 `VODOGE_OWNER_USER`（也就是
`migrate.sh` 用的角色）跑，第三条语句失败：

```
ERROR:  must be owner of function project_modem_candidates
```

查下来生产上是这样：

| 对象 | 属主 |
|---|---|
| `app.modem_candidates` / `app.modems` / `app.ingress`（表） | `vodoge_owner` |
| `app.accept_ingress`（0004，走过 `migrate.sh`） | `vodoge_owner` |
| `app.project_modem_candidates`（0050） | **`vodoge`**（超级用户） |
| `app.project_alerts`（0053） | **`vodoge`** |
| `app.project_managed_modems` / `app.apply_managed_modems`（0055） | **`vodoge`** |

也就是说 0050 以后的迁移都是**手工以超级用户应用**的，没走 `migrate.sh`。
后果不是历史遗留，是活的：**任何人跑那条有文档的路径，只要迁移里
`CREATE OR REPLACE` 到这几个函数中的任何一个，就会同样失败。**

而且这几个都是 `SECURITY DEFINER`：归超级用户意味着**它们以超级用户权限
运行**，那是比需要的权限高得多的一档。

两条路，都还没走：

- `ALTER FUNCTION app.<名字>() OWNER TO vodoge_owner`，让 `migrate.sh`
  重新可用，同时把触发器降到它实际需要的权限。⚠️ 这会改变
  `SECURITY DEFINER` 的运行身份，**动之前要确认这几个函数写的表
  `vodoge_owner` 都有权限**（目前看是有的，三张表都归它）。
- 或者承认现状，把「这些迁移要以超级用户跑」写进流程 —— 但那等于
  让每次迁移都以超级用户执行，方向是反的。

在定下来之前，**碰到这几个函数的迁移必须以 `POSTGRES_USER` 跑**，
就像 0056 这次一样。

### 迁移的记录约定

`app.schema_migrations`（0020 建的）有一列 `sha256`，注释说它的用途是
「a migration edited after being applied is detectable」。到 0055 为止
**每一行都是 NULL**，没人填过。0056 是第一条填了的：

```sh
docker exec vodoge-cloud-postgres-1 psql -U "$AU" -d "$DB" -c \
  "INSERT INTO app.schema_migrations (version, name, sha256) VALUES (56, '0056_...', '<sha256>')"
```

值得继续填：一列存在却永远为空，和没有这一列的区别只在于它看起来像有守卫。

### 上生产之前先做回滚测试

0056 的两个问题都是这样发现的（属主，以及确认 DDL 在真实 schema 上可行）。
做法是把文件末尾的 `COMMIT;` 换成 `ROLLBACK;`，然后在**生产库**上整份跑一遍：

```sh
sed 's/^COMMIT;$/ROLLBACK;/' <迁移文件> > /tmp/t.sql
docker cp /tmp/t.sql vodoge-cloud-postgres-1:/tmp/t.sql
docker exec vodoge-cloud-postgres-1 psql -U "$AU" -d "$DB" -v ON_ERROR_STOP=1 -f /tmp/t.sql
```

它在真实的表、真实的属主、真实的数据上执行一遍再撤销 —— 比任何一个
干净的测试库都更接近实际。⚠️ 前提是迁移文件本身以 `BEGIN;` 开头、
以单独一行的 `COMMIT;` 结尾（本仓的都是）。

### Producing the admin artifact

`admin.vodoge.com` 的源码在**另一个仓库**：`vodoge-admin`。产物打包和换镜像
走的是这个仓库的 `bin/deploy.sh`，理由写在 `deploy/Dockerfile.admin.prebuilt`
的文件头。

⚠️ 2026-09-05 实测：`admin` 的依赖里**根本没有 sharp**，`next build` 的静态
tracing 照样把 **33 MB 的 `@img`** 拖进 standalone 包。所以下面那个 `rm` 和
console 那个同样是必须的，不是照抄。

```sh
cd ../vodoge-admin           # 另一个仓库
NEXT_TELEMETRY_DISABLED=1 VODOGE_GATEWAY_URL=http://gateway:8080 npm run build
rm -rf .next/standalone/node_modules/@img
mkdir -p public dist/public && cp -r .next/standalone/. dist/
rm -rf dist/.next/static && mkdir -p dist/.next/static && cp -r .next/static/. dist/.next/static/
cp -r public/. dist/public/
tar -czf admin-dist.tgz -C dist .

if tar -tzf admin-dist.tgz | grep -Eq '@img/|libvips.*\.so'; then
  echo 'STOP — LGPL payload in admin-dist.tgz, do not ship it:'
  tar -tzf admin-dist.tgz | grep -E '@img/|libvips.*\.so'
else
  echo 'admin-dist.tgz clean: no @img, no libvips'
fi

scp admin-dist.tgz root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

然后在主机上：

```sh
/opt/vodoge-cloud/bin/deploy.sh admin
```

#### 🔴 在 Caddy 那段配好之前，不要把域名解析过去

这个站写的是**跨租户**配置。鉴权方案是 mTLS 客户端证书（见
`docs/device-catalogue.md`），而在 Caddy 里那段客户端证书校验配上之前，
`admin` 容器是一个**没有任何登录**的写入端。compose 只把它发布到
`127.0.0.1`，所以此刻它不在公网上 —— 让它上公网的那一步是解析域名 +
加 Caddy 反代，那两件事必须和证书校验一起做，不能分两次。

#### 工作站上装 npm 的注意

2026-09-05：`registry.npmjs.org` 在这台机器上 20 秒连不上，
`registry.npmmirror.com` 2.2 秒。装依赖时用

```sh
npm install --registry=https://registry.npmmirror.com
```

命令行参数，**不要**写进全局配置或提交 `.npmrc` —— 换个网络环境的人会因此
拿到一份和 lockfile 对不上的解析。

### The two console paths, and why they drifted

`deploy/Dockerfile.console` did not have this `rm`. Measured 2026-08-26 by
building it: **241 MB with `@img` in `/app/node_modules`, 207 MB without.** The
shipped image was never affected — production runs
`Dockerfile.console.prebuilt` over the tarball this section produces, and this
section has always stripped `@img`. What was affected is the from-source path,
the one the top of this file calls correct and tells CI to use.

It drifted for the ordinary reason: the rule lived in this document, and
`Dockerfile.console` does not read documents. So it no longer lives only here.
`Dockerfile.console` now does the same `rm`, **and then fails the build if an
`@img` directory or a `libvips*.so*` survives into the finished image** — the
`rm` and the assertion are separate on purpose, so that deleting the `rm`, or a
`next` upgrade that renames the traced package, stops the build instead of
quietly refilling the image. Verified by deleting the `rm` and rebuilding: the
build fails and names the two `.so` files.

`Dockerfile.console.prebuilt` now carries the same assertion. It cannot check
the tree the `rm` acted on — it only ever sees `console-dist.tgz` — so it checks
the tree that comes *out* of the tarball, which is the tree the container will
serve. Verified 2026-08-26 by building that file three ways:

| Tarball | Assertion | Result |
| --- | --- | --- |
| stripped, 2391 entries | present | builds, 207 MB, `✓ Ready in 274ms` |
| unstripped, 2418 entries | present | **build fails**, names `@img` and both `libvips-cpp.so.8.17.3` |
| unstripped, 2418 entries | deleted | builds, exits 0, **241 MB with the payload inside** |

The third row is the whole argument. Without the assertion, a poisoned deploy
produces no error, no warning and a container that starts in 274 ms.

`bin/deploy.sh` gets this for free: it is what runs `docker build -f
Dockerfile.console.prebuilt`, under `set -euo pipefail`, **before** it touches
the running container. A bad tarball stops the deploy at `打包镜像(不编译)`,
the old container keeps serving, and `up -d` is never reached. The host pays one
`find` over the extracted tree for this — 5.8 s on the workstation, no
compilation, nothing this file's opening constraint objects to.

`bin/deploy.sh` was deliberately **not** given a check of its own. Two copies of
one rule are not twice the safety; they are one more thing that can rot while
still looking like a guard, and the one that rots is always the one nobody runs.

By that argument the `tar -tzf` block above is a duplicate too, and it stays for
exactly one reason: it fails on the workstation, minutes earlier and one `rm`
from the fix. It is fast feedback, not the guarantee. If the two ever disagree,
the Dockerfile is right — it is the one that runs whether or not anybody read
this file. **If you change one path, change both.**

Copy `.next/static` into a *fresh* directory each time. `cp -r a b` creates
`b/a` when `b` already exists, which silently produces `.next/static/static`
and a console that serves no CSS.

### Checking the console is really up

`curl http://127.0.0.1:13000/` answers **404**, and that is correct: routing is
by hostname, and no `Host` header means no tenant. Ask it the way a browser
does:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: a.vodoge.com' \
  http://127.0.0.1:13000/login          # 200
curl -s -o /dev/null -w '%{http_code}\n' -L https://a.vodoge.com/  # 200, at /login
```

A bare `/` used as a health probe reports a healthy console as broken, which is
why `bin/deploy.sh` sends the header.

### Rolling back

`bin/deploy.sh` tags the outgoing image `vodoge-cloud-<svc>:rollback-<stamp>`
before it builds. To go back, re-point the tag and recreate — the same two
commands, `--force-recreate` included for the same reason:

```sh
docker tag vodoge-cloud-gateway:rollback-20260824-181500 vodoge-cloud-gateway
docker compose --env-file deploy/.env -f deploy/compose.yaml \
  up -d --no-build --force-recreate gateway
```


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

## Design tokens live in two repositories

The same story as the contract, with a different resolution. The console's
`apps/console/app/globals.css` and the edge panel's `edge-panel/src/index.html`
declare the same token names with the same values. The edge copies them **by
hand**: it is one self-contained HTML file served by a Rust binary with no
toolchain on the box, so there is no build step and no generator to lean on.

The guarantee is the `tokens` job in `.github/workflows/ci.yml`. It clones the
edge repository beside the checkout and scores both trees on every push and
pull request to this repository, with no credential — both repositories are
public. **Nothing about it has to be remembered.**

Fast feedback on the workstation, from the repository root, before you push:

```sh
node scripts/check-token-parity.cjs . ../vodoge-edge   # 0 agree, 1 drift, 2 could not run
```

**That command is fast feedback, not the guarantee** — the same distinction the
`tar -tzf` block above draws, and for the same reason: it fails minutes earlier
and next to the fix. If it and CI ever disagree, CI is right; it is the one that
runs whether or not anybody read this file.

🔴 **Both roots are required, and there are no defaults.** Passing none exits 2
and says so. Two hardcoded absolute paths used to sit in that script as
defaults, and they were a false-green generator: on the one workstation whose
paths they were, the no-argument form ran from **any** directory and silently
scored the two main trees. Measured — a throwaway copy with `--touch` genuinely
broken at one end returned `PARITY OK`, exit 0, because the copy was never what
it read. This repository has thirty worktrees. Every run now prints the two
absolute paths and the two HEADs it actually read, first, before anything else.

⚠️ `--edge <path>` does not work and never did, though it has been recommended
in writing. `--edge` is discarded as an unknown flag and the path after it
becomes the **cloud** root, so the run fails looking for a stylesheet under the
edge tree. Pass two bare paths.

### Landing order: the edge side goes first

The job reads edge `main`, which makes the order one-directional:

| Change | Order |
| --- | --- |
| A token moving at **both** ends | **Merge the edge PR first**, then the cloud one. |
| Anything else | No constraint. |

Doing it the other way round leaves the cloud PR red until the edge merge
lands. **That is the guard working, not the guard broken** — write it off as a
false alarm and you have taught yourself to ignore the one check that reads
both trees. It is not a deadlock: only one direction queues, because only one
side checks.

Two consequences worth knowing before they surprise you:

- **It floats.** A commit that was green here can go red when re-run, because
  edge `main` moved underneath it. The verdict is correct — that is real drift
  — but re-running an old commit is not reproducible. ⚠️ **Do not pin the edge
  ref to fix this.** A pinned copy is the two-snapshots design that was
  rejected, and the reason still holds: each repository's author can edit their
  own snapshot, so both CIs go green while the two trees really have drifted.
- **It fires on cloud activity only.** A one-sided drift committed to the edge
  repository sits undetected until the next push here.

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

## What is on the internet

Caddy owns 80 and 443 on this host and runs in the **TREK** compose project, so
VoDoge publishes no public listener of its own.

| Hostname | Serves |
| --- | --- |
| `vodoge.com` | the console |
| `a.vodoge.com` | the console, with `/v1/*` going to the gateway |
| `:444` | the device uplink, mTLS, published directly by the gateway |

`plugins.vodoge.com` was removed along with the plugin system.

Caddy reaches the services **by container name**, which is why the console and
gateway join `trek_default` as an external network called `ingress`. Pointing
Caddy at the docker bridge address instead does not work, and fails in the most
misleading way available: a port published to `127.0.0.1` is reachable from the
host's loopback and not from a bridge address, so both hostnames answered 502
for as long as that configuration stood while every check run on the host
itself passed. Everything in this runbook that curls `127.0.0.1` was — and
still is — testing the service, not the way anyone reaches it.

The site blocks are copied into `deploy/caddy-vodoge.snippet` for reference;
the live file is `/opt/trek/Caddyfile`. After editing it:

```sh
docker exec trek-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec trek-caddy caddy reload --config /etc/caddy/Caddyfile
```

`reload` does not interrupt TREK, which is served by the same process.

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

## The command relay

Commands are queued by the console and handed to a device when it is
connected. Two things about that path are worth knowing, because both were
broken and neither announced itself.

**Grants.** `PendingForDevice` joins `app.command_outbox` for the attempt
count. `vodoge_app` had no SELECT on that table, the query failed every time,
and the caller discarded the error — so every command ever issued sat in
`queued` forever while the device stayed connected and healthy. A queued
command looks exactly like one waiting for a device that has not reconnected,
which is why it went unnoticed. Fixed in 0027; the error is reported now.

**When delivery happens.** Originally only at Resume, so a command issued to a
connected device waited for the link to drop — hours, for a healthy device.
Hooking it to the heartbeat did not work either: a device polling its modems
every eight seconds never goes idle long enough to send one. It now runs off
any inbound envelope, rate limited to once every five seconds.

To check whether commands are reaching a device:

```sh
docker logs vodoge-cloud-gateway-1 --since 5m | grep "delivering queued commands"
docker exec vodoge-cloud-postgres-1 psql -U vodoge -d vodoge -tAc   "SELECT count(*) FROM app.command_receipts"
```

Deliveries logged with no receipts arriving means the gateway is sending and
the edge is not answering — the problem is on the device, not here.

## Metrics

`GET /metrics` on the gateway, Prometheus text format, no client library —
the set of measurements is small and fixed and a dependency tree is a real
cost on a host with 1.6 GB of memory.

```sh
curl -s http://127.0.0.1:18080/metrics
```

Served on the plain HTTP listener only, which is published to 127.0.0.1. The
device listener is a different port with mTLS, and operational numbers should
not be reachable from the internet.

Route labels are the matched *pattern*, never the path. A label per device id
is an unbounded number of series, which is how one deployment destroys a
metrics system.

The most useful three:

| Metric | Reads |
| --- | --- |
| `vodoge_device_sessions_active` | how many devices are connected right now |
| `vodoge_contract_violations_total` | an edge sending values outside the schema |
| `vodoge_requests_rate_limited_total` | someone hitting a limit, by route |

## Checking health

```sh
curl --fail http://127.0.0.1:18080/healthz
docker exec vodoge-cloud-postgres-1 psql -U vodoge -d vodoge -tAc \
  "SELECT count(*), max(seq) FROM app.ingress"
docker logs vodoge-cloud-gateway-1 --since 10m | grep WARN
```

A `device session ended` warning around a deploy is the edge reconnecting and
is expected. One at any other time is worth reading.
