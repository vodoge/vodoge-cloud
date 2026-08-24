# 网关 HTTP API

机器可读的描述是 **OpenAPI 3.1**，由网关自己供出：

```
GET https://<tenant>.vodoge.com/v1/openapi.json
Authorization: Bearer <会话令牌>
```

这份文档覆盖网关注册的**全部**路由（当前 65 条模式 / 67 处注册）。
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
