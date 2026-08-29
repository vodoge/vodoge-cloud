# 执行计划（交接文档）

**这份文档是写给接手的 AI 的。** 目标是让一个没有任何上下文的 agent
能独立开工，而不需要先问一轮问题。

配套阅读：

- [feature-matrix.md](feature-matrix.md) —— 三方功能对齐，说明"还差什么"
- [roadmap.md](roadmap.md) —— 目标与阶段划分，说明"为什么是这个顺序"
- [decisions.md](decisions.md) —— 三项能力的定案依据
- [protocol-reliability.md](protocol-reliability.md) —— 上行协议的语义，改上行前必读

---

## 0. 先读这一节

### 北极星

**让一张美国 eSIM 在我们的硬件上完成一次 VoWiFi 语音通话，全程从云端控制台操作。**

完成判据不是"代码写完"，而是这一串在**真机上依次为真**：

1. 控制台里输入一个 Saily 激活码，profile 下载到台上的 eUICC
2. 切换到该 profile，卡注册上美国运营商，控制台显示 MCC 310/311
3. 在控制台登记 E911 地址，运营商侧确认
4. VoWiFi 隧道建立，IMS 注册成功
5. 从控制台发起一次通话并接通

### 唯一的关键路径

**阶段 3（SM-DP+ 下载）不完成，阶段 4 连测试用的卡都没有。**
台上三根棒子没有任何一张美国卡，Saily 的美国 profile 必须先下载才存在。

如果只能推进一件事，推进阶段 3。

### 这套系统的规模

**一个边缘部署，一个云主机。** 没有 fleet，没有 staging，没有第二个 region。
`region` 是设备证书和 `tenants` 表里的一个字段，不是第二个站点。
任何说"区域数据面"的文档描述的是可能的将来，不是现在的基础设施。

**推论：不要为了想象中的规模做设计。** 见 roadmap 的取舍。

---

## 1. 环境

> ⚠️ **每条命令都要写清楚在哪台机器上跑。** 这个环境有十来台机器，
> 不写清楚接手的人得回头翻。

| 角色 | 地址 | 说明 |
| --- | --- | --- |
| **工作站** | 本机 macOS | 写代码、交叉编译、跑测试。**不要在这里跑 dev server** |
| **云主机** | `root@43.108.53.126` | 网关 + 控制台 + PostgreSQL + Redis，Docker Compose |
| **边缘机** | `root@192.168.6.83 -p 2222` | Ubuntu，VMware 虚机，三根 EC20 模组经 usbip 挂进来 |
| 基础域名 | `vodoge.com` | 公开控制台 |
| 首个租户 | `a.vodoge.com` | 这个租户就是我们自己 |
| 设备上行 | `wss://43.108.53.126:444/v1/edge` | mTLS，TLS 1.3 only |

### 三个仓库

| 仓库 | 路径 | 内容 |
| --- | --- | --- |
| `vodoge-cloud` | `~/Documents/local/vodoge-cloud` | Go 网关 + Next.js 控制台 + 迁移 |
| `vodoge-edge` | `~/Documents/local/vodoge-edge` | Rust 边缘代理 |
| `vodoge` | `~/Documents/local/vodoge` | **旧版单机 Go 产品，只读参考** |

旧版是查"以前怎么做的"的地方，尤其是 `vowifihost`（1904 行 Go，阶段 4 要重写它）。

### 云主机的硬性约束

**云主机是 2 vCPU / 1.6 GB 内存，它编译不动这套软件。**
在那上面跑 `go build` 会把 sshd 饿死，机器好几分钟不接受连接；`next build` 更重。

**所有编译在工作站或边缘机上做，云主机只接收二进制。**

---

## 2. 怎么改、怎么发、怎么验

### 2.1 网关（Go）

```bash
cd ~/Documents/local/vodoge-cloud/apps/gateway && go test ./... && go vet ./...
```

交叉编译并上传（**工作站**）：

