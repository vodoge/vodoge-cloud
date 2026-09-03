# 边缘端：Leptos + WASM + Thaw UI

> 时效：2026-09-03。**阶段 0～3 全部完成**（vodoge-edge 见下方各阶段小节里
> 记的提交）：十个功能区逐一搬完、`/api/rescan` 补上（阶段 2 清单原先漏列）、
> `/` 与 `/next` 完成交换、旧 `index.html`（4030 行，含 829 行手写 CSS 和
> 8 行 Pico 供应商块）已删除。53 个旧面板测试里 35 条纯读 HTML/JS 源码的
> 已退休，其余全部改写成读 Rust 源码或走 API 的测试；退休前逐条核对过安全
> 属性有没有等价物接住，过程中顺带发现并补上几处真实缺口（重扫 USB 端点
> 从未被调用、接口类型标签、AT+COPS=? 不该被拦、客户端日志留存要长于服务端
> 环）。阶段 3 的版本复核见下方「版本取舍」一节：结论是维持原状。
> 云端那一半已经做完（见 [cloud-shadcn.md](cloud-shadcn.md)）。

## 为什么值得

面板现在用 JS 解析 `/api/status`，**没有任何东西保证它和 Rust 那边的结构体一致**。
这个项目已经因为同类问题吃过亏：生成的契约被手工改过、`null` 和「字段省略」的
区别没人守。

Leptos 能让面板**直接复用 `vodoge-contract` 的 serde 类型**。上行结构改了字段，
前端编译不过。

🔴 **但上面这个理由守错了边界，2026-09-03 更正。**

`edge-panel` **从来就没有依赖过 `vodoge-contract`**（lib.rs 与 Cargo.toml 各 0 处
引用）。`vodoge-contract` 是**边缘↔云端的上行协议**；面板自己的 API 是另一套，
25 个 struct 私有定义在 `edge-panel/src/lib.rs` 里，外面谁也叫不出它们的名字。
复用 contract 类型不会让面板对**自己的** API 漂移有任何抵抗力。

好处是真的，机制换了：新建 `edge-panel-api`（无 I/O，只依赖 serde 和 edge-core），
服务端与 wasm 前端共用同一批类型。**实测**：把 `ModemBody.network` 改名，
两端同时编译不过——

```
前端   error[E0609]: no field `network` on type `ModemBody`
服务端 error[E0560]: struct `ModemBody` has no field named `network`
```

✅ 地基那条命令也真跑过了（装完 rustup + wasm32 target 之后）：
`cargo build -p vodoge-contract --target wasm32-unknown-unknown` 4 秒编完。

## 现状

```
edge-panel/src/index.html   4030 行，include_str! 进二进制
  <style id="vendor-pico">    8 行   Pico CSS v2.0.6，MIT，逐字取自上游 dist
  <style id="panel-style">  829 行   本项目自己的：183 个自定义类，198 个 CSS 变量
  Alpine.js                 内联
  外部资源                  零
edge-panel/tests/panel.rs   53 个 #[tokio::test]
edge-panel/src/**            6 个单元测试（不读 HTML，不受这次搬迁影响）
面板调用的端点              17 个 /api/*
```

⚠️ **「836 行手写 CSS」这个说法要收回**：那个数把内联的 Pico 供应商块算进去了。
自己写的是 829 行，另外那 8 行是压缩过的 Pico v2.0.6。也就是说这个面板**本来就
不是纯手写 CSS**——「不再手写组件」对这一半从一开始就打了折。

## 前置条件

选定的是**在边缘机上构建**。

🔴 **边缘机就是这些仓库所在的这台机器**，不是别的机器：hostname `aabb`，
`192.168.6.83`。文档里凡是写「那台机器」的地方，说的都是本机。

| | 2026-09-03 复核 |
| --- | --- |
| cargo | `/usr/bin/cargo`，发行版装的 |
| rustup | **没有** |
| 已装 std | 只有 `x86_64-unknown-linux-gnu` |
| wasm32 std | **没有**，apt 源里也没有 |
| DNS / 出网 | ✅ **正常**：github.com、crates.io、static.rust-lang.org 均解析，cargo 能直连 crates.io 拉包 |
| workspace | ✅ 编译通过，**39 个测试二进制、657 个测试全过** |

（2026-09-01 曾诊断为「域名解析失败、IP 路由正常」，当时机器上跑着 clash-verge。
现在已经不成立。同一天多次掉线的记录保留在这里作为历史，开长任务前仍值得先确认
它稳定。）

