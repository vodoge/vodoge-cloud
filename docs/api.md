# 网关 HTTP API

机器可读的描述是 **OpenAPI 3.1**，由网关自己供出：

```
GET https://<tenant>.vodoge.com/v1/openapi.json
Authorization: Bearer <会话令牌>
```

这份文档覆盖网关注册的**全部**路由（当前 66 条模式 / 68 处注册）。
源头在 `apps/gateway/cmd/gateway/openapi.go`，渲染器在
`apps/gateway/internal/openapi/spec.go`。

## 为什么它不会变成下一个「56」

`feature-matrix.md` 上那个「56 条路由」在实际有 66 条之后还挂了很久，
**没有任何东西提醒过**。一份手抄的 OpenAPI 会以完全一样的方式烂掉，
而且更糟：客户端会信它。

所以这份文档被两道东西钉在路由表上，两道都不需要谁记得去做：

1. **构建期漂移测试**（`cmd/gateway/openapi_test.go` 的
   `TestOpenAPIDescribesEveryRegisteredRoute`）。
   它用 `main_test.go` 里那个 `routesFromSource` —— 也就是只读会话守卫用的**同一个**
   枚举器 —— 从源码里静态读出每一处 `mux.Handle` / `mux.HandleFunc` 的 pattern，
   然后和 `apiOperations()` 声明的集合**双向**比对：
   - 注册了但没写描述 → 红，并指出是哪个文件注册的；
   - 写了描述但没注册 → 红（删了路由没删描述，或路径打错）。
2. **运行期自检**（`serveOpenAPI`）。构建期测试证明的是**这棵源码树**，
   对**实际部署的那个二进制**什么都没说。所以供出文档之前，
   二进制会拿活的 `*http.ServeMux` 逐条解析每一个被描述的操作；
   只要有一条解析不到，就 500 并把路由名字打出来，**不供出一份错的地图**。
   反方向（注册了但没描述）运行期查不了 —— `http.ServeMux` 不能枚举 ——
   那半边由第 1 条负责。

## 哪些东西是派生的，不是写下来的

写下来的东西会和代码不一致，而且没人会发现。所以能派生的都派生了：

| 内容 | 从哪来 |
| --- | --- |
| 路径参数（`{iccid}` / `{section}` / `{action}` …） | 路由 pattern 本身；描述可以补，但**造不出** pattern 里没有的参数 |
| `operationId` | 方法 + 路径；两条路径撞名会在渲染时报错 |
| `POST /v1/commands` 的 `kind` 枚举 | `commands.Kinds()` |
| `PUT /v1/settings/{section}` 的 section 枚举 | `settings.Sections()` |
| 通知测试路由的 channel 枚举 | `settings.NotificationChannels()` |
| 写路由的 403「只读账号」应答 | `auth.ChangesState` + `auth.OwnCredential`，与守卫用的是同一对谓词 |
| 401 / 404 | 是否声明了会话安全方案 |

人写的只剩**散文**：每条路由干什么、收什么、为什么是这个形状。

## 鉴权：为什么这个端点自己也要会话

它暴露的是这套系统**完整的攻击面地图** —— 每条路径、每个方法、
哪三条豁免只读守卫、哪条收 `X-VoDoge-Ops-Token`、在哪铸设备注册码。
这些都不是「保护着什么」的秘密，但公开它对真正的读者毫无增益
（控制台和运营者手上都有会话），却省掉了扫描器猜的功夫。
唯一拿不到会话的调用方是构建期工具，而构建期工具可以直接读 `openapi.go`
（`TestWriteOpenAPIDocument` 就是干这个的）。

只读账号可以读它 —— 那正是最可能被交给「想知道这套 API 长什么样」的人的账号。

## 哪几条不需要凭据（以及 `GET /v1/events` 为什么不再在里面）

不需要凭据的路由**只有八条**，钉在
`TestOpenAPISecurityMatchesTheRoutesThatAreActuallyOpen` 的 `want` 里，
每条都在那里逐条写了理由：