```bash
cd ~/Documents/local/vodoge-cloud/apps/gateway && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /tmp/vodoge-gateway ./cmd/gateway && scp /tmp/vodoge-gateway root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

在**云主机**上重建并重启：

```bash
ssh root@43.108.53.126 'cd /opt/vodoge-cloud/deploy && docker build -q -t vodoge-cloud-gateway -f Dockerfile.gateway.prebuilt . && cd /opt/vodoge-cloud && docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --no-build --force-recreate gateway'
```

`--no-build` **不能省**：省了 Compose 会去用 `Dockerfile.gateway`
从源码构建，云主机会 OOM。

### 2.2 控制台（Next.js）

在**工作站**上构建、打包、上传：

```bash
cd ~/Documents/local/vodoge-cloud/apps/console && NEXT_TELEMETRY_DISABLED=1 VODOGE_GATEWAY_URL=http://gateway:8080 npm run build && rm -rf .next/standalone/node_modules/@img && rm -rf dist && mkdir -p dist/public && cp -r .next/standalone/. dist/ && rm -rf dist/.next/static && mkdir -p dist/.next/static && cp -r .next/static/. dist/.next/static/ && cp -r public/. dist/public/ && tar -czf console-dist.tgz -C dist . && scp console-dist.tgz root@43.108.53.126:/opt/vodoge-cloud/deploy/
```

> **`.next/static` 每次都要拷进一个全新目录。** `cp -r a b` 在 `b` 已存在时
> 会创建 `b/a`，于是悄悄生成 `.next/static/static`，控制台不报错但不上 CSS。

然后在**云主机**上用 `Dockerfile.console.prebuilt` 和 service `console`
走同一对 `docker build` / `up -d --no-build`。

### 2.3 边缘（Rust）

**边缘代码有一大块在 `#[cfg(target_os = "linux")]` 里**（`edge-bin/src/main.rs`
的 `mod linux`），macOS 上根本不编译。**在工作站上 `cargo build` 通过，
不代表边缘代码通过。** 四个真实的解码 bug 就是这么活下来的。

所以：工作站上跑单测（`cargo test`），**类型检查和发布构建都在边缘机上做**。

同步源码到**边缘机**：

```bash
cd ~/Documents/local/vodoge-edge && rsync -a --delete -e "ssh -p 2222" --exclude target --exclude .git ./ root@192.168.6.83:/root/vodoge-edge-build/
```

在**边缘机**上检查、测试、构建、部署：

```bash
ssh -p 2222 root@192.168.6.83 'set -e; cd /root/vodoge-edge-build; export PATH=$PATH:/root/.cargo/bin; cargo check -p edge-bin; cargo test; cargo build --release -p edge-bin; cp -a /usr/local/bin/vodoge-edge /root/vodoge-edge-binary-before-$(date -u +%Y%m%dT%H%M%SZ); install -m 0755 target/release/vodoge-edge /usr/local/bin/vodoge-edge; systemctl restart vodoge-edge'
```

看日志（**边缘机**）：

```bash
ssh -p 2222 root@192.168.6.83 'journalctl -u vodoge-edge -n 40 --no-pager | grep -v "poll /dev"'
```

`grep -v "poll /dev"` 很有用 —— 三根棒子每 8 秒各刷一行，不滤掉看不见别的。

> 🔴 **传完二进制必须比 sha256，不能只看 scp 的退出码和文件大小。**
> 2026-08-29 网关部署时 scp 报成功、云端文件**大小与本机完全一致**
> （13721762 字节），内容却不同 —— 静默损坏。症状极具误导性：进程能 exec、
> `docker top` 看得到、状态 running，但**零日志、不绑端口、连 SIGQUIT 都不吐
> 协程栈**（Go 运行时根本没起来），健康检查连续失败 88 次，边缘上行断了约 20 分钟。
> 排查时先怀疑了数据库锁（会话表是空的）、容器网络（DNS 正常）、架构不匹配
> （全是 x86_64），最后是**本机重建后比 sha256** 一比就露馅。
> 那段时间 SSH 到两台机器都在间歇性断开，传输在这种链路上会坏而 scp 不报错。

### 2.4 数据库迁移

**当前 schema 版本：47**。迁移文件在 `packages/db/migrations/`，
命名 `NNNN_name.sql`，四位数字连号。

应用一条新迁移（从**工作站**发起）：

