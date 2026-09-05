# 设备目录：受支持列表 + 能力矩阵

**状态**：设计已定，未开工。工作顺序在最后一节，**第 0 步不做完，第 3 步的开关不能开**。

---

## 一、它解决什么

今天一根模组插上来会发生什么：`edge-bin/src/main.rs` 的 `register_modem`
**只检查这个 IMEI 本轮被看见过**。没有查策略表，没有查任何列表，
`family` 直接写死 `None`。也就是说——**任何**能被枚举出来的 USB 模组，
只要探测流程没崩，都会被纳管。

而与此同时，代码里其实**有**一张硬件白名单
（`edge-core/src/strategies/modems.rs`，两条：`2c7c:0125` 与 `2c7c:0901`），
也**有**一张按运营商细分的能力矩阵
（`edge-core/capabilities/capability-matrix.toml`）。两张表都存在，
**但绑定这一步谁都不查**。

目标方向（用户原话）：

> 我们应该有个支持的设备列表　这个列表里支持的　我们才允许管理绑定　
> 绑定必须是手动的　自动发现　手动管理　也可以取消管理　我们要保证　
> 管理到的设备　必须是我们支持的　测试过的　（这些操作可以云端直接操作　
> 也可以边缘端操作上报云端　数据库里是唯一依据）

拆成四条不变量：

1. **自动发现，手动纳管** —— 发现是自动的，绑定必须有人点
2. **只有受支持的才能绑** —— 「支持」= 这个 build 驱动得了，且列表里启用
3. **只有测试过的才能绑** —— 「测试过」= 能力矩阵里有它这一对的规则
4. **数据库是唯一依据** —— 云端改和边缘端改都行，但落点是同一张表

---

## 二、七条已定的决定

| # | 决定 | 为什么 |
|---|---|---|
| 1 | `transport='serial'` **认它**，改两边契约 | 边缘端 `main.rs` 已经在写 `DiscoveryTransport::Serial.wire()`，而 `0050_modem_candidates.sql` 的 `CHECK` 只认 `qmi`/`at`。这是**已经在生产里对不上的契约**，不是新增能力。改契约比改行为安全 |
| 2 | 存量**追溯执行**，不合规的**自动解绑** | 「既往不咎」会留下一批永远解释不清的例外：它们不满足规则却在被管。用户选了追溯 |
| 3 | **放宽 `DeviceStatePayload.modems` 的 `minItems: 1`** | 一台边缘机可以合法地零模组（全拔了、全没绑）。现在它上报不了，等于逼它撒谎 |
| 4 | 支持列表**和**能力矩阵一起**收归 `admin.vodoge.com`**，租户只读 | 这是 SaaS。「支持哪些硬件」是跨租户事实，不该由任何单个租户写。租户能写就意味着 A 租户能让 B 租户的设备解绑 |
| 5 | **先做下层**，admin 站后做 | 下层（契约、目录表、边缘执行）不依赖 admin 站；admin 站依赖下层。反过来做会造出一个没人消费的写入端 |
| 6 | 绑定**两道闸都要**，但**先给 EC200U 补矩阵规则** | 见下 |
| 7 | 目录**读不到 → 维持现状 + 告警，绝不解绑** | 见下 |

### 关于第 6 条

我原本主张只用硬件白名单一道闸，理由是：「支持」（这个 build 驱动得了）
和「测试过」（这一对量过了）在代码里是**两根正交的轴**——
`strategies/modems.rs` 按 USB ID，`capability-matrix.toml` 按
「型号 × 运营商」。合并成一道会有一个难受的后果：

**电信那根 EC200U-CN 会被解绑。** 它在硬件白名单里（`2c7c:0901`），
但能力矩阵里**一条 EC200U 的规则都没有**——矩阵只写了
EC20 / EC25-CN / EG25-G。

用户选了两道都要，并把测量排在开关之前。

### 🔴 更正：上面那段的前提是错的