| 路由 | 为什么开放 |
| --- | --- |
| `GET /healthz` `GET /readyz` `GET /metrics` | 只在环回监听器上，不发布到 127.0.0.1 之外。编排器手上没有会话 |
| `GET /v1/tenant` `GET /v1/tenants/{slug}` | 会话之前就要用：得先画出登录页、先知道这个子域名存不存在。只答租户自己的公开身份，且**枚举不了** —— 你得先知道 slug 才问得出来 |
| `POST /v1/auth/login` | 挡住它等于把登录请求送去登录页，此后永远拿不到会话。改用按客户端地址限流 |
| `POST /v1/auth/logout` | 会话已经没了也得能登出 |
| `POST /v1/enroll` | 设备还没有证书 —— 拿证书正是这一调用的目的。凭据是 body 里的一次性码 |

**`GET /v1/events`（SSE 上行流）曾经在这张表上，2026-08-24 由 T065 挪走了。**

它当初的实现从 `Host` 头解析租户然后直接订阅，**什么都不鉴**。
`readOnly()` 只守写操作，所以它一路畅通：内部监听器上 `/v1/devices` 答 **401**、
它答 **200**；更糟的是 `X-Forwarded-Host` —— 控制台合法会设、因而调用方也能设 ——
**决定了订阅哪个租户**，于是租户 A 的会话指向 `b.vodoge.com` 就能读到租户 B 的上行。
公网那一侧当时只有一条反向代理规则挡着，而那条规则在云主机上、
**不在任何仓库里、也没有任何测试覆盖**。那正是 T011 那次事故的形状，掉了个方向。

### 为什么用 Bearer，而不是给 SSE 单发一次性 ticket

浏览器的 `EventSource` **不能带自定义头** —— 这通常正是「给 SSE 铸一次性 ticket」的理由。
但控制台不需要：会话令牌放在 httpOnly cookie 里，
控制台的 Next.js 中间件（`apps/console/middleware.ts` → `lib/session.ts` 的
`gatewayAuthHeader`）在把 `/v1/*` 重写到网关**之前**，就把那个 cookie 变成了
`Authorization: Bearer <token>`。

这套机制**本来就是承重的** —— 设备页上任何一个按钮能 `POST /v1/commands`，
靠的就是它。所以这次不是给流加一种新凭据，而是**让流不再是例外**：
`/v1/commands`、`/v1/messages/thread`、`/v1/devices/{id}` 从 T023 起都走这条路，
浏览器可达的 `/v1` 路由里只有它一条没走。
一次性 ticket 会引入**第二种凭据类型**，连带自己的存储、过期与吊销语义，
只为了到达第一种凭据已经到达的地方。

**还有一个是有意的后果**：万一哪天反向代理又被改成让 `/v1/*` 绕过控制台直连网关
（T011 的原样重演），这条流现在会**失败在关的一侧**（401），
而不是安静地把上行喂给任何人。实时指示灯不动是响的，流开着不是。

### 文档和服务端各自被谁钉住

上面那张表是**本包里两个列表互相同意** —— 而「测试比对的常量和被测的常量同源」
这个仓库已经被咬过一次（T011 的双重编码 bundle）。所以还有第二道，
问的是**服务端**不是文档：

`TestEveryTenantRouteRefusesAnAnonymousCaller` 把文档里每一条声明了会话安全方案的
操作（当前 **56** 条）**不带任何凭据**打在真的 handler 上，要求全部 **401**。
`/v1/events` 在整套测试全绿的情况下开放了好几个月，就是因为
**从来没有人拿这个问题去问过路由器**。现在一次问 56 条。

## 只读账号的边界：为什么 `GET /v1/proxy/instances/export` 是个例外

只读守卫**按 HTTP 方法判定** —— `auth.ChangesState` 之外的方法一律放行。
这对另外 65 条是对的规则，对这一条**恰好是错的**：