```bash
cd ~/Documents/local/vodoge-cloud && scp packages/db/migrations/0034_your_change.sql root@43.108.53.126:/tmp/m.sql && ssh root@43.108.53.126 'docker cp /tmp/m.sql vodoge-cloud-postgres-1:/tmp/m.sql && docker exec vodoge-cloud-postgres-1 psql -U vodoge -d vodoge -v ON_ERROR_STOP=1 -f /tmp/m.sql'
```

**应用成功后必须登记版本号**，否则追踪表会和现实脱节：

```bash
ssh root@43.108.53.126 "docker exec vodoge-cloud-postgres-1 psql -U vodoge -d vodoge -c \"INSERT INTO app.schema_migrations (version, name) VALUES (34, '0034_your_change') ON CONFLICT (version) DO NOTHING\""
```

开一个交互 psql（**云主机**）：

```bash
ssh root@43.108.53.126 'docker exec -it vodoge-cloud-postgres-1 psql -U vodoge -d vodoge'
```

---

## 3. 这套代码里会咬人的地方

以下每一条都是**已经踩过**的，不是理论风险。改到相关区域前先读。

### 3.1 PostgreSQL

**行级安全是 FORCE 的，表属主也不豁免。** 策略普遍是
`tenant_id = app.current_tenant_id()`。这意味着：

- 读写业务表**必须**先设好租户上下文，Go 侧走 `tenant.Transact`
- **没有任何东西能枚举租户**。`app.tenants` 自己也按 `id = current_tenant_id()`
  隔离，连 SECURITY DEFINER 函数也看不到全部租户。
  所以**做不了全局清扫任务** —— 任何"定期扫全库"的设计在这里行不通，
  只能挂在某个已经带着租户上下文运行的路径上（例如设备 resume）。

**部分唯一索引要求 `ON CONFLICT` 重复它的谓词。**
`messages_device_seq_key` 是 `WHERE direction = 'inbound'` 的部分索引，
所以必须写 `ON CONFLICT (device_id, seq) WHERE direction = 'inbound'`。
少写谓词就是 `42P10`，而 `42P10` 会**杀掉设备会话**，表现为设备反复掉线。

**改了投影逻辑要确认只有一个写入者。** 曾经 `app.ingress` 上的触发器
和 `accept_ingress` 里的内联代码同时投影 `app.messages`，两份并行跑了很久，
因为结果一致所以完全看不出来 —— 直到两份不一致，才以最难查的形式爆出来。
触发器已在 0029 退役，`accept_ingress` 是唯一写入者，**别再加第二个**。

**新增列如果 NOT NULL 且无默认值，要检查所有 INSERT。**
`messages.status` 就是这么漏的：内联投影从没真正执行过（总是撞 ON CONFLICT），
所以漏了这一列几个月都没人知道。

### 3.2 上行协议

**改之前读 [protocol-reliability.md](protocol-reliability.md)。** 关键不变量：

**丢弃一条记录不会消费它的序号。** 上行是连续日志，累积游标跨不过一个
从没写过的序号。所以一条"存不下"的记录会被设备**永远重放**，它后面的
所有东西都堵在后面。永久存不下的记录必须写**墓碑**
（`app.record_unstorable_ingress`）把序号填掉。

两种错误的做法都试过，都更糟：

- **假装 ack 但不写** → 设备删掉它唯一的副本，留下两边都填不上的洞
- **永不 ack** → 记录保住了，但设备停在那儿

**回退重发游标要按"缺口头"去重。** 对端每收一条就 ack 一条，
而补缺口的记录还在飞的时候，**每一个 ack 都会报同一个缺口**。
如果每个 ack 都回退，就会不断重填重发预算、反复发同一批 —— 链路全速运行、
零进展。`gap_resent_from` 就是干这个的，别把它优化掉。

**重放窗口必须小到一整窗能塞进 socket 发送缓冲区。**
`REPLAY_WINDOW = 32`。曾经是 256，一整窗约 150 KB，于是这一侧在读到任何 ack
之前就先在写上阻塞了 —— 正是这个上限本该防止的死锁。

### 3.3 网络与部署