✅ **三步都做完了（2026-09-03）：**

1. rustup 1.29.1（用 `--no-modify-path` 装的，没有改 shell 配置；rustc 1.98.0）。
   按要求复核过：发行版 cargo 下 **39 个测试二进制、657 个测试仍全绿**，第二套
   工具链没有干扰原有的。
2. `wasm32-unknown-unknown` target 已装，地基命令实测通过。
3. trunk 0.21.14。

⚠️ **构建有顺序**：`edge-panel` 用 `include_bytes!` 嵌入 trunk 的产物，所以必须
先 `cd edge-ui && trunk build --release --public-url /next/`，再
`cargo build -p edge-panel`。产物**不进仓库**（README 定的），缺 dist 时 cargo 只
会报 include_bytes! 找不到文件、不会提示你该跑 trunk。

🔴 **版本取舍已拍板：Leptos 钉回 0.7，用 Thaw 稳定版**（leptos 0.7.8 +
leptos_router/meta 0.7.8 + thaw 0.4.8）。代价是具体的、现在就存在的：编译期有一条
`proc-macro-error2 v2.0.1`「包含未来版本 Rust 会拒绝的代码」的警告，追下去来自
`leptos_macro 0.7.9 ← leptos 0.7.8` 自己。现在只是警告。**阶段 3 切换完成时必须
重新评估一次**——届时 Thaw 0.5 可能已转正，升级成本也已知。

**2026-09-03 阶段 3 完成时复核：维持原状，不升级。** 查 crates.io sparse
index（`index.crates.io/th/aw/thaw`、`.../le/pt/leptos`）：

| | 最新稳定 | 最新预发布 |
| --- | --- | --- |
| thaw | 仍是 **0.4.8**，依赖 `leptos ^0.7.7` | 0.5.0-beta，依赖 `leptos ^0.8.0` |
| leptos | 0.8.20（已另有 0.9.0-beta） | 0.9.0-beta |

Thaw 0.5 **还没有转正**——上次评估到现在，它一直停在 beta，Leptos 自己反而
又往前走了一版（0.8.20 稳定、0.9 也进了 beta）。取舍没有变化：稳定的组件库
配旧一版框架，还是比 beta 组件库配新框架划算。`proc-macro-error2` 那条警告
仍然只是警告，没有升级成阻断编译的错误。下一次复核的时机是 Thaw 出到 0.5.0
正式版的那天，不是固定时间。

## 阶段

### ✅ 阶段 0：脚手架（已完成）

`edge-panel-api`（共享类型）+ `edge-ui`（`cdylib` + `rlib`，leptos 0.7.8 +
thaw 0.4.8 + `edge-panel-api`）。trunk 产出由 `edge-panel` 嵌入并在 `/next` 提供。

**两条验收都过了：**

- 正向：浏览器打开 `/next`，显示「本地模式（无上行）」（`PanelMode::Local` 经
  JSON 往返）和两行模组，其中 `UFI103S` 正确显示「回退」。
- 🔴 负向：改一个响应字段名，**两端同时编译不过**。这条比原来写的验收强——
  原文只要求前端编译不过。

**尺寸基线**：wasm 495.0 KB → gzip **180.1 KB**，glue 36.6 KB → gzip 7.0 KB，
合计约 gzip 188 KB。对照现有单文件面板 340.4 KB（未压缩）。比「风险」一节估的
300 KB–1 MB 好，而且框架本身的重量已经付在这个数里了。

顺带把 `edge-panel/examples/serve.rs` 作为开发工具提交——用可信数据把面板渲染
出来看一眼，后面九个功能区每一个都要用到。

### ✅ 阶段 1：新旧并存（已完成）

🔴 **不做一次性重写。** 老面板留在 `/`，新的挂 `/next`，一个功能一个功能搬。

理由是这个面板的定位是**故障时最后一道可视窗口**。一次性重写会有很长一段时间它
比现在难用，而那正是最需要它的时候。

### ✅ 阶段 2：按此顺序搬（已完成，十项全部落地）

先搬**读**，后搬**写**——读错了看着不对，写错了会动硬件。

**只读：**

1. ✅ 状态页（模组列表、卡归属与 ICCID、驻留网络、固件与本机号码、发现/纳管状态徽标）
2. ✅ 体检（只读 AT 批量查询，含信号）
3. ✅ 日志环

**会写：**