我说「矩阵里一条 EC200U 规则都没有」，查的是**仓库里那份**
`edge-core/capabilities/capability-matrix.toml`。**设备上跑的不是那一份。**

边缘库 `/var/lib/vodoge-edge/inbox.db` 的 `capability_matrix` 表里存着云端
2026-09-01 推下来的那一份（`version = 2026-09-01T03:32:24Z`），
而 `main.rs` 是**优先用存储里的**，只有取不到才回落到内置的。
它含 EC200U——所以面板给电信那根报的 `capability_origin` 才是 `rule`。

两份矩阵差得很远：

| | 内置（仓库） | 实际在跑（云端推送） |
|---|---|---|
| 规则数 | 12 | **4** |
| 覆盖型号 | EC20、EC25-CN、EG25-G | EC20、**EC200U-CN** |
| EC20 × CN-Unicom | 有 | **没有** |
| EC20 × Generic-International 的 `data` | supported | **缺，回落成 probe** |
| EC200U-CN × CN-Telecom | 没有 | **有**（`sms_mo`/`sms_mt` 都 supported） |

**所以真正会被两道闸挡住的不是电信那根，是另外两根。**
四根在跑的模组，对着实际在跑的矩阵过一遍：

| 模组 | family × carrier | 闸 1 硬件 | 闸 2 实测规则 |
|---|---|---|---|
| 香港 CSL `862547055142811` | EC20 × Generic-International | ✅ | ⚠️ `sms_mo` = **probe** |
| 移动 `867018069509705` | EC20 × CN-Mobile | ✅ | ✅ |
| 美国 310-240 `867018069514820` | EC20 × Generic-International | ✅ | ⚠️ `sms_mo` = **probe** |
| 电信 `868019060490134` | EC200U-CN × CN-Telecom | ✅ | ✅ |

`probe` 在 `0046` 的定义里「grants nothing」，边缘端拒绝它并说
「recorded as needing a probe, which is not a measurement」。
所以两根 Generic-International 的 EC20 会不会被解绑，
**完全取决于闸 2 的严格程度**——见下。

### 闸 2 的严格程度：这不是措辞问题，是两根模组的去留

两种写法，后果不同：

- **「至少有一项非 probe 的测量」** → 那两根过（`sms_mt` 是 supported），
  四根全留
- **「每一项都非 probe」** → 那两根**当场解绑**

我倾向第一种，理由是账本的粒度就是「一对多项」，
`0046` 明确允许部分测量诚实地记下来（「so a partial measurement can be
recorded honestly」）。要求满分等于把「诚实记录部分结果」这件事变成惩罚。

⚠️ 这一条**没定**，列在最后一节。

### 顺带查出来的：云端账本比内置矩阵更不完整

实际在跑的矩阵丢了 EC25-CN 和 EG25-G 的全部 8 条规则，也丢了
EC20 × CN-Unicom。这些型号现在机队里没有，所以今天不痛；
但哪天插上一根 EC25-CN，它会落到 fallback=probe，也就是「未测」，
两道闸之下就是**绑不了**。

这是「账本成为唯一真相」的一个真实代价：内置 TOML 里那些结论
**没有进过账本**，于是随着一次推送被覆盖掉了。
迁移的时候要决定这 9 条怎么办。

### 关于第 7 条

这条不是用户提的，是我定的，因为它是一个**已经付过学费**的教训：
`managed_imeis` 那次，一次短暂的存储读失败让整台设备被取消纳管。
追溯执行天生具备同样的形状——「读目录 → 发现不合规 → 解绑」——
只要「读目录」失败被当成「目录是空的」，**一次网络抖动就能解绑整个机队**。

所以：

```
目录读取失败  →  维持现状 + 大声告警  →  绝不解绑
目录读到了，且这一对确实不合规  →  才解绑
```

「读不到」和「读到了、是空的」必须是两个**不同的**状态，不能塌缩成一个。
这条要有测试，而且要**先看到它红**。

---

## 三、架构