**云主机的设备端口经 `docker-proxy` 发布。** 换网关容器后，docker-proxy
会攥着外部连接不放、停止读取、通告零窗口，socket 进 TCP persist 无限探测。
边缘侧靠 `TCP_USER_TIMEOUT`（120 秒）了结它。

`SO_SNDTIMEO` 在这里**没有用**：它确实到期，但报的是 `WouldBlock`，
rustls / tungstenite / 我们自己都正确地把它当成"还没好"然后重试，
用户态永远得不出"对端没了"的结论。只有内核层的 `TCP_USER_TIMEOUT` 能判死。

**发布到 `127.0.0.1` 的端口，从网桥地址访问不到。** 这个错误犯过两次
（Caddy 反代、以及测试用的 webhook 接收端）。容器之间用**容器名**互访，
需要跨 compose 的用外部网络 `ingress`（即 `trek_default`）。

**包装 `http.ResponseWriter` 必须转发 `Hijacker` 和 `Flusher`。**
指标中间件曾经用一个只实现 `ResponseWriter` 的 `statusRecorder` 包了一层，
于是每一次 WebSocket 升级都 500 —— 全部设备同时掉线。

### 3.4 Go / Rust

**`type Command json.RawMessage` 是定义类型，不继承 `MarshalJSON`。**
必须写成类型别名 `type Command = json.RawMessage`，否则命令会被编码成
base64 字符串，每台设备都拒收。

**边缘 `mod linux` 在 macOS 上不编译。** 见 2.3。新写的解码/协议逻辑
**放进 `edge-core`**（纯逻辑，无 I/O），这样任何机器上都能测。
`scripts/check-core-deps.sh` 会守住 `edge-core` 不引入 I/O 运行时。

### 3.5 国内网络

配任何下载类命令之前先想镜像：crates.io、Go module、npm、Docker Hub
在国内都可能极慢或超时。边缘机和云主机的换源情况可能不同，先确认再动。

---

## 3.6 能力裁决:没测过就是不支持

**2026-08-29 加的,是一次行为改变,不只是新功能。** 边缘现在拒绝执行
"没有实测记录"的组合,而不是像以前那样先试试看。改之前默认是 `probe`(现探),
那正是一根棒子半死不活、没人能复现的来源。

裁决分四层,依次收窄,每层只能做减法:

| 层 | 键 | 住在哪 |
| --- | --- | --- |
| 硬件天花板 | `ModemFamily` | `edge-core/src/strategies/modems.rs` |
| 支持台账 | (型号, 运营商) | 云端 `app.support_ledger`,发布后推给边缘 |
| 运营商 | `CarrierProfile` | `edge-core/src/strategies/carriers.rs` |
| 套餐声明 | ICCID | `app.card_policies` 的四个能力列 |

**天花板排在台账之前**,这个顺序是跑出来的:EC200U 没有 QMI 时,先问台账会答
"没测过,去测",而那个测量根本做不到。天花板无论测不测都成立,所以先问它。

拒绝时会指名是哪一层(`untested` / `modem` / `carrier` / `subscription`),
因为这四种情况要找的人完全不同。

### ⚠️ 四列里只有一列真的在管事

台账和控制台都显示 `sms_mo` / `sms_mt` / `data` / `voice` 四列,但**只有
`sms_mo` 接进了实际裁决**(`CommandExecutor::refuse_unsupported` 和
edge-bin 的 `RadioPort::refuse_unsupported`)。另外三个 `Operation` 变体定义了
但没有调用点。

所以现在去测 `data` 只会得到一行没人读的记录。要让它有意义,得先把
`set_data_network` 接进裁决 —— 但**顺序必须是先测再接**:反过来会立刻把现在
能用的数据开关拒掉,正是"发布打掉能用的东西"那个陷阱。

`voice` 没有可测的东西,这个 agent 根本没有语音通路,那属于阶段 4。

### 台账怎么发布

记录和发布是**分开的**:保存一行不改变任何设备的行为,发布才会。
控制台 `/support-ledger` 有按钮(带确认对话框,文案直说后果)。