4. ✅ 候选与纳管 / 取消纳管
5. ✅ 短信收发（顺带把 SMS_BLOCKED 那张表在服务端也拦下来了，见下）
6. ✅ 网络 / 扫网（全频段扫网，模组停服最长 `SCAN_LIMIT` 秒）
7. ✅ AT 控制台
8. ✅ eSIM
9. ✅ USSD（和 AT 共用同一个控制台）
10. ✅ 危险区（射频、复位 USB）

🔴 **危险区里没有「重启」，搬迁时不要顺手加上。** `/api/restart` 在面板上没有
调用点，而且 `panel.rs` 有一条测试**钉住它不许出现**
（`edge-panel/tests/panel.rs:835`）。它是刻意缺席的。`/next` 版本延续了这条：
`every_endpoint_the_panel_calls_is_registered_on_the_router` 断言了同一件事。

（原先这张表把「APN 上下文」列在状态页——面板里根本没有 APN 这个词；「体检」和
「扫网」两块则完全没进表。）

**这张表本身漏了一项，搬完之后才发现：** `/api/rescan`（顶栏「重扫 USB」）
既不属于上面十项里的任何一项名字，写清单的时候被漏掉了。端点覆盖审计（见下）
扫出这个缺口后当场补上，连同它自己那个 handler 用 `serde_json::json!` 现拼、
`status` 字段没有类型的洞（和 `ClaimReceipt`/`SendReceipt` 同一类问题，这是
第三次遇到）。

**顺带修了一处原版的真实 bug：** 射频开关状态原来是一个**全局**布尔值，不
随选中的模组切换而重置——关掉 A 的射频、切到 B，按钮上还写着「开射频」，那
是关于 B 的谎言。改成按 IMEI 分开记。

### ✅ 阶段 3：切换（已完成）

`/` 现在就是这个 Leptos 面板，`/next` 已经不存在（bundle 文件仍挂在
`/next/edge-ui.js`、`/next/edge-ui_bg.wasm` 下，只是页面路由改了）。老的
`index.html`（4030 行，含 829 行手写 CSS 和 8 行 Pico 供应商块）已删除，
一并带走了它那 16 个和云端不再同名同值的旧 token（`#010102` 画布那些）——
删文件本身就是清理，不需要再单独动一遍。

53 个旧面板测试里，35 条纯粹依赖 HTML/JS 源码扫描，随 index.html 一起退休；
2 条改造成扫编译产物（JS 胶水层文本 + 我们自己的 Rust 源码）而不是扫 HTML；
其余全部是走 `oneshot()` 的纯 API 测试，不依赖页面内容，原样保留。退休前
逐条核对了下面「53 个面板测试怎么办」列的安全属性都有等价物接住——过程中
发现并补上了几处真实缺口：`AT+COPS=?`（扫网的查询形式）没有被显式测试过、
候选列表缺一个「接口类型」标签（重犯原版「serial 没有标签」那类错的可能性）、
客户端日志留存没有对着服务端环的 500 行做显式比较。

## 53 个面板测试怎么办 ——✅ 已处理完

它们读 HTML 源码断言标记：

```rust
panel.wired(In::Tags, "nothing cancels a USSD session", "@click=\"cancelUssd()\"");
```

WASM 没有可断言的 HTML 源码，**这批测试全部失效了**，和预料的一样。

但它们不是等价物：其中一部分编码的是**真安全属性**，不是装饰。搬迁时逐条
过了一遍，这类重写成了 Leptos 的 Rust 测试，没有随手丢掉。下面每一条附上
接住它的地方：

- 发送路径必须先查 `SMS_BLOCKED`（867018069509705 每发一条丢一次模组）——
  ✅ `edge-ui/src/sms.rs` 的 `a_blocked_modem_is_refused_here_too`（浏览器
  端拦截），外加 `edge-panel/tests/panel.rs` 的
  `a_blocked_modem_cannot_be_made_to_send_by_curl`（**服务端也拦下来了**，
  这是搬迁过程中新加的一层——原来这张表只在浏览器里生效，一个 `curl` 能
  绕过去）。
- 不可撤销的操作必须有确认，并说明后果——✅ 分散在 `esim.rs::ask`、
  `scan.rs::ask`、`danger.rs::radio_ask`、`console.rs`/`at_guard.rs` 的
  8 条守卫表里，每一条都有对应的差分或对话框文案测试。
- 会让模组离开总线的操作必须先问——✅ 同上，外加 `at_guard.rs` 里对
  `AT+QCFG="usbnet"`、`AT+CFUN`、eSIM 切换等的专项覆盖。