### ⚠️ 先说清楚：这套机器大部分已经存在

写这份设计时我以为要从零造。**不是。** 已经在跑的是：

| 已有 | 在哪 | 现状 |
|---|---|---|
| `app.support_ledger` | `0046_support_ledger.sql` | **每租户一份，租户可写**。行式存储，一对一行，带 `tested_at` / `tested_by` / `note` 证据列 |
| `app.capability_matrix` | `0009_capability_matrix.sql` | **每租户一份**。推给设备的文档，由账本**派生** |
| 读写发布路由 | `apps/gateway/cmd/gateway/ledger_routes.go` | `GET /v1/support-ledger`、`PUT …/{family}/{carrier}`、`DELETE`、`POST …/publish`——**租户会话就能调** |
| 编辑界面 | `apps/console/app/support-ledger/page.tsx` | 租户可改 |
| 无会话发布路径 | `apps/gateway/cmd/publish-ledger` | 走同一批函数（`ledger.Document`、`matrix.Parse`、`matrix.CommandPayload`），保证摘要逐字节一致 |

`0046` 的文件头已经把铁律写下了：

> a pairing that is not a row here is not supported, and the edge refuses it
> by name rather than trying it and finding out.

**所以第 4 条决定的真实内容不是「建两张新表」，而是把这两张已有、有数据、
租户可写的表改成全局只读**，并把写入面从 console 搬到 admin。
这比从零造小得多，但它是一次**数据迁移**，不是一次建表。

**真正新增的只有 `[[device]]` 那张受支持硬件列表**——它今天在代码里
（`strategies/modems.rs` 的 `usb_identities`），数据库里没有对应物。

### 重新划分租户归属：这是迁移，不是建表

要回答的问题：**现有的各租户账本行怎么处置？**

它们是真实测量，带 `tested_by`，不能一删了之。但合并到全局会撞车——
两个租户对同一对 `(family, carrier)` 可能记了不同结论，
而全局表的主键只有 `(modem_family, carrier)`，没有租户维度来容纳分歧。

这一条**没定**，列在最后一节。它必须在写迁移之前定，
因为它决定了迁移是「挑一个赢家」还是「保留冲突待人工裁决」。

⚠️ `publish-ledger` 这条 CLI 路径在重新划分归属之后要跟着改：
它今天按租户发布，之后必须是 admin 的路径。它的存在理由
（「发布不该需要往 shell 里敲密码」）在 admin 站上依然成立，所以它**留着**。

---

分工是用户在三个选项里选的第 3 个：**代码定策略，数据库定启用哪些**。

### 代码里（不变）

策略 = 怎么驱动一类硬件：AT 还是 QMI、能力上限、首选承载。
每个策略声明它**能**驱动哪些 USB ID
（`edge-core/src/strategies/modems.rs`）。

代码是「能不能」的唯一依据。数据库不能凭空启用一个这个 build 里不存在的策略——
真启用了也只会在运行期炸。

### 数据库里（新，跨租户）

**在现有的能力矩阵文档里加一个 `[[device]]` 段**，而不是另起一份文件：

```toml
version = "2026-09-05"

# ── 新增：受支持设备列表 ──────────────────────────────
[[device]]
usb = "2c7c:0125"
strategy = "quectel-ec"         # 必须是这个 build 里真有的策略 id
enabled = true
note = "EC20 / EC25-CN / EG25-G，2026-08 台架验证"

[[device]]
usb = "2c7c:0901"
strategy = "quectel-ec200u"  
enabled = true
note = "EC200U-CN，仅 AT"

# ── 已有：能力矩阵规则 ────────────────────────────────
[fallback]
sms_mo = { kind = "probe" }
# …

[[rule]]
modem_family = "EC20"
carrier = "CN-Mobile"
sms_mo = { kind = "supported", bearer = "cellular" }
```

**为什么并进同一份文档，而不是两份：**