发布会把台账渲染成能力矩阵文档、存进 `app.capability_matrix`、
再作为 `update_capability_matrix` 命令推给每台设备。摘要必须经
`matrix.Parse` 算 —— 它是唯一把 Go 的 map 键序重编成 serde BTreeMap 序的地方,
自己再算一遍会一直对,直到两边分叉那天,然后设备以摘要不匹配拒收而错误指向不了任何地方。

> 控制台那个按钮要会话令牌,而令牌来自密码。需要从命令行发布时用
> `apps/gateway/cmd/publish-ledger`(要传租户 ID —— `app.tenants` 是 FORCE RLS,
> 网关那个身份枚举不了租户)。它调用的是同三个真实函数,不是第二份实现。

## 3.7 没有 QMI 的模组走 AT

**EC200U 系列的 USB 组合 `2c7c:0901` 不暴露任何 `cdc-wdm`**,这是系列特性不是配置。
台面上 `2-4.2` 是它,其余四个 `pid=0125` 各对应一个 `cdc-wdm`。

所以有两条 AT 通路(`edge-modem/src/at_sms.rs`、`at_inbox.rs`),都用 PDU 模式,
复用与 QMI 完全相同的编解码器。**发送只在 QMI 找不到模组时才回退**:
QMI 找到了却拒绝,那是要如实上报的拒绝,不是换条路再试的理由 —— 自动回退会把
Club 卡那种套餐限制悄悄掩盖掉。

两个坑:

- **`AT+CMGS` 用提示符 `>` 回应,而 `terminal_code` 有意把 `>` 算终止码。**
  检查提示符必须排在问终止码**之前**,否则模组的邀请会被读成拒绝。更糟的是
  早返回还不发 ESC,模组会停在提示符上把后续每条指令当消息正文吃掉,整根变
  Offline。抢救办法:直接往它的 tty 写一个 ESC(ESC 丢弃,Ctrl-Z 才是发送)。
- **PDU 模式下 `+CMGL` 的状态是数字不是 `"REC UNREAD"`。** 照文本模式写解析会
  把每条消息都当成"非接收"过滤掉 —— **静默地一条都收不到**。

两条传输共用 `edge_core::settle_inbound` 做裁决,那里有 7 条测试锁着两条会丢消息
的规则:缺兄弟片段的不能删,已入库的照样要删模组副本。

## 3.8 AT 危险指令分级

`edge-core/src/at_policy.rs` 把改动射频/通话/短信/卡/持久配置的指令归类拦下,
云端和面板**两个入口都设防**(面板在边缘机局域网上,不是更可信的那个)。
读操作(`?` 和 `=?`)一律放行,链式指令逐段判定 —— `AT+CSQ;+CFUN=0` 是一条字符串。

不显眼但重要的几条:`CNMI` 写(把新消息路由到终端而不是存储 = **静默丢消息**)、
`EGMR`(改 IMEI,不可恢复且不该由我们改)、`QLINUXCMD`(模组上的 shell)。

专用命令(`select_operator` 这类)带 `force` 绕过 —— 守卫是为了拦住打错的指令,
不是为了停掉那个按钮本身。

## 4. 任务清单

每一项给出：**做什么 / 动哪里 / 完成判据**。
判据一律是"真机上可观察"，不是"代码写完"。

阶段之间只有阶段 4 依赖阶段 3，其余可并行。

---

### 阶段 1 —— 把已有的东西接通（约 1 周）

都是"半条链路已经在了"的项目，投入产出比最高。

#### 1.1 通知补齐剩下的事件

- **做什么**：`notify.KindDeviceOffline` 和 `notify.KindContractViolation`
  两个事件类型已定义但**无人触发**；备份失败连事件类型都没有。
- **动哪里**：`apps/gateway/internal/notify/notify.go` 加 `KindBackupFailed`；
  触发点：设备掉线在 `session.Hub` 的回收路径（`cmd/gateway/main.go` 里
  已有 `SweepIdle` 的 ticker，那里就能发），契约违规在契约校验处，
  备份失败在 `deploy/bin/backup.sh` 的调用方。
