# VoDoge 功能对齐图

把旧版 VoDoge（单机 Go）、开源项目 VoCat、以及我们的云端逐条摆在一起。

清单来自三边的**实际路由表和源码**，不是印象：

| 来源 | 位置 | 规模 |
| --- | --- | --- |
| 旧版 VoDoge | `internal/api/routes.go` | 107 条路由 |
| VoCat | [github.com/MengMengCode/VoCat](https://github.com/MengMengCode/VoCat)（master，2026-08-22） | — |
| 我们的云端 | `apps/gateway`（schema 40） | 68 条注册（去重后 66 条模式，其中 33 条是写） |

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

三项能力已定案，全部要做：**VoWiFi 与 E911（仅美国）**、**语音通话**、**SM-DP+ 下载**。
决策依据见 [decisions.md](decisions.md)，分阶段计划见 [execution-plan.md](execution-plan.md)。

> **本表的时效性**：`我们的云端` 一列在 2026-08-22 逐条核对过代码。
> 改动了功能就要回来改这一列 —— 一张过时的对齐图比没有更糟，
> 因为它会让人以为某件事已经做了。

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
| 设备列表与在线状态 | 有 | 有 | **有** | 另有版本与积压列，两边都没有 |
| 改名 / 删除 | 有 | 有 | **有** | 删除走 SECURITY DEFINER，已演练 |
| 新增设备 | 有 | 有 | **半** | 只能靠注册码自注册，不能手工建 |
| 发现未注册硬件 | 有 | 有 | **有** | 边缘第二路枚举 AT 控制口，QMI 够不到的棒子以「待纳管」上报并带 IMEI；真机 ECM 往返验过 |
| 手动重扫描 | 有 | 有 | **有** | `refresh_modems`，真机回执 `found: 3` |
| 设备配置读取 | 有 | 有 | **无** | 边缘的运行配置无法从云端查看 |
| 刷新设备缓存 | 有 | 有 | **有** | 同一条 `refresh_modems`，见下方注 |
| 单设备实时流 | 有 | 有 | **半** | 有租户级 SSE，无按设备订阅 |
| 主机资源统计 | 无 | 有 | **有** | CPU 取两次 /proc/stat 之差，内存用 MemAvailable；设备页「主机状态」卡 |

> **「手动重扫描」与「刷新设备缓存」是同一条 `refresh_modems` 命令。**
> 这两行在别家产品里是两件事，在我们这里不是：`poll_modems` 每一轮都重新
> 枚举 `/dev`，所以并不存在一份独立于枚举结果的设备缓存可刷。「刷新缓存」
> 想要的那个效果 —— 不等下一轮轮询、立刻拿到最新的一份 —— 正是重扫描做
> 的事。再补一条只清缓存不重扫的命令，只会多出一条语义上等价、实现上什么
> 都不做的命令。

## 射频与网络

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| AT 终端 | 有 | 有 | **有** | 已在真机验证 `AT+CSQ` 往返 |
| USSD 发起 / 继续 / 取消 | 有 | 有 | **有** | — |
| 模组重启 / 飞行模式 | 有 | 有 | **有** | — |
| 运营商扫描与选网 | 有 | 有 | **有** | 自动与手动 PLMN 都有 |
| 归属网识别（MCC/MNC） | 有 | 有 | **有** | 全部来自卡:`EF_IMSI` 给 IMSI,`EF_AD` 给 **MNC 位数**(byte 4 低半字节),两份都走基础通道 —— QMI 侧 UIM READ TRANSPARENT,AT-only 侧 `AT+CRSM=176,28589,0,0,4`,都不开逻辑通道。**不再假设两位 MNC**:北美是三位,`310260…` 按两位切会得到 `310-26` —— 不是空值而是一个查不到的**错值**,还会把 ePDG FQDN 带成 `mnc026`。台面三根实测 `EF_AD = 00 00 00 02`,归属仍是 454-00 / 460-02 / 454-00。310/311 的美国运营商已补进 `edge-core/src/network.rs` 与 `apps/console/lib/plmn.ts` **两份**表 |
| 信号指标 RSRP/RSRQ/SINR | 有 | 有 | **有** | `AT+QCSQ` 解析在 edge-core；CSQ 在本台面三根都打满 -51 dBm，RSRP 才分得开 |
| 频段 / 信道选择 | 无 | 有 | **无** | VoCat 可锁频段 |
| 数据网络启停 | 有 | 有 | **有** | 真机往返 `+CGACT: 1,1` ↔ `1,0` |
| USBNET 模式切换 | 有 | 有 | **有** | rmnet ↔ ecm 真机往返；VoCat 还能自动修复错误的 USBNET |
| APN 管理 | 无 | 有 | **半** | 卡策略里能带 APN，但没有独立管理 |
| 重新注册网络 | 无 | 有 | **有** | 回执带 `serving` 与 `waited_ms`，不是光秃秃的 `+COPS: 0` |
| 出口公网 IP 查询 | 无 | 有 | **有** | 边缘随 DeviceState 上报，与边缘机 `curl -s ifconfig.me` 同分钟核对一致 |
| 换 IP | 有 | 有 | **有** | — |

## 短信

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| 发送 / 接收 | 有 | 有 | **有** | 解码器 2026-08-22 重写，见下方注 |
| 长短信分片合并 | 有 | 有 | **有** | UDH 剥离与重组已覆盖 GSM-7 / UCS-2 |
| 会话视图与历史 | 有 | 有 | **有** | 收发双向都记录 |
| 字符集标注 | 无 | 无 | **有** | `messages.encoding`，二进制正文显示为十六进制并说明 |
| 送达回执 | 有 | 有 | **有** | 命令回执与网络侧 `+CDS` 是两条路：前者 `queued`→`sent`，后者 `sent`→`delivered`／`undelivered`，各自的时间戳都留着 |
| 联系人列表 | 有 | 有 | **有** | `app.contacts`，按号码命名；名字不随会话删除而消失 |
| 未读状态 | 无 | 有 | **有** | 仅入站计数，打开会话即已读；迁移把存量一次性标为已读 |
| IMS 短信 | 有 | 有 | **无** | 依赖 VoWiFi 栈 |
| 发送限额 | 有 | 有 | **有** | 按 `messages.created_at` 计数（`received_at` 会被回执改写），超限返回 429 |

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
| Profile 列表 | 有 | 有 | **有** | 已投影为持久盘点 |
| 切换 / 启用 | 有 | 有 | **有** | — |
| 禁用当前 Profile | 有 | 有 | **无** | 边缘 `es10c.rs` 有 `disable_profile_apdu`，云端未接 |
| EID 与芯片信息 | 有 | 有 | **有** | 控制台 eSIM 面板的 `read_esim_info`，一条 ISD-R 通道读完 EID + `GetEUICCInfo2`（16 个字段全解码，含剩余非易失内存与 GSMA CI 公钥）+ 通知列表 + profile 列表。注意 GET DATA `5A` 在台上两颗 eUICC 上都回 `6D00`，实际用的是 ES10c `GetEUICCData` |
| 通知列表与重试 | 有 | 有 | **半** | 列表与**取回**（`ListNotification` / `RetrieveNotificationsList`）都有，控制台可见可点。**投递仍然没有**，但拦路的东西变了：HTTPS 客户端与 GSMA CI 信任链现在有了（见下面的 ES9+ 一行），剩下的是 `handleNotification` 之后必须 `RemoveNotificationFromList`，那是写卡，而且投递 delete 通知会让运营商释放用户真实付费账户上的 profile —— 这是一个要用户拍板的动作，不是一个技术缺口。另：两颗 eUICC 都拒绝 `seqNumber` 检索（回 `BF2B 03 81 01 7F`），所以取一条要取全部再挑 |
| ES9+ 与 SM-DP+ 认证 | 有 | 有 | **有** | 控制台按钮 `initiate_esim_authentication` 对**真实生产 SM-DP+**（`wbg.prod.ondemandconnectivity.com`，Thales）跑 ES9+ `InitiateAuthentication`，拿回 `transactionId` 与签名响应并渲染。TLS 与 RSP 两层都按 **GSMA CI 根**（`GSM Association - RSP2 Root CI1`，SKI `81370F51…795BEBFB`，与两颗芯片 `euiccCiPKIdListForVerification` 一致）验过；根证书是 `/etc/vodoge/rsp-trust/` 下的文件而不是编进二进制，页面上显示它的指纹与到期日。地址取自卡上：ES10a `GetEuiccConfiguredAddresses` 在两颗芯片上都**没有**默认 SM-DP+（只有 GSMA 测试 SM-DS），所以回落到待投递通知自带的地址。对卡与账户零副作用 |
| Profile 下载（SM-DP+） | 有 | 有 | **半** | **代码全通、边缘已部署，真卡下载尚未跑过。** 新增下行命令 `download_esim_profile`（迁移 0043 同步加 PG 枚举，现 26 标签）：解析激活码 → ES9+ `InitiateAuthentication` → ES10b `AuthenticateServer` → ES9+ `AuthenticateClient` → **读 `profileMetadata`(BF25)里的 `profilePolicyRules`** → ES10b `PrepareDownload` → ES9+ `GetBoundProfilePackage` → 按 SGP.22 §5.7.5 把 BPP 切成段、每段一条 STORE DATA 链装进卡 → `handleNotification` 投递安装通知 → `RemoveNotificationFromList`。**两条硬规则写进代码而不是留给判断**：①带 **ppr1/ppr2** 的 profile 一律不装,用 `CancelSession(pprNotAllowed)` 退回给 SM-DP+（台上两颗 eUICC 没人能拔,装上就永久占坑）;②**只 install 不 enable** —— 全链路没有一处调 `EnableProfile`,结果里 `enabled` 是显式的 false,控制台把它渲染成一条必须通过的检查。**还差的就是在真卡上跑一次** —— 云主机在本切片的部署过程中被 Go 构建拖垮（见下一行）,网关与控制台的新版本没能上线,所以从控制台发起下载这一步没做成 |
| 重命名 / 删除 Profile | 有 | 有 | **无** | 边缘也还没有 |
| 按 ICCID 的卡策略 | 有 | 有 | **有** | 下发到全部设备 |
| PC/SC 读卡器 | 有 | 有 | **无** | 外接读卡器写卡 |

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
| 代理实例增删改与启停 | 有 | 有 | **有** | 边缘 SOCKS5 运行时已重写 |
| 上游代理与探测 | 有 | 有 | **有** | 探测分阶段报告 |
| 国家规则 | 有 | 有 | **有** | — |
| Profile ↔ 代理绑定 | 有 | 有 | **无** | 按 Profile 而非按国家绑定上游 |
| 流量统计 | 有 | 有 | **有** | 按小时累加 |
| UDP Associate 检查 | 半 | 有 | **无** | VoWiFi 数据面需要它 |
| 导出代理 | 无 | 有 | **有** | `GET /v1/proxy/instances/export`：`socks5://user:pass@host:port` 逐行连接串，另有 json 与 csv。**只读账号被拒**，而且这条拒绝写在 handler 里 —— T023 的守卫按方法判定，这是 GET，会被放行；用的是守卫用的同一个 `MayWrite` 谓词。**导出进审计、口令不进**（记 actor 与 instance id），且审计追加在这条路由上是致命的：没留痕的凭据导出不允许发生。绑 0.0.0.0 的监听器不会被编出一个假地址，会带着 `?host=` 的修法列为不可导出 |

## 通知与自动化

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| Webhook / 邮件 / Bark | 有 | 有 | **有** | 三渠道已实现并接线，Webhook 带 HMAC-SHA256 签名 |
| 渠道连通性测试 | 有 | 无 | **有** | 同步返回，控制台七个渠道各有一个按钮（按钮列表由字段表推导，不再手写第二份） |
| 入站短信转发通知 | 有 | 有 | **有** | 通知只带发信人，不带正文（正文外发到第三方是另一回事） |
| 命令失败通知 | 有 | 有 | **有** | — |
| 设备掉线通知 | 有 | 有 | **有** | 按**缺席时长**判定而非会话结束即报，否则每次部署都告警。演练实测 179 秒送达 |
| 契约违规通知 | 有 | 无 | **有** | 同一 (租户, kind, 违规字段) 一小时内只报一次——一个坏 enum 会让每条报文都违规 |
| 备份失败通知 | 无 | 无 | **有** | `backup.sh` 的 trap 上报到 `/v1/ops/backup-failed`；备份不属于任何租户，收件人由 `VODOGE_OPS_TENANT` 指定 |
| 通知投递重试 | 有 | 有 | **有** | 每渠道指数退避，重试窗口约 6 分钟（1s 起翻倍、封顶 45s）——此前是 3 次 × 2s，只扛得住约 4 秒中断。投递按 (租户, 渠道) 分道并行，一个卡住的渠道不再独占唯一的投递 goroutine 把别人的事件挤出队列。队列满仍然丢弃且是**故意的**（反压会拖垮 ingest），但丢了多少、重试了多少次现在可查：`/metrics` 的 `vodoge_notifications_dropped_total`、`vodoge_notification_retries_total`、`vodoge_notifications_total` |
| Telegram / 飞书 / 企微 / Pushplus | 半 | 有 | **有** | 四个渠道都在 `channels.go` 里实现，走 T010 那套分道投递（指数退避 + 三个计数器），设置页各有输入框与「测试」按钮。飞书支持签名校验；飞书/企微在 HTTP 200 里用 `code`/`errcode` 表达拒绝，只看状态码会把每一次被拒都记成送达。Telegram 的 bot token 在 URL 路径里，错误信息会带出来，已在日志与页面上打码。**槽位与实现的集合相等由测试守着**（`TestEveryConfigurableChannelHasASender`）—— 上一次漂移就是槽位有、实现无，配了也不会发且不报错 |
| Telegram 机器人远程控制 | 无 | 有 | **半** | `internal/telegram`：`/status` `/profiles` `/sms` `/switch` `/reset`，后三个走一次性确认按钮（3 分钟有效、只有发起者能按、按过即作废）。**长轮询不是 webhook** —— webhook 会在公网上多出一条不带会话、只读中间件直接放行的 POST 写路由，正是 2.4 刚收口掉的形状。**机器人没有自己的权限**:chat 映射到一个真实账号（设置页 `telegram.bot.operators`，每行 `telegram_id=邮箱`），网关为它签一张短期会话，再走**同一个 handler**（含只读中间件）下发；未映射的发送者什么都碰不到。通话未做（阶段 4）|
| 定时自动任务 | 无 | 有 | **有** | `app.scheduled_tasks` + `internal/schedule`：按卡（ICCID）或按设备编排定时短信与公网 IP 巡检。**拨号仍缺**，因为契约里还没有 dial 命令 kind（阶段 4）；调度器不解释 kind，那一天到了不用改它 |

## 运维与平台

| 功能 | 旧 VoDoge | VoCat | 我们的云端 | 差在哪 |
| --- | --- | --- | --- | --- |
| 实时日志流 | 有 | 有 | **有** | — |
| 历史日志 / 原始报文 | 有 | 有 | **有** | 云端可展开设备原始 envelope |
| 日志保留策略 | 无 | 有 | **有** | `app.prune_ingress` 删除超过 **30 天**的 `DeviceState` 行（实测 2.6 万行/天、715 B/行，占 `app.ingress` 的 99.6%，且每个字段的当前值都在 `app.devices`/`app.modems` 里）。**SmsReceived / SmsStatusReport / CommandResult / Alert / Unstorable 一行都不删** —— 约 90 行/天，正是排障真正回头看的那些。挂在 2.1 调度器的每租户 tick 上（`app.tenants` 枚举不了，没有全局清扫这条路）。**要点**：`app.ingress_window` 的 committed_through 是从表里数出来的连续前缀，裸删一行就会让它塌成 0、设备重放整个 outbox；所以 0040 同时引入 `app.ingress_pruned` 高水位并让窗口函数从它起算，且水位只在证明该区间连续之后才前移 |
| 审计日志 | 有 | 有 | **有** | — |
| 登录限流 | 无 | 有 | **有** | — |
| 访问策略 / 多角色 | 有 | 有 | **有** | `app.users.role` = admin / readonly；只读会话被网关在整张路由表外侧一处拒绝，30 条写路由逐条验过，只有本人的登出与改密除外 |
| 系统信息与版本 | 有 | 有 | **半** | 有设备版本，无边缘主机信息 |
| 检查更新 / 应用更新 | 有 | 有 | **半** | 有 `self_update` 命令，无制品发布与检查 |
| 指标端点 | 无 | 有 | **有** | — |
| 中英双语 | 有 | 有 | **有** | 有测试保证两个语言包键一致 |
| 多租户与行级隔离 | 无 | 无 | **有** | 我们独有，两边都是单机单用户 |
| 数据库备份与恢复 | 无 | 无 | **有** | 每日转储 + 已演练恢复 |
| PWA / 离线外壳 | 无 | 无 | **有** | — |
| OpenAPI 文档 | 有 | 无 | **有** | OpenAPI 3.1，网关自己在 `GET /v1/openapi.json` 上供（走会话鉴权：它是整个攻击面的地图）。**不是手抄的静态文件** —— 见 [api.md](api.md)：漂移测试断言描述的路由集合 == 实际注册的集合，二进制在供出文档前还会拿活的 mux 复核一遍。路径参数、operationId、命令 kind 枚举、settings 段与通知渠道枚举、以及写路由的 403 都是从代码派生的 |
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
| 867018069514820 | 有 | WEBBING · 8985…4201 | 香港 CSL |
| 867018069509705 | 无 | ISD-R 通道打不开 | 中国移动实体卡 |

### 台上没有任何美国卡

Saily 是 eSIM 供应商，它的美国 profile 要先通过 **SM-DP+ 下载**到 eUICC 上才会存在。

所以 SM-DP+ 下载是 VoWiFi 与 E911 **能被验证的前置条件**，不是可以排在它们之后的
独立项目。原来的顺序（eSIM 在 VoWiFi 之前）是对的，但理由错了 —— 真正的理由不是
"eSIM 功能应该先补齐"，而是"**没有它就没有美国卡可测**"。

阶段 3 因此是关键路径，且**不能只做一半**。

### 每个 eUICC 只有一个 profile

这同时解释了 profile 切换演练为什么一直做不了：禁用唯一的 profile 等于让卡脱网，
且没有回滚路径。下载能力一并解开这个死结 —— **有了第二个 profile 才敢切换**。
