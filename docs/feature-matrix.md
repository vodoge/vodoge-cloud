# VoDoge 功能对齐图

把旧版 VoDoge（单机 Go）、开源项目 VoCat、以及我们的云端逐条摆在一起。

清单来自三边的**实际路由表和源码**，不是印象：

| 来源 | 位置 | 规模 |
| --- | --- | --- |
| 旧版 VoDoge | `internal/api/routes.go` | 107 条路由 |
| VoCat | [github.com/MengMengCode/VoCat](https://github.com/MengMengCode/VoCat)（master，2026-08-22） | — |
| 我们的云端 | `apps/gateway`（schema 43） | 68 条注册（去重后 66 条模式，其中 33 条是写） |

云端路由数可以自己数：

```sh
grep -rEn 'mux\.Handle(Func)?\("' apps/gateway/ | grep -v _test | wc -l   # 68
```

（分布在 `main.go` 与 `card_routes.go` / `device_routes.go` /
`messaging_routes.go` / `proxy_routes.go` / `schedule_routes.go` 六个文件里。
**别用更宽的 `grep "mux.Handle"`** —— 它会连 `openapi.go` 里那句
`mux.Handler(probe)`（运行期自检用来问 mux「这条路径匹配哪个 pattern」的）一起数进去，
得到 69。这条旧配方 2026-08-24 当场就多数了一条。）

**注册数比模式数多 2**：`POST /v1/enroll` 与 `POST /v1/ops/backup-failed`
各自在 if/else 两个分支里注册同一个 pattern（配置好的版本与 503 版本），
去重后是一条。**这两个数字都不要手抄** —— 见下。

**这份表的数字不是权威，测试才是**（`go test -v -run 'TestEveryWriteRouteRefusesAReadOnlySession|TestOpenAPIDescribesEveryRegisteredRoute' ./cmd/gateway/`
会打印 `30 write routes refused, 3 exempt, 66 routes registered` 与
`66 routes registered, 66 described`）。这一行曾经长期写着「56 条路由」而实际是 66，
没有任何东西提醒过。现在有两处会红：
`cmd/gateway/main_test.go` 的只读拒绝测试从源码现取路由表（新增一条没被挡住的写路由就红），
`cmd/gateway/openapi_test.go` 的漂移测试断言 OpenAPI 描述的路由集合 == 实际注册的集合
（两个方向都查：漏写描述红，描述了不存在的路由也红）。

**2026-08-25 拿部署后的网关复核过这三个数，不是拿仓库复核的。** 66 条模式逐条在
**运行中的 mux** 上探到：对每条路径发一个没人注册过的方法，Go 的 `ServeMux` 会回 405
并在 `Allow` 头里列出这条路径注册了哪些方法，没注册的路径回 404 ——
**66 条全部 405、零个 404**；同样这 66 条字符串在容器里的网关二进制
（`vodoge-cloud-gateway-1:/usr/local/bin/vodoge-gateway`）里也逐条搜得到（66 命中 / 0 缺失）。

**三个数各自的含义不要混**：`mux.Handle*` 的**调用数是 68**，**去重后的模式数是 66**，
**其中 33 条是写**（非 GET：POST 15、PUT 7、PATCH 2、DELETE 9），另外 33 条是 GET。
测试打印的 `30 write routes refused, 3 exempt` 说的是这 33 条里 30 条被只读会话挡下、
3 条豁免 —— **那不是第四个数**。

**自己数的时候还有一个坑**：68 条里有 **2 条的 pattern 是拼出来的** ——
`mux.Handle("POST "+enroll.Path, …)`（`/v1/enroll`）与 `mux.Handle("GET "+wss.Path, …)`（`/v1/edge`）。
拿 `grep -o` 去抽引号里的 pattern，会把这两条抽成 `POST ` 和 `GET ` 两个空路径，
于是 `/v1/enroll` 与 `/v1/edge` 从清单里消失、而那个 `POST ` 又和 enroll 的另一支撞成重复；
**去重后的总数照样是 66，但那 66 条里有两条是错的**。

三项能力已定案，全部要做：**VoWiFi 与 E911（仅美国）**、**语音通话**、**SM-DP+ 下载**。
决策依据见 [decisions.md](decisions.md)，分阶段计划见 [execution-plan.md](execution-plan.md)。

> **本表的时效性**：`我们的云端` 一列在 **2026-08-25 逐行核过一遍，核的对象是部署后的
> 真实系统**：生产库（`ssh vodoge-cloud` → `docker exec vodoge-cloud-postgres-1 psql -U vodoge -d vodoge`，
> 只读 SELECT）、容器里的制品（网关二进制 `/usr/local/bin/vodoge-gateway`、控制台
> `/app/.next/**` 与 `/app/messages/*.json`）、以及线上 HTTP 响应（网关本机端口 `127.0.0.1:18080`）。
>
> **「仓库里有这段代码」不是本表接受的证据。** 上一轮（2026-08-22）就是照代码核的，
> 结果 `Profile 列表` 与 `切换 / 启用` 两行一直写着「有」，而生产投影一行都没有、
> 控制台上那个按钮根本渲染不出来。**「实现了」和「在真机上生效了」是两件事**，
> 这一列只记后者。
>
> 改动了功能就要回来改这一列 —— 一张过时的对齐图比没有更糟，
> 因为它会让人以为某件事已经做了。

> ⚠️ **2026-08-29 只改了当天动过的行，没有重新逐行核一遍全表。**
> 改过的是：设备管理里的模组身份与拓扑、系统信息与版本、按 ICCID 的卡策略、
> AT 终端，以及新增的「我们独有的:能力台账」小节 —— 这几行的依据都是当天从
> 生产库和容器制品里取的实测值。**其余行仍停留在 2026-08-25 那次核对**，
> 而那之后 schema 从 43 走到了 47，所以它们可能已经偏了。
> 下一次全表核对时，这段警告要一起删掉。

---

## 怎么读这张表

状态只有四种：

| 记号 | 含义 |
| --- | --- |
| **有** | 完整可用 |
| **半** | 部分可用，或只有一半链路 |
| **无** | 没有 |
| **不适用** | 架构上不该有，已决定不做 |

最后一列写清楚**差在哪**，而不是只标个叉。一个叉不能指导任何人动手。

---

## 设备管理

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| 设备列表与在线状态 | 有 | 有 | **有** | 另有版本与积压列，两边都没有。生产 `app.devices` 那一行实测 `edge_version=0.1.0`、`queue_records=2`、`queue_bytes=2492`；控制台 bundle 里对应 `devices.colVersion` 与 `devices.colQueue` 两个列头 |
| 改名 / 删除 | 有 | 有 | **有** | 删除走 SECURITY DEFINER，已演练：生产 `pg_proc` 里 `app.delete_device` 的 `prosecdef = t`，`app.audit_log` 有 3 条 `devices.deleted` |
| 新增设备 | 有 | 有 | **半** | 只能靠注册码自注册，不能手工建 —— 运行中的 mux 上 `/v1/devices` 的 `Allow` 只有 `GET, HEAD`，没有 POST；建设备的唯一入口是 `POST /v1/enrollment-codes` 换码、设备再拿 `POST /v1/enroll` 自注册 |
| 发现未注册硬件 | 有 | 有 | **有** | 边缘第二路枚举 AT 控制口，QMI 够不到的棒子以「待纳管」上报并带 IMEI；真机 ECM 往返验过 |
| 手动重扫描 | 有 | 有 | **有** | `refresh_modems`，生产 CommandResult 实测 `{"found": 3, "rescan": "requested", "control_ports": ["/dev/cdc-wdm0","/dev/cdc-wdm1","/dev/cdc-wdm2"]}`（3 条成功，最近 2026-08-23 12:27） |
| 设备配置读取 | 有 | 有 | **半** | 2026-08-29 起云端看得到物理拓扑与模组身份：生产 `app.modems` 的 `control_port` / `usb_device` / `firmware` / `msisdn` / `apn_contexts` 全有值，控制台设备页各有一列。**仍缺的是可写**：改运行模式、AT 端口这类没有对应命令 kind。判断是不该做 —— 发现每轮都重新校验拓扑，云端写进去的值要么被覆盖，要么把操作对准错误的棒子 |
| 刷新设备缓存 | 有 | 有 | **有** | 同一条 `refresh_modems`（就是上一行那条生产回执），见下方注 |
| 单设备实时流 | 有 | 有 | **半** | 有租户级 SSE —— 运行中的 mux 上 `GET /v1/events` 已注册、无会话回 401；无按设备订阅 |
| 主机资源统计 | 无 | 有 | **有** | CPU 取两次 /proc/stat 之差，内存用 MemAvailable；设备页「主机状态」卡。生产 `app.devices` 实测 `cpu_percent=0.9`、`memory_used_bytes=662175744`、`memory_total_bytes=8326422528`，`host_reported_at` 与上报同分钟；bundle 里有 `device.hostCpu` / `device.hostMemory` / `devices.colHostCpu` |

> **「手动重扫描」与「刷新设备缓存」是同一条 `refresh_modems` 命令。**
> 这两行在别家产品里是两件事，在我们这里不是：`poll_modems` 每一轮都重新
> 枚举 `/dev`，所以并不存在一份独立于枚举结果的设备缓存可刷。「刷新缓存」
> 想要的那个效果 —— 不等下一轮轮询、立刻拿到最新的一份 —— 正是重扫描做
> 的事。再补一条只清缓存不重扫的命令，只会多出一条语义上等价、实现上什么
> 都不做的命令。

### 我们独有的:能力台账

VoCat 没有对应物,所以不在上面的对照表里,但它现在决定这支设备群会不会执行一个操作。

| 能力 | 状态 | 实测依据 |
| --- | --- | --- |
| 支持台账(型号 × 运营商) | **有** | 生产 `app.support_ledger` 4 行,控制台 `/support-ledger` 可读可写可发布。**没测过 = 不支持**:边缘拒绝执行没有实测记录的组合,并指名缺哪次测量 |
| 台账发布到设备 | **有** | 生产 `app.commands` 里 `update_capability_matrix` **1 条 succeeded**(2026-08-29)。发布后 `868019060490134` 的 `capability_origin` 由 `fallback` 变 `rule` —— 内置 TOML 没有 EC200U-CN 这条,只有台账有 |
| 四层裁决 | **半** | 天花板 → 台账 → 运营商 → 套餐,依次收窄、只能做减法。**但四列里只有 `sms_mo` 接进了实际裁决**,`data` / `voice` / `sms_mt` 定义了没有调用点。见 execution-plan 3.6 |

台账实测四行(2026-08-29):

| 型号 × 运营商 | 发 | 收 | 依据 |
| --- | --- | --- | --- |
| EC20 × CN-Mobile | ✓ | ✓ | CXLL → 10086,25 秒后收到流量回复 |
| EC20 × CN-Telecom | ✗ | ✗ | 沿用内置矩阵,**未重测**,`tested_by` 里标注了 |
| EC20 × Generic-International | probe | ✓ | 收:两张卡共 19 条真实入站。发:**测不出** —— 台面两张国际卡各自被套餐挡在不同层(Club 模组层拒、T-Mobile 网络层 `Message Blocking`,连美美互发也拦) |
| EC200U-CN × CN-Telecom | ✓ | ✓ | HFYE → 10001,电信回了余额,回信经 AT 收件箱扫描落库并上云 |

## 射频与网络

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| AT 终端 | 有 | 有 | **有** | 已在真机验证往返：生产 CommandResult `{"ok": true, "port": "/dev/ttyUSB10", "command": "AT+QCSQ", "lines": ["+QCSQ: \"LTE\",48,-74,250,-7"], "terminator": "OK"}`；`run_at_command` 累计 61 条成功。2026-08-29 起**两个入口都设防**：改动射频/通话/短信/卡/持久配置的指令默认拒绝，要显式 `force`。读操作（`?` 与 `=?`）一律放行，链式指令逐段判定（`AT+CSQ;+CFUN=0` 是一条字符串）。真机验过 `AT+CNMI=2,2,0,0,0` 被拒而 `AT+CNMI?` 放行。VoCat 也有「强制模式」，形状相近 |
| USSD 发起 / 继续 / 取消 | 有 | 有 | **半** | 控制台侧已补齐（T083）：部署后 `.next` 全树里 `stage:"start"` / `"continue"` / `"cancel"` **各 2 处命中**（server 与 client 两个 `devices/[deviceId]` chunk），T076 量到的 `continue` 零命中已消失；容器 `vodoge.artifact.sha256` = `0d6e5991…3a713c`。发出的形状是 `{modem_imei: <开启会话那条命令 payload 里的 IMEI>, code, stage:"continue"}` —— **回复按会话所属模组寻址，不按页面上的模组下拉框**（USSD 会话没有标识符，只能靠 AT 端口定位）。**仍然只算「半」，两个理由都不在控制台：**① **边缘会把 continue 要回复的那个会话先关掉** —— `edge-bin/src/main.rs:2155`（HEAD `c17bf57`）在**每一次** USSD 请求前无条件发 `AT+CUSD=2`（「start from a known state」），而同文件 `:1040` 的注释却写着「continue 就是同一条请求打在已开会话上」—— **代码与注释自相矛盾，且代码赢**。于是回复「2」会变成一条全新的 `AT+CUSD=1,"2",15`。**修它要动边缘，T083 明令不许，另开卡。**② **网络侧至今零应答** —— 生产唯一那一次仍是 `{"code": "*#100#", "stage": "network_timeout", "text": "", "expects_reply": false, "elapsed_ms": 30232}`。所以「多级菜单能走完」这件事**没有在真机上验过，也没法验** |
| 模组重启 / 飞行模式 | 有 | 有 | **有** | 部署后的 bundle 里高风险按钮表含 `restart_modem` 与 `set_radio`（点了走 `device.confirmDisruptive` 二次确认），生产 `app.command_kind` 两个标签都在。**但生产 `app.commands` 里这两种各 0 条 —— 通路是部署好的，没在真机上按过** |
| 运营商扫描与选网 | 有 | 有 | **有** | 自动与手动 PLMN 都有：bundle 里 `scan_operators` 在高风险按钮表，`select_operator` 有独立表单（`device.selectOperator` / `device.automatic`）。**生产这两种命令同样各 0 条，未在真机上跑过** |
| 归属网识别（MCC/MNC） | 有 | 有 | **有** | 全部来自卡:`EF_IMSI` 给 IMSI,`EF_AD` 给 **MNC 位数**(byte 4 低半字节),两份都走基础通道 —— QMI 侧 UIM READ TRANSPARENT,AT-only 侧 `AT+CRSM=176,28589,0,0,4`,都不开逻辑通道。**不再假设两位 MNC**:北美是三位,`310260…` 按两位切会得到 `310-26` —— 不是空值而是一个查不到的**错值**,还会把 ePDG FQDN 带成 `mnc026`。台面三根实测 `EF_AD = 00 00 00 02`,归属仍是 454-00 / 460-02 / 454-00。310/311 的美国运营商已补进 `edge-core/src/network.rs` 与 `apps/console/lib/plmn.ts` **两份**表 |
| 信号指标 RSRP/RSRQ/SINR | 有 | 有 | **有** | `AT+QCSQ` 解析在 edge-core；CSQ 在本台面三根都打满 -51 dBm，RSRP 才分得开 |
| 频段 / 信道选择 | 无 | 有 | **无** | VoCat 可锁频段 |
| 数据网络启停 | 有 | 有 | **有** | 真机往返，生产 CommandResult 实测：`requested:"up"` → `contexts:["+CGACT: 1,1", …]`，`requested:"down"` → `["+CGACT: 1,0", …]`（4 条全成功，2026-08-23 05:13/05:14） |
| USBNET 模式切换 | 有 | 有 | **有** | rmnet ↔ ecm 真机往返，生产 CommandResult 实测 `{"mode":"ecm","reported":["+QCFG: \"usbnet\",1"],"reenumerates":true}` ↔ `{"mode":"rmnet","reported":["+QCFG: \"usbnet\",0"]}`（5 条成功）；VoCat 还能自动修复错误的 USBNET |
| APN 管理 | 无 | 有 | **半** | 卡策略里能带 APN（生产 `app.card_policies` 那行 payload 就是 `"apn": "cmnet"`，bundle 里有 `cards.colApn` 列），但没有独立管理：运行中的 mux 上没有任何 APN 路由 |
| 重新注册网络 | 无 | 有 | **有** | 回执带 `serving` 与 `waited_ms`，不是光秃秃的 `+COPS: 0`：生产实测 `{"detach": "OK", "serving": ["+COPS: 0,0,\"CHINA MOBILE\",7"], "waited_ms": 2028}` |
| 出口公网 IP 查询 | 无 | 有 | **有** | 边缘随 DeviceState 上报，与边缘机 `curl -s ifconfig.me` 同分钟核对一致 |
| 换 IP | 有 | 有 | **有** | 部署后的 bundle 里高风险按钮表含 `rotate_ip`，生产 `app.command_kind` 里也有这个标签。**生产 `app.commands` 里 `rotate_ip` 0 条 —— 按钮在，没人按过** |

## 短信

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| 发送 / 接收 | 有 | 有 | **有** | 解码器 2026-08-22 重写，见下方注。生产 `app.messages` 147 行：入站 83 条全部 `received`，出站 64 条（`delivered` 5 / `sent` 4 / `undelivered` 22 / `failed` 31 / `queued` 2） |
| 长短信分片合并 | 有 | 有 | **有** | UDH 剥离与重组已覆盖 GSM-7 / UCS-2 —— 生产入站正文最长 **559 字符**，远超单条 UCS-2 的 70 与 GSM-7 的 160，说明分片确实在真机上被拼回来过 |
| 会话视图与历史 | 有 | 有 | **有** | 收发双向都记录：生产同一张 `app.messages` 里 inbound 83 / outbound 64；运行中的 mux 上 `GET /v1/messages/threads`、`GET /v1/messages/thread`、`GET /v1/sessions` 都已注册 |
| 字符集标注 | 无 | 无 | **有** | `messages.encoding`，二进制正文显示为十六进制并说明（bundle 里 `inbox.encoding8bit`）。生产实测四种取值都出现过：`ucs2` 63 条、`gsm7` 8 条、`8bit` 1 条、`unknown` 11 条（旧存量，见下方注） |
| 送达回执 | 有 | 有 | **有** | 命令回执与网络侧 `+CDS` 是两条路：前者 `queued`→`sent`，后者 `sent`→`delivered`／`undelivered`，各自的时间戳都留着。生产两条路都走到过终态：5 条 `delivered`（`delivered_at` 非空）、22 条 `undelivered`，`app.ingress` 里 59 条 `SmsStatusReport` |
| 联系人列表 | 有 | 有 | **有** | `app.contacts`，按号码命名；名字不随会话删除而消失。生产该表 1 行，`app.audit_log` 有 `messages.contact_saved`；部署后的网关二进制里 `messages.contact_deleted` 与 `messages.thread_deleted` 是两条彼此独立的审计动作 |
| 未读状态 | 无 | 有 | **有** | 仅入站计数，打开会话即已读；迁移把存量一次性标为已读。生产 `app.messages` 里 `read_at IS NULL` 的入站消息 53 条；运行中的 mux 上有 `POST /v1/messages/thread/read`，bundle 里有 `inbox.unread` |
| IMS 短信 | 有 | 有 | **无** | 依赖 VoWiFi 栈 |
| 发送限额 | 有 | 有 | **有** | 按 `messages.created_at` 计数（`received_at` 会被回执改写），超限返回 429。生产 `app.tenant_settings` 的 `sms` 段实测只含 `hourly_limit`，设置页对应 `f.hourly_limit`；`/metrics` 上 `vodoge_requests_rate_limited_total` 目前 0，没撞过限 |

> **短信解码注**：GSM-7 此前**根本没有解码过** —— packed septet 被直接喂给 UTF-8
> 读取器，所以每条美国短码的纯 ASCII 短信都是乱码，而打包产生的 `0x00` 变成 NUL
> 后 jsonb 存不下，反过来堵死了整条上行链路。同时修掉的还有：8bit 数据被当文本读、
> 地址忽略 TOA 靠"以 8 开头"猜 `+`（美国号码永远拿不到前缀）、截断 PDU 会 panic。
> 解码器已从 `#[cfg(target_os = "linux")]` 里搬进 `edge-core`，任何机器上都能测。
> **注意**：库里 2026-08-22 之前的短信是旧二进制入队的存量，`encoding` 标签不可信。
> 2026-08-23 用一条**真实新到**的短信核对过：agent 日志记下 `dcs=0x08`，
> 同一条在 `app.messages` 里是 `ucs2`（DCS 位 3-2 = `10` 即 UCS-2，23.038），两者相符。

> **送达回执注**：`+CDS` 要三样东西同时成立，缺一样就永远等不到回执，而且都不报错。
> ① SUBMIT 的首字节要置 TP-SRR（原先是写死的 `0x01`）；② `AT+CSMS=1`（台面三根都是 0）；
> ③ `AT+CNMI` 的第四个参数要非 0（台面三根都是 0）。回执**不在收件箱**：
> `AT+CPMS=?` 的四个存储区里它进 `SR`，而 QMI WMS 的存储枚举只有 UIM/NV，
> 走 QMI 永远看不见 —— 所以收取走 AT。`SR` 在这批 EC20 上**只有 5 条容量**，
> 读完必须删干净，否则几天后表现为「回执偶尔丢失」。
> 关联靠 TP-MR：一根模组会用自己的编号覆盖我们写进 PDU 的（实测 0→103），
> 另一根照用不误（实测 2→2），所以以模组 `RAW_SEND` 的回答为准。

## eSIM / eUICC

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| Profile 列表 | 有 | 有 | **半** | **持久盘点这一半是空的，而且结构上会一直空。** 生产 `app.esim_profiles` **0 行**，`app.ingress` 里从头到尾**没有一条 `EsimInventory` 信封**（只有 DeviceState / CommandResult / SmsReceived / SmsStatusReport / Alert 五种）—— 投影函数 `app.project_esim_inventory` 部署着，但边缘侧没有生产者往里喂。**能看到 profile 的唯一路径是 `read_esim_info` 那一次性读**，它的回执里带着完整 profile 列表；可是**部署后的控制台把这份列表丢掉了** —— bundle 里那个 `read_esim_info` 解析器只取 `eid / imei / chip / notifications`，不取 `profiles`。表格喂的是 `GET /v1/esim/profiles`（就是那张空投影），所以页面上现在显示的是 `esim.none`「No eUICC has reported its contents yet.」 |
| 切换 / 启用 | 有 | 有 | **半** | **命令这一半在真卡上验过，按钮那一半出不来。** 生产 2026-08-24 13:50 与 13:55 两条 `switch_esim_profile` 都 `succeeded`，夹在中间 13:53 的 `read_esim_info` 读回 `8901240527197122156 enabled=true` / `WEBBING enabled=false` —— **切换确实在台面这颗 eUICC 上生效了**。但 bundle 里 `esim.switch` 按钮是在 profiles 表格的每一行里渲染的，而那张表格来自上一行那份 0 行的投影，**所以按钮渲染不出来，今天唯一能切的路径是直接 `POST /v1/commands`** |
| 禁用当前 Profile | 有 | 有 | **无** | 边缘 `es10c.rs` 有 `disable_profile_apdu`，云端未接：生产 `app.command_kind` 里没有对应标签，部署后的 bundle 里 `esim.*` 也没有 disable 动作 |
| EID 与芯片信息 | 有 | 有 | **有** | 控制台 eSIM 面板的 `read_esim_info`，一条 ISD-R 通道读完 EID + `GetEUICCInfo2`（16 个字段全解码，含剩余非易失内存与 GSMA CI 公钥）+ 通知列表 + profile 列表。生产 19 条成功回执，实测 EID `89086030202200000026000178339240`。注意 GET DATA `5A` 在台上两颗 eUICC 上都回 `6D00`，实际用的是 ES10c `GetEUICCData` |
| 通知列表与重试 | 有 | 有 | **半** | 列表与**取回**（`ListNotification` / `RetrieveNotificationsList`）都有，控制台可见可点（生产 3 条 `retrieve_esim_notification` 成功，最近一次芯片读回来 5 条待投递）。**缺的是「挑一条手动投递」的入口** —— bundle 的 `esim.*` 里只有 `retrieve` / `retrieved` / `notDelivered`，没有任何投递动作。但**投递这件事本身已经在生产上真跑过**：2026-08-24 那次下载的回执里 `handleNotification` 拿到 HTTP 204、`notification_delivered=true`、`notification_removed_code=0`（`RemoveNotificationFromList` 也做了）。所以拦路的不再是 HTTPS 客户端或 GSMA CI 信任链（那两样见下面 ES9+ 一行），而是：投递 delete 通知会让运营商释放用户真实付费账户上的 profile —— 那是一个要用户拍板的动作，不是一个技术缺口。另：两颗 eUICC 都拒绝 `seqNumber` 检索（回 `BF2B 03 81 01 7F`），所以取一条要取全部再挑 |
| ES9+ 与 SM-DP+ 认证 | 有 | 有 | **有** | 控制台按钮 `initiate_esim_authentication` 对**真实生产 SM-DP+** 跑 ES9+ `InitiateAuthentication`，拿回 `transactionId` 与签名响应并渲染。生产 18 条成功回执，两家都打通过：`wbg.prod.ondemandconnectivity.com`（Thales）与 `T-MOBILE.IDEMIA.IO`。回执里 `negotiated_tls=TLSv1_3`、`admin_protocol=gsma/rsp/v2.2.0`，`certificate_signed_by_ci` / `server_signature_valid` / `challenge_echoed` / `ci_key_accepted_by_chip` 四项全 true；信任锚 `gsma-rsp2-root-ci1.pem`、SKI `81370F5125D0B1D408D4C3B232E6D25E795BEBFB`（与两颗芯片 `euiccCiPKIdListForVerification` 一致），来自边缘机上的 `/etc/vodoge/rsp-trust` 目录而不是编进二进制，页面上显示它的指纹与到期日。地址取自卡上：ES10a `GetEuiccConfiguredAddresses` 在两颗芯片上都**没有**默认 SM-DP+（只有 GSMA 测试 SM-DS），所以回落到激活码或待投递通知自带的地址。对卡与账户零副作用 |
| Profile 下载（SM-DP+） | 有 | 有 | **有** | **2026-08-24 10:19–10:20 在台面真卡上跑通了一次完整下载。** 生产回执实测：`installed=true`、`installation_iccid=8901240527197122156`、`smdp_address=T-MOBILE.IDEMIA.IO`、`profiles_added=1`、`refused_policy_rules=[]`、BPP 14278 字节切成 20 段共 44 个 block、`handleNotification` HTTP 204 且 `notification_removed_code=0`；`before.profiles` 只有 WEBBING，`after.profiles` 两条 —— **卡上确实多了一个 profile**。控制台入口也在部署后的 bundle 里：每根模组一个 `esim.dlStart` 按钮，配激活码与确认码输入框、`esim.dlWarn` 二次确认，点了直接 `POST /v1/commands {kind: download_esim_profile}`；生产 `app.audit_log` 那条 `download_esim_profile` 记着 actor 与真实 LPA 激活码。下行命令 `download_esim_profile` 在生产 `app.command_kind` 枚举里（迁移 0043 同步加的，现 26 个标签，与 `max(app.schema_migrations.version)=43` 对得上）。链路：解析激活码 → ES9+ `InitiateAuthentication` → ES10b `AuthenticateServer` → ES9+ `AuthenticateClient` → **读 `profileMetadata`(BF25) 里的 `profilePolicyRules`** → ES10b `PrepareDownload` → ES9+ `GetBoundProfilePackage` → 按 SGP.22 §5.7.5 把 BPP 切成段、每段一条 STORE DATA 链装进卡 → `handleNotification` 投递安装通知 → `RemoveNotificationFromList`。**两条硬规则写进代码而不是留给判断**：①带 **ppr1/ppr2** 的 profile 一律不装，用 `CancelSession(pprNotAllowed)` 退回给 SM-DP+（台上两颗 eUICC 没人能拔，装上就永久占坑）；②**只 install 不 enable** —— 全链路没有一处调 `EnableProfile`，这次回执里 `enabled` 就是显式的 false，控制台把它渲染成一条必须通过的检查 |
| 重命名 / 删除 Profile | 有 | 有 | **无** | 边缘也还没有；部署后的 bundle 里 `esim.*` 同样没有 rename / delete 动作 |
| 按 ICCID 的卡策略 | 有 | 有 | **有** | 2026-08-29 全链路打通。生产 `app.commands` 里 `update_card_policy` 现在有 **1 条 succeeded**（另有 1 failed、3 expired，都在处理分支上线之前）。生产 `app.card_policies` 3 行，除 ICCID / vertical / APN / cellular 外还带四列**套餐能力声明**（`sms_send` / `sms_receive` / `data` / `voice`），控制台是三态下拉：未填写 / 包含 / 不含。三态不能压成勾选框 —— 「没人填过」和「填了不含」是两条不同的记录，只有后者改变行为。声明**严格只能做减法**：它能扣留实测支持的操作，永远不能授予没测过的能力，否则就是拿一份网页上的资费去替硬件声称能力。这一层是唯一能分开同网同模组两张卡的地方，实测过：Club 与 Webbing 同为香港 CSL、同插一根 EC20，Club 在模组层被 `QMI error 54` 拒、Webbing 被接受 |
| PC/SC 读卡器 | 有 | 有 | **无** | 外接读卡器写卡：生产命令枚举里没有对应 kind，控制台也没有入口。台上没人能插读卡器，`port.rs` 的注释说明了为什么不写这段代码 |

## VoWiFi 与语音

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| VoWiFi 启停 | 有 | 有 | **无** | Rust 边缘零 IMS 支持 |
| IKEv2 / ePDG / EAP-AKA | 有 | 有 | **无** | 旧版 1904 行 Go，需重写 |
| VoWiFi 重连与诊断 | 有 | 有 | **无** | — |
| E911 地址登记（websheet） | 有 | 有 | **无** | 代理运营商网页表单，多租户下 SSRF 爆炸半径完全不同 |
| 语音通话：拨号 / 接听 / 挂断 | 无 | 有 | **无** | VoCat 独有，含 IMS 与 CS 双路径 |
| 通话媒体流 | 无 | 有 | **无** | — |

## 代理与流量

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| 代理实例增删改与启停 | 有 | 有 | **半** | 云端 CRUD 是真的：生产 `app.proxy_instances` 1 行（`lab-socks`，`0.0.0.0:1080`），`app.audit_log` 有 `proxy.instance_saved`，网关二进制里 `proxy.instance_removed` 也在，边缘 SOCKS5 运行时已重写。**边缘那一半没有承载**：唯一一条 `configure_proxy` 于 2026-08-22 `expired`，`proxy_lifecycle` 0 条；而且就算送到了也起不来 —— 见本节末尾那段承载缺口 |
| 上游代理与探测 | 有 | 有 | **半** | 探测分阶段报告，云端结构齐了：生产 `app.upstream_proxies` 1 行（`hk-exit`，指向占位地址 `proxy.example.com:1080`），`POST /v1/proxy/upstreams/{id}/probe` 在运行中的 mux 上已注册。**但从来没探过**：该行 `last_probe` 与 `last_probe_at` 都是 NULL，生产 `app.commands` 里 `probe_upstream_proxy` **0 条**。同一个承载缺口 |
| 国家规则 | 有 | 有 | **半** | 路由与界面都部署了：运行中的 mux 上 `GET /v1/proxy/country-rules` 与 `PUT`/`DELETE /v1/proxy/country-rules/{code}` 都在，bundle 里有 `proxy.countryRules` / `proxy.noCountryRules`。**生产 `app.upstream_proxy_country_rules` 0 行**；而且规则的消费方是边缘代理运行时，承载缺口补上之前，写进去也选不中任何出口 |
| Profile ↔ 代理绑定 | 有 | 有 | **无** | 按 Profile 而非按国家绑定上游 |
| 流量统计 | 有 | 有 | **半** | 按小时累加，投影函数 `app.project_proxy_traffic` 已部署，`GET /v1/proxy/traffic` 在运行中的 mux 上。**生产 `app.proxy_traffic` 0 行** —— 没有代理在跑，就没有流量可累加。同一个承载缺口 |
| UDP Associate 检查 | 半 | 有 | **无** | VoWiFi 数据面需要它 |
| 导出代理 | 无 | 有 | **半** | **云端这一半是完整的、已部署的；导出的连接串在这台设备上拨不通。** 缺口见本节末尾那段。云端部分：`GET /v1/proxy/instances/export` 在运行中的 mux 上已注册、无会话回 401，给 `socks5://user:pass@host:port` 逐行连接串，另有 json 与 csv。**只读账号被拒**，而且这条拒绝写在 handler 里 —— T023 的守卫按方法判定，这是 GET，会被放行；用的是守卫用的同一个 `MayWrite` 谓词。**导出进审计、口令不进**（记 actor 与 instance id）：部署后的网关二进制里 `proxy.instances_exported` 与 `proxy.instances_export_refused` 两条审计动作都在，**但生产 `app.audit_log` 里这两条各 0 次 —— 端点部署了，至今没人真导出过**。绑 0.0.0.0 的监听器不会被编出一个假地址，会带着 `?host=` 的修法列为不可导出（台上那唯一一个实例正好就是 `0.0.0.0:1080`，所以现在按下去会落在这条分支上）。**控制台代理页有入口**（T071；bundle 里实测有 `proxy.export` / `proxy.copy` / `proxy.copyAll` / `proxy.exportHost` / `proxy.exportHostHint` / `proxy.exportUnexportable`）：只读账号看不到这个按钮（画之前先问 `/v1/auth/session`，问不到按只读画）；口令只经响应体进 React state —— 不进查询串、不进 localStorage、不进浏览器历史，屏幕上显示的是抹掉口令的那一版，完整连接串只在点「复制」时进剪贴板；不可导出的监听器连同网关给的理由一起显示，不是一个空列表 |

> **代理这一节为什么整节是「半」：云端做完了，边缘没有承载。**
> `edge-proxy` 把 socket 用 `SO_BINDTODEVICE` 绑到 `wwan*`
> （`edge-proxy/src/bind.rs:64` 是全树唯一的 `libc::SO_BINDTODEVICE` 调用点），
> 而边缘机上 **`wwan0` / `wwan1` / `wwan2` 全部 `DOWN`、一个地址都没有**，
> `ip route` 里只有 `default via 192.168.78.2 dev ens160` 和那条 link 路由，
> **经模组的出口 0 条**（T070 的结论，2026-08-25 在边缘机上复核仍然如此）。
> 于是：代理实例配下去起不来、上游探不了、国家规则选不中出口、流量表永远 0 行、
> 导出的连接串拿去连没有人应答。
>
> **这不是代理代码的缺陷，是缺一层数据承载** —— 与 T027 查出的「边缘全树没有 WDS 服务、
> 没有 `AT+CGDCONT`、没有 PDN/bearer 层」是同一个洞。T016 已证明**模组自己**有完整 IP 栈
> （`AT+QIACT` 能拿到真 IP），但那个 IP 在模组里，不在主机的 `wwan` 接口上。
> **补上它之前，这几行都不该写成不带保留的「有」。**

## 通知与自动化

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| Webhook / 邮件 / Bark | 有 | 有 | **有** | 三渠道已实现并接线，Webhook 带 HMAC-SHA256 签名。部署后的网关二进制与控制台 bundle 里 `webhook` / `email` / `bark` 的字段都在（`f.webhook.*` / `f.email.*` / `f.bark.*`）。生产只配了 webhook 一个，而且它指向一个不存在的测试主机 `hooktest:19999`，所以 `/metrics` 上是 `vodoge_notifications_total{channel="webhook",result="failed"} 2` —— **那是配置里的占位地址，不是投递代码的问题**：同一套投递把 telegram 与 pushplus 各送成了 2 条 |
| 渠道连通性测试 | 有 | 无 | **有** | 同步返回，控制台七个渠道各有一个按钮（按钮列表由字段表推导，不再手写第二份）。运行中的 mux 上 `POST /v1/settings/notifications/{channel}/test` 已注册；生产 `app.audit_log` 有 9 条 `settings.notification_tested`；七个渠道名（webhook / email / bark / telegram / feishu / wecom / pushplus）在网关二进制与 bundle 里都齐 |
| 入站短信转发通知 | 有 | 有 | **有** | 通知只带发信人，不带正文（正文外发到第三方是另一回事）。生产 `/metrics` 实测已送达：`vodoge_notifications_total{channel="telegram",result="delivered"} 2`、`{channel="pushplus",result="delivered"} 2` |
| 命令失败通知 | 有 | 有 | **有** | 走与上一行同一条分道投递管道。**注意 `/metrics` 只按渠道与结果分桶、不按事件类型分**，所以生产那 4 条已送达通知分不出是哪种事件触发的；素材倒是不缺（生产 `app.commands` 里 31 条 `send_sms` failed、4 条 `run_at_command` expired） |
| 设备掉线通知 | 有 | 有 | **有** | 按**缺席时长**判定而非会话结束即报，否则每次部署都告警。演练实测 179 秒送达；生产侧的活对照是 `/metrics` 的 `vodoge_device_sessions_active`（当前 1）与 `app.devices` 的 `last_seen_at` / `resumed_at` 一直在走 |
| 契约违规通知 | 有 | 无 | **有** | 同一 (租户, kind, 违规字段) 一小时内只报一次——一个坏 enum 会让每条报文都违规。生产 `/metrics` 上 `vodoge_contract_violations_total` 与 `vodoge_ingress_rejected_total` 都是 **0**：计数器部署着，至今没触发过 |
| 备份失败通知 | 无 | 无 | **有** | `backup.sh` 的 trap 上报到 `/v1/ops/backup-failed`；备份不属于任何租户，收件人由 `VODOGE_OPS_TENANT` 指定。云主机上实测：`POST /v1/ops/backup-failed` 在运行中的 mux 上已注册，部署用的 `.env` 里 `VODOGE_OPS_TENANT` 已设，`vodoge-backup.timer` 是活的（上次触发 2026-08-24 03:30:04） |
| 通知投递重试 | 有 | 有 | **有** | 每渠道指数退避，重试窗口约 6 分钟（1s 起翻倍、封顶 45s）——此前是 3 次 × 2s，只扛得住约 4 秒中断。投递按 (租户, 渠道) 分道并行，一个卡住的渠道不再独占唯一的投递 goroutine 把别人的事件挤出队列。队列满仍然丢弃且是**故意的**（反压会拖垮 ingest），但丢了多少、重试了多少次现在可查，而且**在生产上正好看得见**：`/metrics` 实测 `vodoge_notification_retries_total{channel="webhook"} 26`（那个占位 URL 一直连不上，退避在真跑）、`vodoge_notifications_dropped_total 0`、`vodoge_notifications_total` 按渠道与结果分桶 |
| Telegram / 飞书 / 企微 / Pushplus | 有 | 有 | **有** | 四个渠道都在 `channels.go` 里实现，走 T010 那套分道投递（指数退避 + 三个计数器），设置页各有输入框与「测试」按钮 —— 部署后的 bundle 里 `f.telegram.*` / `f.feishu.*` / `f.wecom.*` / `f.pushplus.*` 字段齐全，生产 telegram 与 pushplus 各有 2 条 `result="delivered"`。飞书支持签名校验；飞书/企微在 HTTP 200 里用 `code`/`errcode` 表达拒绝，只看状态码会把每一次被拒都记成送达。Telegram 的 bot token 在 URL 路径里，错误信息会带出来，已在日志与页面上打码。**槽位与实现的集合相等由测试守着**（`TestEveryConfigurableChannelHasASender`）—— 上一次漂移就是槽位有、实现无，配了也不会发且不报错 |
| Telegram 机器人远程控制 | 无 | 有 | **半** | `internal/telegram`：`/status` `/profiles` `/sms` `/switch` `/reset`，后三个走一次性确认按钮（3 分钟有效、只有发起者能按、按过即作废）。生产上它是**开着**的（`app.tenant_settings` 的 `notifications.telegram.bot.enabled = true`，operators 已配），bundle 里有 `f.telegram.bot.enabled` / `f.telegram.bot.operators`；但 `/metrics` 的 `vodoge_telegram_updates_total` 与 `vodoge_telegram_actions_total` **当前都是 0**，本轮网关启动以来没人用过。**长轮询不是 webhook** —— webhook 会在公网上多出一条不带会话、只读中间件直接放行的 POST 写路由，正是 2.4 刚收口掉的形状。**机器人没有自己的权限**:chat 映射到一个真实账号（设置页 `telegram.bot.operators`，每行 `telegram_id=邮箱`），网关为它签一张短期会话，再走**同一个 handler**（含只读中间件）下发；未映射的发送者什么都碰不到。通话未做（阶段 4）|
| 定时自动任务 | 无 | 有 | **有** | `app.scheduled_tasks` + `internal/schedule`：按卡（ICCID）或按设备编排定时短信与公网 IP 巡检。**生产上正在跑**：4 条任务、2 条 enabled —— `keepalive-hourly-4820`（按卡 `89852351225042214201`，3600 秒，第 21 次触发于 2026-08-24 18:17，`last_status=issued`，幂等键 `schedule:<任务 id>:21`）与 `egress-ip-watch`（按设备，第 31 次触发于 18:21，`last_status=checked`，detail `{"found": true, "public_ip": "34.174.243.156"}`）。**拨号仍缺**，因为契约里还没有 dial 命令 kind（阶段 4）；调度器不解释 kind，那一天到了不用改它 |

## 运维与平台

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| 实时日志流 | 有 | 有 | **有** | 租户级 SSE：运行中的 mux 上 `GET /v1/events` 已注册、无会话回 401，控制台设备页有 `devices.liveHint` |
| 历史日志 / 原始报文 | 有 | 有 | **有** | 云端可展开设备原始 envelope：`GET /v1/journal` 在运行中的 mux 上，生产 `app.ingress` 72879 行五种 kind，bundle 的 journal 页有 `journal.show` / `journal.hide` 展开原始 payload |
| 日志保留策略 | 无 | 有 | **有** | `app.prune_ingress` 删除超过 **30 天**的 `DeviceState` 行（生产实测 `app.ingress` 72879 行里 DeviceState 占 **72683 行 = 99.7%**，与当初量的 99.6% 吻合；每个字段的当前值都在 `app.devices`/`app.modems` 里）。**SmsReceived / SmsStatusReport / CommandResult / Alert / Unstorable 一行都不删** —— 生产里这几种合计 196 行，正是排障真正回头看的那些。挂在 2.1 调度器的每租户 tick 上（`app.tenants` 枚举不了，没有全局清扫这条路）。**函数与高水位表都在生产上**（`app.prune_ingress`、`app.ingress_pruned`），但 `app.ingress_pruned` 现在 0 行、最老的 ingress 才 2026-08-21 —— **30 天还没到，删除那一步至今没真跑过**。**要点**：`app.ingress_window` 的 committed_through 是从表里数出来的连续前缀，裸删一行就会让它塌成 0、设备重放整个 outbox；所以 0040 同时引入 `app.ingress_pruned` 高水位并让窗口函数从它起算，且水位只在证明该区间连续之后才前移 |
| 审计日志 | 有 | 有 | **有** | 生产 `app.audit_log` 325 行、29 种 action（登录、各类命令下发、设置变更、删除都在里面）；`GET /v1/audit` 在运行中的 mux 上，控制台有 audit 页 |
| 登录限流 | 无 | 有 | **有** | `/metrics` 上有 `vodoge_requests_rate_limited_total`（当前 0，没撞过限）；生产 `app.audit_log` 里 `auth.login` 32 条与 `auth.login.failed` 11 条分开记 |
| 访问策略 / 多角色 | 有 | 有 | **有** | `app.users.role` = admin / readonly，生产两种角色各有一个真账号；只读会话被网关在整张路由表外侧一处拒绝，30 条写路由逐条验过，只有本人的登出与改密除外。运行中的 mux 上写路由共 33 条（30 拒 + 3 豁免），抽查的 `/v1/modems`、`/v1/audit`、`/v1/sessions`、`/v1/journal`、`/v1/events`、`/v1/openapi.json`、`/v1/proxy/instances/export` 无会话时全部 401「sign in required」。**只读会话被拒那一步要有登录态才看得到，2026-08-25 这一轮没验**（那一轮不铸会话） |
| 系统信息与版本 | 有 | 有 | **有** | 2026-08-29 补齐。生产 `app.devices` 实测：`hostname = vodoge`、`cpu_model = 12th Gen Intel(R) Core(TM) i5-12400F`、`kernel = 6.8.0-138-generic`、`disk_used/total_bytes`、`net_rx/tx_bytes_per_sec`，加上原有的 `public_ip` / `cpu_percent` / 内存。磁盘取的是 agent 数据库所在的文件系统（撑爆它才会让 outbox 提交失败），吞吐是两次轮询之间的速率、排除 `wwan` 与回环 |
| 检查更新 / 应用更新 | 有 | 有 | **半** | 有 `self_update` 命令（生产 `app.command_kind` 枚举里有这个标签），无制品发布与检查；而且**部署后的控制台 bundle 里 `self_update` 零命中**（没有入口），生产 `app.commands` 里也 0 条 |
| 指标端点 | 无 | 有 | **有** | 生产 `GET /metrics` 免鉴权 200，实测 13 组指标：HTTP 请求与耗时、ingress 接收与丢弃、命令入队、契约违规、限流、设备会话、通知三件套、Telegram 两件套 |
| 中英双语 | 有 | 有 | **有** | 有测试保证两个语言包键一致 —— 而且在部署后的制品上直接验得了：容器里 `/app/messages/en.json` 与 `zh.json` 各 **491** 个扁平化键，两个方向的差集都是空 |
| 多租户与行级隔离 | 无 | 无 | **有** | 我们独有，两边都是单机单用户。生产实测 `app` 下 27 张表里 **26 张** `relrowsecurity` 与 `relforcerowsecurity` 双开（唯一没开的是 `schema_migrations`，它不带租户列） |
| 数据库备份与恢复 | 无 | 无 | **有** | 每日转储 + 已演练恢复：云主机上 `vodoge-backup.timer` 是活的（上次 2026-08-24 03:30:04，下次 03:30），`/opt/vodoge-cloud/stage/` 下按日期躺着一串 `vodoge-*.dump` |
| PWA / 离线外壳 | 无 | 无 | **有** | 线上实测 `GET /manifest.webmanifest` 200，返回 `display: standalone` 的清单；容器 `/app/public` 里有 `sw.js` 与 `offline.html` |
| OpenAPI 文档 | 有 | 无 | **有** | OpenAPI 3.1，网关自己在 `GET /v1/openapi.json` 上供（走会话鉴权：它是整个攻击面的地图）—— 运行中的 mux 上这条已注册、无会话回 401，网关二进制里带着 `3.1.1` 版本串。**不是手抄的静态文件** —— 见 [api.md](api.md)：漂移测试断言描述的路由集合 == 实际注册的集合，二进制在供出文档前还会拿活的 mux 复核一遍。路径参数、operationId、命令 kind 枚举、settings 段与通知渠道枚举、以及写路由的 403 都是从代码派生的 |
| 插件 / 扩展 | 有 | 有 | **不适用** | 已决定砍掉，理由见 [plugins-not-ported.md](plugins-not-ported.md) |
| 自签 HTTPS 设置 | 有 | 有 | **不适用** | TLS 在网关与 Caddy 终结，不是租户的事 |
| 卸载 / 自毁 | 有 | 无 | **不适用** | 单机概念 |

---

## VoCat 教会我们的事

这三项是 **VoCat 有、旧版没有、而且明显该有**的。它们改变了排期。

### 定时自动任务

定时发短信、定时拨号、定时查公网 IP。对一批需要保号的 SIM 来说，
这不是锦上添花，而是这套系统存在的理由之一 —— 没有它，保号得靠人记着。

VoCat 的实现还处理了一个真问题：**一旦消息进入了模组或 IMS 事务，
重试整条会造成重复投递**，所以只有准备阶段的失败才可以安全重试。
这个教训要照抄。

已照抄，并且做成了结构而不是纪律：幂等键由 **(任务 id, 第几次触发)** 推导，
不含时间戳、随机数与 payload。`app.enqueue_command` 对已绑定的键返回已存在的命令，
所以「重放一次触发」在任何情况下都收敛到同一条命令，而不是造出第二条。
只有解析计划、选设备、构造 payload 这些还没碰到模组的阶段会被重试；
一旦进了 `app.enqueue_command`，无论成功还是撞键，那一次触发就此结账。

**租户枚举是硬约束**：`app.tenants` 带 FORCE RLS，连表属主的 SECURITY DEFINER
函数都枚举不了，所以不存在全局 cron。调度器骑在**在线设备会话**上取租户上下文
（证书主题里就带 tenant_id，不用查库），代价是：某租户一台设备都不在线时它不推进，
过期的触发记为 `skipped_stale` 而不是补发一串。这条同时给 L3 提供了第二条
带租户上下文的路径 —— 过期命令回收不再只能等设备重连。

### Telegram 机器人

不用开控制台就能查状态、切 Profile、发短信，敏感操作走一次性确认按钮。
对一个人管着十几根棒子的场景，这比网页快得多。

双向已经通了。真正的设计问题不是指令解析，而是**机器人是第二条鉴权入口**：
一条 Telegram 消息最后执行的和网页点击是同一个操作，所以它走同一扇门 ——
chat 映射到一个真实控制台账号，网关为那个账号签一张两分钟的会话，
再把请求交给**网关自己的 handler**（`telegram.Loopback`），
于是只读中间件、租户边界、限流、审计一条不落，因为那就是同一条请求路径。
直接调 handler 函数会更简单，也正是这里要防的绕过。

三个 IMEI 目标指令自己去查设备：人只认得 IMEI，API 按 device 寻址，
查不到就在提示确认之前拒绝 —— 否则命令会入队、几分钟后由 agent 拒绝，
而那时没人在看。

### 语音通话

拨号、接听、挂断、媒体流，IMS 与电路域双路径。旧版完全没有这块。
**已定为要大力发展的能力**，因此它是架构约束而不只是一个功能。

---

## 清点硬件后改变的排期

台上三根棒子：

| 模组 IMEI | eUICC | Profile | 归属 |
| --- | --- | --- | --- |
| 862547055142811 | 有 | Club · 8985…9571 | 香港 CSL |
| 867018069514820 | 有 | WEBBING · 8985…4201（enabled）+ Wireless · 8901…2156（disabled） | 香港 CSL ＋ 美国 T-Mobile |
| 867018069509705 | 无 | ISD-R 通道打不开 | 中国移动实体卡 |

### 台上原本没有任何美国卡 —— 2026-08-24 起有了

Saily 是 eSIM 供应商，它的美国 profile 要先通过 **SM-DP+ 下载**到 eUICC 上才会存在。

所以 SM-DP+ 下载是 VoWiFi 与 E911 **能被验证的前置条件**，不是可以排在它们之后的
独立项目。原来的顺序（eSIM 在 VoWiFi 之前）是对的，但理由错了 —— 真正的理由不是
"eSIM 功能应该先补齐"，而是"**没有它就没有美国卡可测**"。

阶段 3 因此是关键路径，且**不能只做一半**。

**这一段已经兑现。** 2026-08-24 10:19 一条 `download_esim_profile` 把
`8901240527197122156`（T-Mobile，SM-DP+ `T-MOBILE.IDEMIA.IO`）装进了 867018069514820
那颗 eUICC；13:50 又把它 enable 过一次，13:53 的芯片读回证实 `enabled=true`，
13:55 切回 WEBBING。**台上现在有一张真的美国 profile**，判据②a 要的卡侧读数因此才谈得上。

### 每个 eUICC 曾经只有一个 profile

这同时解释了 profile 切换演练为什么一直做不了：禁用唯一的 profile 等于让卡脱网，
且没有回滚路径。下载能力一并解开这个死结 —— **有了第二个 profile 才敢切换**，
2026-08-24 那次来回切换就是第一次真的敢做。

现在 867018069514820 上有两个 profile；`862547055142811` 仍然只有一个，
`867018069509705` 一个都没有（它不是 eUICC）。
