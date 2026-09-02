# 边缘端：Leptos + WASM + Thaw UI

> 时效：2026-09-03 在边缘机本机复核过一遍。**未开工。**
> 云端那一半已经做完（见 [cloud-shadcn.md](cloud-shadcn.md)），所以
> [README.md](README.md) 定的「云端先做，边缘端后做」现在轮到这一半了。

## 为什么值得

面板现在用 JS 解析 `/api/status`，**没有任何东西保证它和 Rust 那边的结构体一致**。
这个项目已经因为同类问题吃过亏：生成的契约被手工改过、`null` 和「字段省略」的
区别没人守。

Leptos 能让面板**直接复用 `vodoge-contract` 的 serde 类型**。上行结构改了字段，
前端编译不过。

⚠️ **地基还没实测。** 这份文档原先写着
`cargo build -p vodoge-contract --target wasm32-unknown-unknown` 「已验证」通过。
诚实的版本是：**这台机器上没有 wasm32 std，这条命令现在跑不了**。可说的只是——
那个 crate 只依赖 serde + serde_json、没有 I/O，理论上能干净地编到 wasm32。
装完 rustup 和 target 之后**第一件事就是真跑一次这条命令**，那才是地基。

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

所以开工前只剩三步：

1. **装 rustup**，在发行版的 Rust 之外。⚠️ 这会给这台机器放第二套工具链，装完
   要先确认**现有 workspace 仍然能编、39 个测试二进制（657 个测试）仍然全绿**，
   再往下走。
2. `rustup target add wasm32-unknown-unknown`，然后立刻实测上面那条
   `cargo build -p vodoge-contract --target wasm32-unknown-unknown`。
3. `cargo install trunk` —— trunk 自己要编十来分钟。

## 阶段

### 阶段 0：脚手架

新 crate `edge-ui`，`crate-type = ["cdylib"]`，依赖 `leptos` + `thaw` +
`vodoge-contract`。

trunk 产出 `index.html` + glue `.js` + `.wasm`，由 `edge-panel` 用 `include_str!` /
`include_bytes!` 嵌入并提供。

**验收**：浏览器打开新路径，能显示一行从 `/api/status` 拿到并用 `contract` 类型
反序列化的文字。

### 阶段 1：新旧并存

🔴 **不做一次性重写。** 老面板留在 `/`，新的挂 `/next`，一个功能一个功能搬。

理由是这个面板的定位是**故障时最后一道可视窗口**。一次性重写会有很长一段时间它
比现在难用，而那正是最需要它的时候。

### 阶段 2：按此顺序搬

先搬**读**，后搬**写**——读错了看着不对，写错了会动硬件。

**只读：**

1. 状态页（模组列表、卡归属与 ICCID、驻留网络、固件与本机号码、发现/纳管状态徽标）
2. 体检（只读 AT 批量查询，含信号）
3. 日志环

**会写：**

4. 候选与纳管 / 取消纳管
5. 短信收发
6. 网络 / 扫网（全频段扫网，模组停服最长 `SCAN_LIMIT` 秒）
7. AT 控制台
8. eSIM
9. USSD
10. 危险区（射频、复位 USB）

🔴 **危险区里没有「重启」，搬迁时不要顺手加上。** `/api/restart` 在面板上没有
调用点，而且 `panel.rs` 有一条测试**钉住它不许出现**
（`edge-panel/tests/panel.rs:835`）。它是刻意缺席的。

（原先这张表把「APN 上下文」列在状态页——面板里根本没有 APN 这个词；「体检」和
「扫网」两块则完全没进表。）

### 阶段 3：切换

`/next` 覆盖全部功能之后，交换路径，删掉老的 `index.html` 和它 829 行 CSS
（连同那 8 行 Pico 供应商块）。

## 53 个面板测试怎么办

它们读 HTML 源码断言标记：

```rust
panel.wired(In::Tags, "nothing cancels a USSD session", "@click=\"cancelUssd()\"");
```

WASM 没有可断言的 HTML 源码，**这批测试会全部失效**。

但它们不是等价物：其中一部分编码的是**真安全属性**，不是装饰。搬迁时必须逐条
过一遍，把这类重写成 Leptos 的 Rust 测试，而不是随手丢掉。至少包括：

- 发送路径必须先查 `SMS_BLOCKED`（867018069509705 每发一条丢一次模组）
- 不可撤销的操作必须有确认，并说明后果
- 会让模组离开总线的操作必须先问
- 页面调用的每个端点，daemon 都必须提供
- **面板不许出现 `/api/restart` 的调用点**（`panel.rs:835`，见上）

倒数第二条曾经红过一次并抓到真问题——加了两个面板接口却没同步它的清单。

⚠️ `edge-panel/src/` 里另有 6 个单元测试，它们不读 HTML，不在这批里。

## 🔴 云端那一半的教训，这一半会原样撞上

云端搬迁里反复出现同一类事故，**五次**：把 markup 从源文件搬进 JS 数据结构之后，
读源码的守卫**一声不响地什么都不测了**——它们一直是绿的，只是在测空气。

这一半的形状一模一样：`panel.rs` 的每一条断言都是「在 HTML 源码里找这个字符串」，
而 Leptos 会把 markup 变成 Rust 宏。**搬迁过程中每退休一条守卫，都要问它守的那个
属性有没有别的东西在守**；一条针对空树也返回真的断言，比没有断言更坏，因为它看
起来是绿的。

云端最后的做法是给这类 sweep 加**非空下限**（`assert.ok(found.length > 0)`）。
这条经验直接可以搬过来。

## 一件已经发生的事：两端视觉已经分家

`scripts/check-token-parity.cjs`——CI 里比对两端 token 声明的守卫——已于
2026-09-02 在云端仓库（d8dc5e6）**退休并删除**。

后果对这一半是具体的：边缘面板现在仍然声明着云端**已经删除**的那 16 个 token，
画布仍是 `#010102`（云端已经搬到 `#09090b`）。面板 CSS 里「和云端 token 块同名
同值」那句注释**现在是错的**，搬迁时应当一并清理。

## 风险

**诊断工具自己变得不透明。** agent 卡死在 `wdm_write` 时，第一步是 `curl` 面板
HTML 再 grep。WASM 之后这条路没有了。搬迁时应当保留一个**纯文本的健康端点**
（`/api/status` 已经是），并且不要让它依赖前端。

**体积。** 带组件库的 Leptos CSR 应用 gzip 后通常 300KB–1MB，现在整个面板是一个
文件。局域网上不是问题，但二进制会明显变大。

🔴 **生态规模，以及维护节奏——这条比原先记的严重。** 2026-09-03 查 crates.io
sparse index：

| | 最新稳定 | 依赖 |
| --- | --- | --- |
| thaw | **0.4.8** | leptos `^0.7.7` |
| thaw | 0.5.0-beta（预发布） | leptos `^0.8.0` |
| leptos | **0.8.20**（另有 0.9.0-beta） | —— |

也就是说：**要么把 Leptos 钉回 0.7 用 Thaw 的稳定版，要么用 Thaw 的 beta 去接
0.8**，而 Leptos 自己已经在往 0.9 走。这不是「社区小、搜不到答案」那种程度的
风险，是**选型当天就要做的一个取舍**。开工前应当先确认 Thaw 的维护状态，或者
评估「Leptos + 自己少量样式」是否比「Leptos + 一个落后一个大版本的组件库」更划算。