- 同一个人、同一次发布动作、同一套鉴权——分开只会造出两个可以互相不同步的版本号
- **复用现成的下发通道**：`update_capability_matrix` 命令已经带版本号和 sha256，
  边缘端**存之前先解析**（坏摘要不替换，见
  `edge-agent/tests/command.rs` 的 `update_capability_matrix_rejects_a_bad_digest_without_replacing`），
  重启从库恢复。这套机制已经被一次事故打磨过，不值得重造一遍
- 一个版本号就能回答「这台边缘机现在信的是哪一版」——两个版本号答不了

**风险（已核实，不是推测）**：加了 `[[device]]` 段之后，旧 build 解析新文档会怎样？
`edge-core/src/matrix.rs` 的 `MatrixDocument` **没有** `deny_unknown_fields`，
所以旧 build 会**静默地**只读到 `[[rule]]`，把整个 `[[device]]` 段丢掉——
也就是**没有第一道闸**，而且它不会报错。这不是理论问题，滚动升级期间必然出现。
对策：**文档里带 `min_agent_version`**，边缘端解析时比对，
低于要求就拒绝替换并告警，而不是用一半。

### 三个执行点

```
   admin.vodoge.com  ──写──▶  Postgres（全局目录表，跨租户）
                                    │
                          gateway ──┤ 唯一的 DB 写入方
                                    │
             ┌──────────────────────┴───────────────────┐
             ▼                                          ▼
      console（租户，只读）              edge-agent（既有的版本化 + sha256 下发）
                                                        │
                                                        ▼
                                              register_modem 的两道闸
```

**admin 站不直连 Postgres。** 走 gateway 的新 admin API。
理由：`deploy/compose.yaml` 的注释里写着「RLS 意味着连 gateway 都列不出
它服务的租户」——RLS 是这套系统的地基，而 admin 站恰恰是**必须凌驾于 RLS 之上**
的那个东西。让它直连数据库，等于在地基旁边挖第二个入口，
而且是一个绕过所有既有审计的入口。保持「gateway 是唯一 DB 写入方」这条不变量。

---

## 四、绑定的两道闸

`register_modem` 现在只检查 IMEI 本轮被看见过。改成：

```
闸 1  硬件：registry.drives(usb_id)  且  目录里 enabled = true
闸 2  测试：这一对 (family, carrier) 有真实测量结果
```

**闸 2 的机械装置已经在了**，只是绑定这条路没去调它：
`edge-core/src/strategy.rs` 的 `SupportLedger`，由
`SupportLedger::from_matrix` 从矩阵构建，`is_tested(family, carrier)`
就是这道闸的形状。`[fallback]` **不**参与构建——
「矩阵回答所有问题，账本只回答量过的」，这个区分正是我们要的。

### ⚠️ 闸 2 不能直接用 `is_tested()`

有个后门。`CapabilityMatrix::rules()` **不过滤** `probe`
（`edge-core/src/matrix.rs:59`——它把 `self.rules` 原样吐出来），
所以一条 `kind = "probe"` 的 `[[rule]]` 也会变成账本条目，
`is_tested()` 对它返回 **true**。而 `resolve()` 到了第 3 层又会拒绝它。

后果很具体：**给 EC200U 写四条 `probe` 规则，就能骗过闸 2**——
绑定放行，然后每一个操作都被拒。这恰好是「静默半可用」——
这套设计存在的目的就是防它。

所以闸 2 要问的是「有没有**非 probe** 的测量结果」，不是 `is_tested()`。
这条要有测试，且要**先看到它红**：一条 `probe` 规则必须挡住绑定。

两道都过才允许绑。任何一道不过，**发现照旧、上报照旧、面板照旧显示**，
只是**绑不了**，且面板要说清是哪一道没过、缺的是什么。

配套要改的：

- `edge-bin/src/main.rs` 的 `at_paths` 现在取
  `edge_modem::at_control_ports()` 的**未过滤全量**，要改成从已过滤的候选派生
- `family` 要真的写进 `registered_modems`，不能再是 `None`——
  否则闸 2 永远查不到规则
