# 边缘端：Leptos + WASM + Thaw UI

## 为什么值得

面板现在用 JS 解析 `/api/status`，**没有任何东西保证它和 Rust 那边的结构体一致**。这个项目已经因为同类问题吃过亏：生成的契约被手工改过、`null` 和"字段省略"的区别没人守。

Leptos 能让面板**直接复用 `vodoge-contract` 的 serde 类型**。上行结构改了字段，前端编译不过。

**已验证**：`cargo build -p vodoge-contract --target wasm32-unknown-unknown` 通过。那个 crate 只依赖 serde + serde_json，没有 I/O，能干净地编到 wasm32。这是整个方案的地基，先验证再动手。

## 现状

```
edge-panel/src/index.html   4030 行，include_str! 进二进制
  内联 CSS                  836 行，183 个自定义类，198 个 CSS 变量
  Alpine.js                 内联
  外部资源                  零
edge-panel/tests/panel.rs   71 个测试函数
```

## 🔴 前置条件（现在不成立）

选定的是**在边缘机上构建**。那台机器的实际情况：

| | |
| --- | --- |
| cargo | `/usr/bin/cargo`，apt 装的 |
| rustup | **没有** |
| 已装 std | 只有 `x86_64-unknown-linux-gnu` |
| wasm32 std | **没有**，apt 源里也没有 |
| DNS | **坏的**（2026-09-01 诊断：域名解析失败，IP 路由正常） |

所以开工前要按顺序做：

1. **修 DNS**。当时的现象是解析失败但默认网关 `192.168.6.254` 通、云端 `43.108.53.126:444` 走 IP 可达（agent 上行因此没断）。那台机器上跑着 clash-verge，值得先看它。
2. **装 rustup**，在 apt 的 Rust 之外。⚠️ 这会给那台机器放第二套工具链，装完要先确认**现有 workspace 仍然能编、47 个测试二进制仍然全绿**，再往下走。
3. `rustup target add wasm32-unknown-unknown`
4. `cargo install trunk` —— trunk 自己要编十来分钟

另外那台机器 2026-09-01 当天多次掉线，其中一次是先 DNS 坏、再整机失联。开长任务前先确认它稳定。

## 阶段

### 阶段 0：脚手架

新 crate `edge-ui`，`crate-type = ["cdylib"]`，依赖 `leptos` + `thaw` + `vodoge-contract`。

trunk 产出 `index.html` + glue `.js` + `.wasm`，由 `edge-panel` 用 `include_str!` / `include_bytes!` 嵌入并提供。

**验收**：浏览器打开新路径，能显示一行从 `/api/status` 拿到并用 `contract` 类型反序列化的文字。

### 阶段 1：新旧并存

🔴 **不做一次性重写。** 老面板留在 `/`，新的挂 `/next`，一个功能一个功能搬。

理由是这个面板的定位是**故障时最后一道可视窗口**。一次性重写会有很长一段时间它比现在难用，而那正是最需要它的时候。

### 阶段 2：按此顺序搬

先搬**读**，后搬**写**——读错了看着不对，写错了会动硬件。

1. 状态页（模组列表、信号、卡、APN 上下文）
2. 候选与纳管 / 取消纳管
3. 日志环
4. 短信收发
5. AT 控制台
6. eSIM
7. USSD
8. 危险区（射频、复位 USB、重启）

### 阶段 3：切换

`/next` 覆盖全部功能之后，交换路径，删掉老的 `index.html` 和它 836 行 CSS。

## 71 个面板测试怎么办

它们读 HTML 源码断言标记：

```rust
panel.wired(In::Tags, "the send path consults the block list", "x-show=\"smsBlock(m.imei)\"")
```

WASM 没有可断言的 HTML 源码，**这批测试会全部失效**。

但它们不是等价物：其中一部分编码的是**真安全属性**，不是装饰。搬迁时必须逐条过一遍，把这类重写成 Leptos 的 Rust 测试，而不是随手丢掉。至少包括：

- 发送路径必须先查 `SMS_BLOCKED`（867018069509705 每发一条丢一次模组）
- 不可撤销的操作必须有确认，并说明后果
- 会让模组离开总线的操作必须先问
- 页面调用的每个端点，daemon 都必须提供

最后一条今天刚红过一次并抓到真问题——我加了两个面板接口却没同步它的清单。

## 风险

**诊断工具自己变得不透明。** 今天 agent 卡死在 `wdm_write` 时，第一步是 `curl` 面板 HTML 再 grep。WASM 之后这条路没有了。搬迁时应当保留一个**纯文本的健康端点**（`/api/status` 已经是），并且不要让它依赖前端。

**体积。** 带组件库的 Leptos CSR 应用 gzip 后通常 300KB–1MB，现在整个面板是一个文件。局域网上不是问题，但二进制会明显变大。

**生态规模。** Thaw UI 在活跃，但社区规模和 shadcn/daisyUI 差着量级，出问题时能搜到的答案少。