- **判据**：拔掉边缘机网线，90 秒内 webhook 收到一条设备掉线通知。
- **注意**：`Notify()` 是非阻塞的，队列满就丢 —— **这是故意的**，
  反压会让一个慢的 webhook 接收端拖垮喂它的 ingest 路径。不要改成阻塞。

#### 1.2 通知投递重试

- **做什么**：现在投递失败就没了。要有重试，且重试不能变成反压。
- **动哪里**：`apps/gateway/internal/notify/dispatch.go`
- **判据**：接收端先返回 500 再恢复，通知最终送达；接收端一直 500，
  ingest 吞吐不受影响。

#### 1.3 发送限额真正生效

- 🔴 **这一节的事实前提已经过期，但它当初写下的那个意图恰恰指着今天真正的缺口，所以整段留着而不是删掉。**
- **原文写的是**：`hourly_limit` 只在设置里校验和存储，发送路径上没有任何地方读它；
  读取在 `apps/gateway/internal/settings/settings.go:139`，
  而**执行点「要加在发短信的命令入队处」**。
- **现状**（2026-08-27 复核）：**读它的地方已经有了。**
  `apps/gateway/cmd/gateway/main.go` 的 `enqueueCommand` handler 里那段
  `if spec.Kind == "send_sms"` 会调 `sendAllowed`，超限回 429 并带上「几条/上限几条」。
- 🔴 **但计划说的是「入队处」，实现落在了 handler —— T018 的绕过缺口就是这个差别本身。**
  `POST /v1/commands` 被挡住了；调度器走 `internal/schedule/store.go` 的 `SQL.Fire`，
  它在事务里发自己的一份 `app.enqueue_command`，从不经过 handler。
  **T018 实测：限额设为 2，实际发出 60 条。**
- ⚠️ **不要照字面「把限流下沉到入队函数」** —— Go 侧不存在这样一个函数。
  到 `app.enqueue_command` 有两条互不相交的路径（`commands.EnqueueTx` 与 `schedule.SQL.Fire`），
  只改前者，调度器一条都拦不到。取舍写在板子的 note `T018-ratelimit-bypass.md` 里
  （在**仓库之外**的 `docs/goals/vodoge-shape-nav/notes/`，不是本仓的 `docs/`）。
- **判据**：限额设为 2，第三条发送被拒并给出明确原因 —— 🔴 **两条路径都要验，只验 handler 会假绿。**

#### 1.4 短信补齐

- **做什么**：联系人列表、未读状态、`+CDS` 网络送达回执。
- **动哪里**：联系人和未读是云端（新表 + `messaging` 包 + 控制台）；
  `+CDS` 要边缘上报 —— 模组的送达报告是独立的 PDU 类型，
  解码要加在 `edge-core/src/pdu.rs`（那里已有 `decode_deliver`，
  加一个 `decode_status_report`）。
- **判据**：给自己发一条短信，控制台上该条从"已发送"变为"已送达"。

#### 1.5 设备操作补齐

- **做什么**：重扫描、刷新缓存、数据网络启停、USBNET 模式。
- **动哪里**：云端命令目录 `apps/gateway/internal/commands/catalogue.go`
  （现有 13 个 kind），边缘执行器 `edge-agent/src/lib.rs`，
  控制台按钮。边缘侧 QMI/AT 能力都已具备。
- **判据**：四个按钮在真机上各生效一次，控制台看到回执。

#### 1.6 发现未纳管硬件

- **做什么**：边缘知道插了几根棒子，云端只看得到已注册的。
- **动哪里**：边缘 `DeviceState` 上报全部模组（含未注册的），
  云端显示"待纳管"。注意契约变更要同步
  `packages/contract/schema/edge-cloud.v1.schema.json` 和 Go/TS 两侧。
- **判据**：插一根没注册过的棒子，控制台上出现"待纳管"条目。

#### 1.7 公网 IP 与主机状态

- **做什么**：出口公网 IP（代理场景最常问的数），顺带边缘主机 CPU / 内存。
- **动哪里**：边缘新增上报，云端投影 + 控制台展示。
  旧版和 VoCat 都有，可参考 `vodoge/` 与 scratchpad 里的 `vc_host_stats*.go`。