- 面板要有一个「为什么绑不了」的说明，而不是一个不响应的按钮

---

## 五、工作顺序

依赖是真的，顺序不能换。

### 第 0 步：补齐实测规则　【第 6 条的硬前置】

⚠️ **这一步的内容变了。** 原本写的是「测 EC200U」，
但实际在跑的矩阵里 EC200U-CN × CN-Telecom 的规则**已经有了**。
真正缺的是：

1. **EC20 × Generic-International 的 `sms_mo`** —— 现在是 `probe`，
   两根模组（香港 CSL、美国 310-240）挂在这一条上
2. **内置 TOML 里那 9 条没进账本的规则**（EC25-CN ×4、EG25-G ×4、
   EC20 × CN-Unicom）—— 决定是补进账本还是作废
3. **EC200U-CN 的 `sms_mo` 结论要复核** —— 账本记的是 `supported`，
   而我们手上有它发完短信挂死 AT 通道约 15 分钟的直接观测。
   两者不矛盾（能发出去 ≠ 没有副作用），但账本里应该有这条 `note`

`data` 和 `voice` 不用测，也测不出来——
`Ec200uStrategy::ceiling` 已经把这两项按**硬件**否掉了（EC200U 系列没有
`cdc-wdm`，这个 agent 的数据通路和语音通路都建立不起来），而
`StrategyRegistry::resolve` 的第 1 层就是 ceiling，注释写得很明白：

> A ceiling holds whether or not anybody has measured the pairing, and no
> amount of measuring will lift it.

ceiling 与运营商无关，所以这两项**不该出现在按运营商切分的矩阵里**——
往矩阵里给 EC200U 写 `data` 规则，写的是一个永远不会被读到的值。

**已有的真实数据**（都要写进去，包括否定的）：

- `sms_mo` × CN-Telecom：两次发送，两次挂死 AT 通道，约 15 分钟自愈。
  **但 2026-09-05 07:59 它没发短信也哑了一次**——所以还不能定性成
  「发短信导致」，得再测才能下结论
- `sms_mt`：没测过

**没量过的不许写。** 矩阵的价值全在「这里写的都是量出来的」，
往里填猜测等于把它降级成一份意见。

### 第 1 步：契约变更

- `transport` 允许 `'serial'`——两边 schema + 生成代码 + `0050` 的 `CHECK`
- 放宽 `DeviceStatePayload.modems` 的 `minItems: 1`

### 第 2 步：全局目录

两件不同性质的事，别混着做：

**(a) 重新划分归属**（迁移）：`support_ledger` 与 `capability_matrix`
去掉 `tenant_id`，RLS 从 `tenant_isolation` 改成「租户只读、admin 可写」，
现有各租户行按上面那个待定的规则合并。写入路由从租户面移到 `/v1/admin/*`，
console 的 `/support-ledger` 页降级为只读。

**(b) 受支持硬件列表**（新建）：`[[device]]` 段、`min_agent_version` 闸、
边缘端解析与校验、`drives()` 改成查目录。

### 第 3 步：两道闸 + 追溯 + 失败安全

**第 0 步没做完不能做这一步。** 开关先于规则 = 电信那根立刻掉。

### 第 4 步：云端止血（可随时插队）

`0050_modem_candidates.sql` 的触发器**零个 EXCEPTION 处理**。
一个迁移，不用编译，不依赖上面任何一步。

另外两处一并处理：`putMatrix` 缺校验（G6）、
`schedule/store.go` 少了 `AND managed`（G5）。

### 第 5 步：admin.vodoge.com

见下一节。

---

## 六、admin.vodoge.com

**新仓库**（用户指定）：`vodoge/vodoge-admin`。

### 为什么独立成仓，而不是 `apps/admin`

不只是偏好，有一条实打实的理由：**它是另一个信任域**。
console 是租户作用域的，admin 写的是跨租户配置。
分仓意味着 console 的一个漏洞**够不到** admin 的路由，
两边可以有不同的鉴权、不同的发布节奏、不同的暴露面。