- 页面调用的每个端点，daemon 都必须提供——✅
  `every_endpoint_the_panel_calls_is_registered_on_the_router`（扫 Rust
  源码里的 `"/api/…` 字符串，取代原来扫 HTML/JS）。
- **面板不许出现 `/api/restart` 的调用点**——✅ 同一条测试里断言了缺席。

倒数第二条曾经红过一次并抓到真问题——加了两个面板接口却没同步它的清单。
`/next` 版本重演过一次同样的价值：写这条测试的过程中真的抓到 `/api/rescan`
被漏搬了。

⚠️ `edge-panel/src/` 里另有单元测试，它们不读 HTML，不在这批里，原样保留。

## 🔴 云端那一半的教训，这一半会原样撞上

云端搬迁里反复出现同一类事故，**五次**：把 markup 从源文件搬进 JS 数据结构之后，
读源码的守卫**一声不响地什么都不测了**——它们一直是绿的，只是在测空气。

这一半的形状一模一样：`panel.rs` 的每一条断言都是「在 HTML 源码里找这个字符串」，
而 Leptos 会把 markup 变成 Rust 宏。**搬迁过程中每退休一条守卫，都要问它守的那个
属性有没有别的东西在守**；一条针对空树也返回真的断言，比没有断言更坏，因为它看
起来是绿的。

云端最后的做法是给这类 sweep 加**非空下限**（`assert.ok(found.length > 0)`）。
这条经验直接可以搬过来。

## 一件已经发生的事：两端视觉已经分家——✅ 阶段 3 删文件时一并解决

`scripts/check-token-parity.cjs`——CI 里比对两端 token 声明的守卫——已于
2026-09-02 在云端仓库（d8dc5e6）**退休并删除**。

后果对这一半曾经是具体的：边缘面板还声明着云端**已经删除**的那 16 个 token，
画布仍是 `#010102`（云端已经搬到 `#09090b`）。面板 CSS 里「和云端 token 块同名
同值」那句注释当时**已经是错的**。阶段 3 删掉整份 `index.html` 时，这 829 行
CSS（连同那 16 个 token 和那句过时的注释）跟着一起没了——不需要再单独清理
一遍，删文件本身就是清理。Leptos 面板这边的视觉是 Thaw 组件库 + 三条改默认值
的规则（表格 `table-layout`、行高、等宽数字），不再有一份手写 token 表要和
云端保持同名同值。

## 风险

**诊断工具自己变得不透明。** agent 卡死在 `wdm_write` 时，第一步是 `curl` 面板
HTML 再 grep。WASM 之后这条路没有了。搬迁时应当保留一个**纯文本的健康端点**
（`/api/status` 已经是），并且不要让它依赖前端。

✅ **阶段 3 完成后确认：`/api/status`、`/api/logs` 等全部 `/api/*` 端点原样
保留，不依赖 `/`（现在的 Leptos 页面）能不能加载。** agent 卡死时 `curl
127.0.0.1:8790/api/status` 这条路径没有变过，只是拿到的不再是能直接读的
HTML 表格，而是 JSON——诊断时需要一次 `| python3 -m json.tool` 或类似的
格式化，不再是纯文本，这是这次取舍里没有事先写下来的一处退步，值得记一笔。

**体积。** 带组件库的 Leptos CSR 应用 gzip 后通常 300KB–1MB，现在整个面板是一个
文件。局域网上不是问题，但二进制会明显变大。

🔴 **生态规模，以及维护节奏——这条比原先记的严重。** 2026-09-03 查 crates.io
sparse index（阶段 3 完成时又复核过一次，见上「版本取舍」一节——结论没变，
Thaw 0.5 到今天还是 beta）：

| | 最新稳定 | 依赖 |
| --- | --- | --- |
| thaw | **0.4.8** | leptos `^0.7.7` |
| thaw | 0.5.0-beta（预发布） | leptos `^0.8.0` |
| leptos | **0.8.20**（另有 0.9.0-beta） | —— |

也就是说：**要么把 Leptos 钉回 0.7 用 Thaw 的稳定版，要么用 Thaw 的 beta 去接
0.8**，而 Leptos 自己已经在往 0.9 走。这不是「社区小、搜不到答案」那种程度的
风险，是**选型当天就要做的一个取舍**。开工前应当先确认 Thaw 的维护状态，或者
评估「Leptos + 自己少量样式」是否比「Leptos + 一个落后一个大版本的组件库」更划算。