- **判据**：控制台显示的公网 IP 与在边缘机上 `curl ifconfig.me` 一致。

#### 1.8 日志保留

- **做什么**：`app.ingress` 稳态约 2 万行/天 ≈ 11 MB/天。
- **不急**：库现在 32 MB，可用 24 G，按此速率约够六年。
  但无界增长会拖慢查询和备份。
- **动哪里**：归档 + 清理迁移。**注意 3.1 的约束** ——
  没法做全局定时清扫，得挂在带租户上下文的路径上，
  或者接受"按租户手动/按设备触发"的形态。
- **判据**：保留窗口外的行被清理，`app.ingress` 行数稳定在窗口内。

---

### 阶段 2 —— 自动化与远程控制（约 1.5 周）

依赖 1.1 / 1.2 的通知投递。

#### 2.1 定时任务

- **做什么**：定时发短信 / 拨号 / 查公网 IP，按设备或按卡编排。保号场景的核心。
- **重试语义（照抄 VoCat 的教训）**：**一旦进入模组或 IMS 事务就不能重试**，
  重试整条会造成重复投递。只有准备阶段的失败可以安全重试。
- **判据**：配一个"每小时给指定号码发一条"的任务，连续跑三小时无重复无遗漏。

#### 2.2 通知渠道补齐

- **做什么**：Telegram、飞书、企业微信、Pushplus。
- **注意**：`settings.go` 里**已经有** `telegram.bot_token`、`pushplus.token`
  的配置槽位，但 `channels.go` 里只有 webhook/bark/email 三个实现 ——
  **现在配了也不会发**，这是个会误导人的半成品，优先补上或者暂时移除槽位。
- **动哪里**：`apps/gateway/internal/notify/channels.go`，照现有三个的形状加。
- **判据**：每个新渠道的"测试"按钮都能真收到消息。

#### 2.3 Telegram 机器人

- **做什么**：查状态、切 Profile、发短信，敏感操作二次确认。
- **比 VoCat 复杂的地方**：多租户下要按租户绑定 chat。
  VoCat 是单机单用户，直接照搬会串租户。
- **判据**：从 Telegram 切一次 profile 并收到确认；另一个租户的 chat 看不到这台设备。

#### 2.4 只读账号

- **做什么**：现在只有单一操作员角色。给一个能看不能动的角色。
- **判据**：只读账号登录后，所有写操作的 API 返回 403，控制台不显示危险按钮。

---

### 阶段 3 —— eSIM 完整能力（约 3 周 · **关键路径**）

分两步，第一步就能解开现在的死结：每张卡只有一个 Profile，
禁用即掉网且无法回滚，所以切换演练一直不敢做。

#### 3.1 ES10b：EID、芯片信息、通知列表与重试

- **做什么**：边缘**已经能读 EID**（`edge-modem/src/session.rs:217`，
  ISD-R + GET DATA tag `5A`），云端没接。还缺芯片信息、通知列表与重试。
- **为什么是前置**：**下载流程依赖通知处理**，它不是可选装饰。
  有了通知列表才能安全地下载第二个 Profile 再切换。
- **动哪里**：APDU 与逻辑通道基础设施已有（`edge-modem/src/uim.rs`、
  `es10c.rs`、`session.rs`），是增量工作。
- **判据**：控制台显示台上两个 eUICC 的 EID 与芯片信息，通知列表可读可重试。

#### 3.2 禁用 / 重命名 / 删除 Profile

- **做什么**：边缘 `es10c.rs` 有 `enable_profile_apdu` / `disable_profile_apdu`，
  云端只接了 `list_esim_profiles` 和 `switch_esim_profile`。
- **动哪里**：云端加命令类型；重命名边缘也还没有，要新写 APDU。
- **判据**：在有两个 profile 的卡上禁用非当前 profile 并恢复，卡不掉网。

#### 3.3 SM-DP+ 下载 ← **最大的单项，建议独立立项**

- **做什么**：从激活码拉取新 Profile。需要 **ES9+ 的 HTTPS 栈**、
  **与 eUICC 的双向认证**、**通知回执**。