**代价要认**：这是第三个仓，而跨仓契约同步在这个项目里
已经有过痛苦的机械装置（`scripts/sync-contract.sh`、
`scripts/check-token-parity.cjs`，以及 `docs/decisions.md`
2026-08-28 那条关于守卫该挂在哪的决定）。加一个仓 = 这套东西要覆盖三棵树。
这个代价是**已知并接受的**，不是被忽略的。

### 技术栈

跟 console 一致：**Next.js + Tailwind + shadcn/ui**，standalone 输出。
理由不是「统一」，是用户的既定约束：**布局、动画、UI 主题全用现成的，
不自己写**。console 那套已经按这条做过一轮
（`docs/frontend-rebuild/cloud-shadcn.md` 五个阶段全完成），
照搬能省掉重新论证一次主题映射。

### 部署

**照抄 console 已经走通的那条路**——这也正好满足
「不在云端构建，本地构建后上传产物」：

- 本地 `next build` → `admin-dist.tgz`
- `Dockerfile.admin.prebuilt`：只打包，不构建（连同 console 那条
  LGPL `@img` 的检查一起继承——同一个 `next build` 会拖进同一个负载）
- compose 加一个 `admin` 服务，加入 `ingress`（`trek_default`）网络，
  Caddy 按 hostname 路由到容器名
- 端口只发布到 `127.0.0.1`，跟 console 一样

云主机 2 vCPU / 543 MB 可用内存，`next build` 在上面跑不起来——
这不是保守估计，是 `deploy/Dockerfile.console` 里已经写下的拒绝理由。

### 鉴权：mTLS 客户端证书

跨租户写权限必须比租户登录更强。**已定：用 mTLS 客户端证书。**

理由是这个项目**已经有一套 PKI**——`deploy/scripts/gen-pki.sh` 和
`device-ca` 现在就在给边缘机签证书，gateway 的 `VODOGE_GATEWAY_CLIENT_CA`
已经在做客户端证书校验。admin 站复用同一条签发链，Caddy 做校验，
**不需要新建任何身份系统，也没有密码可以被钓**。

代价要认：

- 浏览器装客户端证书麻烦。运维人数少的时候这个代价很小
- **吊销是弱点**。证书一旦签出去，作废要靠重签 CA 或维护 CRL/OCSP。
  签发时**必须**带短有效期，而不是签一张十年的
- admin 的证书要用**和设备不同的 CA**，否则一台边缘机的私钥泄漏
  就等价于拿到了跨租户写权限

---

## 七、未决

1. **闸 2 要「至少一项非 probe」还是「每项都非 probe」**——
   这不是措辞问题：后者会当场解绑香港 CSL 和美国 310-240 两根
   （它们的 `sms_mo` 是 `probe`）。我倾向前者，理由见上文
2. **内置 TOML 里那 9 条没进账本的规则怎么办**（EC25-CN ×4、
   EG25-G ×4、EC20 × CN-Unicom）——补进账本，还是承认它们从未被测过而作废
3. **现有各租户账本行怎么合并成一份全局账本**——它们是带 `tested_by`
   的真实测量，不能删；但两个租户对同一对可能记了不同结论，
   而全局主键 `(modem_family, carrier)` 容不下分歧。
   是挑一个赢家（按什么？时间？租户？）还是保留冲突待人工裁决？
   **写迁移之前必须定**
   —— **已定：生产上只有一个租户，直接搬。**
   ⚠️ 这一条是口头确认的，**写迁移之前必须连库核实**：
   如果实际不止一个租户，迁移会静默丢掉别人的测量
4. **`min_agent_version` 的具体闸法**——拒绝替换之后，边缘机停在旧目录上，
   这个状态要怎么在云端看见
5. **EC200U 的 AT 挂死**到底是不是发短信引起的——2026-09-05 07:59
   那次零发送的挂死推翻了原本的解释，第 0 步要重新测