`GET /v1/proxy/instances/export` 是全站**唯一**会返回代理口令的路由
（其余地方 `Instance.Password` 是 `json:"-"`，两个 store 都不 select 那一列）。
它是 GET，所以守卫会放行，而它放行出去的是该租户**全部**可用凭据。
「只读」如果不包含「不能把口令带走」，就基本不剩什么意思了。

所以拒绝写在 handler 里（`exportInstances`），用的是守卫用的**同一个**谓词
`auth.Session.MayWrite` —— **一个定义、两处引用**，不是两个定义。

钉住它的不是「导出路由答 403」这种单点断言，而是两条**去问路由器**的测试：

| 测试 | 问的是什么 |
| --- | --- |
| `TestNoRouteHandsAProxyPasswordToAReadOnlySession` | 拿只读会话打**每一条已注册路由**，哨兵口令不得出现在任何响应体里。末尾有一条**对照**：管理员打导出路由**必须**拿到它 —— 否则上面那圈就是在断言一个本来就不存在的东西 |
| `TestAReadOnlySessionCanStillRead` | 反方向。除 `readsRefusedToAReadOnlySession` 里钉住的那条外，只读账号的每一次读都不得被拒；钉住的那条**必须**被拒且理由要对。钉子过期（路由没了）同样报红 |

**导出会进审计，口令不会。** 记的是 actor（会话的 user_id）、instance id 与数量；
`TestExportingProxiesIsAuditedWithoutTheCredential` 扫全部审计事件，出现哨兵即红。
审计追加在这条路由上是**致命的**（其余代理路由是吞掉的）：
配置变更丢了记录，不如让变更本身失败；而**没留痕的凭据导出不允许发生**。

OpenAPI 的 example 用的是 `USERNAME:PASSWORD@203.0.113.10`（RFC 5737 文档保留地址）。
`TestTheSpecShipsNoUsableCredential` 用正则扫整份文档里所有
`scheme://user:pass@`，口令部分不在占位符白名单里就红 —— 规范文档是这个仓库里
**最容易被复制到别处**的产物。

## 校验

用外部校验器，不用我们自己写的那个 —— 「测试比对的常量和被测的常量同源」
在这个仓库已经咬过一次。

```bash
VODOGE_OPENAPI_OUT=/tmp/openapi.json \
  go test -run TestWriteOpenAPIDocument ./cmd/gateway/
npx --yes @redocly/cli@2.47.0 lint /tmp/openapi.json
```

2026-08-24 实测：**0 error**，6 warning。
warning 全部来自 Redocly 的风格规则，不是规范违反，且都是有意为之：
`info` 没有 `license`（内部部署）；`/metrics` `/healthz` `POST /v1/auth/logout`
没有 4xx（它们确实没有）；`GET /v1/edge` 没有 2xx（它答的是 `101` 升级，
不是 JSON）。

## 加一条路由时要做什么

1. 照常在 `main.go` 或对应的 `*_routes.go` 里注册。
   **pattern 必须是字面量**（或 `packageRouteConstants` 里已登记的常量）——
   两个测试都靠静态读出它。
2. `go test ./cmd/gateway/` 会红，并告诉你漏了哪条。
3. 在 `openapi.go` 的 `apiOperations()` 里加一条。路径参数不用写，会自动带上。
4. 如果新路由不需要会话，`TestOpenAPISecurityMatchesTheRoutesThatAreActuallyOpen`
   也会红 —— 那是故意的：「这条可以不带凭据访问」必须有人**明确**决定一次。

## 与 edge-cloud 契约的关系

**两回事。** `packages/contract/` 描述的是网关与边缘设备之间的信封
（WebSocket 上行/下行，JSON Schema + 三侧生成代码）。
这份 OpenAPI 描述的是 HTTP 层：控制台和运营者调的那些路由。
`GET /v1/edge` 是两者的接缝 —— 它在这里只被记为「一个升级」，
信封形状仍然由契约定义。