- **为什么最重要**：台上没有任何美国卡，**这是阶段 4 能被验证的前置条件**。
- **判据**：控制台输入一个 Saily 激活码，profile 下载到台上 eUICC 并可切换，
  切换后注册上美国运营商，控制台显示 **MCC 310/311**。

---

### 阶段 4 —— VoWiFi 与语音（约 4 周 · **依赖阶段 3**）

最大的一块。旧版 `vowifihost` 是 1904 行 Go；**Rust 边缘目前零 IMS 支持**。

范围**限定美国卡**：E911 是美国的法定要求，为没有对应义务的市场实现一套
用不上的地址登记只会增加攻击面。

#### 4.1 实时媒体通道

- **先做这个，不是最后做。** 命令中继那套"下发—执行—回执"的**异步模型
  承载不了通话**。这是阶段 4 的第一个技术问题，会反过来约束整体架构。

#### 4.2 IMS 栈

- IKEv2 / ePDG 隧道、EAP-AKA 认证、IMS 注册。后面所有 VoWiFi 功能的地基。
- 参考旧版 `vodoge/` 里的 `vowifihost`。

#### 4.3 VoWiFi 启停与重连

- 地基之上的控制面，工作量不大。

#### 4.4 IMS 短信

- 走 IMS 而非蜂窝发短信，漫游场景下更便宜也更可靠。

#### 4.5 语音通话

- 拨号、接听、挂断、媒体流。**已定为要大力发展的能力**，
  因此它是架构约束而不只是一个功能。

#### 4.6 E911 地址登记

- 代理运营商的网页表单（websheet）。
- **单租户机器上做和多租户云上做，SSRF 的爆炸半径完全不同，
  需要真正的沙箱化。** 不要直接照搬旧版。

---

### 阶段 5 —— 收尾（约 1 周）

- **Profile ↔ 代理绑定** —— 现在只能按国家绑上游，按 Profile 绑定更细
- **UDP Associate 探测** —— VoWiFi 数据面依赖 UDP，现在的探测只到 TCP 与握手
- **PC/SC 读卡器** —— 外接读卡器写卡，两边都有我们没有
- **OpenAPI 文档** —— 边缘契约有 JSON Schema，但 HTTP 路由没有机器可读描述
- **发布制品与更新检查** —— `self_update` 命令已就绪，但没有任何地方发布二进制，
  所以控制台没有按钮 —— **一个只能失败的按钮不如没有**

---

## 5. 遗留的小账

不属于任何阶段，但知道比不知道好。

1. **新短信还没走完端到端。** 解码器有完整单测（含 3GPP 参考向量、
   两种地址形式、每种字符集、header septet 对齐、已知好 PDU 的每个截断位置），
   但库里现存的短信全是旧二进制入队的存量，`encoding` 标签不可信。
   **真实新短信到达后要核对一次。**

2. **一条 `accepted` 命令的 outbox 记录始终未 resolve。**
   `apply_command_receipt` 的账目遗留。不会导致重发
   （`PendingForDevice` 不选 `accepted`），只是脏数据。

3. **过期命令回收只在设备 resume 时触发。** 原因见 3.1 ——
   没法枚举租户做全局清扫。不回来的设备会一直留着陈旧记录。

---

## 6. 工作方式

- **提交信息写"为什么"，不写"改了什么"。** diff 已经说了改了什么。
  值得写的是：什么现象、根因是什么、为什么选这个修法、
  以及为什么另外两种看起来更自然的做法更糟。
- **分批提交、分批推送。** 一个可验证的单元一次提交。
- **推送后核对远端 SHA**，别信 `git push` 的输出：
  `git rev-parse HEAD` 和 `git ls-remote origin refs/heads/main` 要一致。
  （`git push -q 2>&1 | tail -1` 会吞掉 "no upstream branch"，
  已经因此误报过两次"已推送"，实际积压了 6 条和 19 条。）
- **改了功能就回来改 [feature-matrix.md](feature-matrix.md) 的"我们的云端"列。**
  过时的对齐图比没有更糟。
- **判据一律在真机上验。** 这套系统的每一个严重 bug 都是从生产数据里读出来的，
  不是从测试里发现的 —— 但每一个修好之后都补了能复现它的测试。
