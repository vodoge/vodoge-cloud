# 云端：接 shadcn/ui

> 时效：对到 **1d87b2c**（2026-09-03）。全套 336 条测试全绿，工作树干净。
> 这份文件此前长期落后于代码十二个提交，所以现在每节都带提交号，方便下次核对。

## 进度

| 阶段 | 状态 |
| --- | --- |
| 1 主题层 | ✅ |
| 2 退休设计守卫 | ✅ 部分——见「一个必须做的修正」 |
| 3 换组件 | ✅ |
| 4 布局与交互 | ✅ 配方全部内联并删除（c5855f8 收尾），布局外壳换成 shadcn Sidebar（39d6558） |
| 5 压密度 | ✅ |

已部署到线上并验证过：样式表 **43,261 字节**（`7d09d96e2196fd2f.css`），主题变量
齐全，`animate-in` / `slide-in-from-bottom` / `fade-in` / `zoom-in` 都在产物里。

### 组件

| | 来源 |
| --- | --- |
| Button / Badge / Card / Table | shadcn，加了产品需要的扩展 |
| Input / Textarea / Checkbox | shadcn |
| ConfirmDialog | Radix AlertDialog |
| **Sidebar / Separator / Tooltip** | shadcn（39d6558 从 registry 直取，`use-mobile` hook 随 Sidebar 一起装） |
| 手机导航抽屉 | shadcn Sidebar（它内部用 Radix Sheet） |
| Skeleton | 已有调用点：`components/ui/sidebar.tsx` 的 `SidebarMenuSkeleton` |
| DropdownMenu / Sonner | 已装，待用 |
| SecretInput | 自动完成（它委托给 Input） |

「溢出导航」这个概念随 `nav-more.tsx` 一起删掉了。

### 🔴 四处**刻意没有**换成 shadcn

不是没做完，是换过去会做错事。

**Tabs 保留链接式。** shadcn 的是 Radix 客户端状态组件。换过去会把服务端组件
变客户端，并且**丢掉 URL 里的 tab 状态**——设备页读 `?tab=`，为的是让操作员在
命令执行途中刷新页面不丢上下文。

**Select 保留原生 `<select>`。** 换 Radix 要重构 **18 处 `<Select>` 调用点、共
31 个 `<option>`**，并且丢掉手机上的系统选择器。

**Checkbox 保留原生。** Radix 的是按钮，**不随 form 提交**，而那两处都在受控
表单里。

**Output / ButtonRow 保留。** 等宽输出块和按钮布局，shadcn 没有对应物。

原生 `<select>` 和 `<input type=checkbox>` 是浏览器元素，不是「手写的 UI 框架」。

## 一个必须做的修正：安全测试不能跟着设计守卫一起退休

原计划写的是「230 个钉住设计的测试全部退休」。动手时量了一下，当时
`tokens.test.ts` 的 155 个里：

```
设计类 57    安全类 25    其余 73（需逐条看）
```

⚠️ 这三个数是对 **155 条**时的一次清点。今天 `tokens.test.ts` 是 **125 条**，
所以上面是历史测量，不是现状。

安全类里有这些：

- 危险写操作必须来自确认
- 每个页面的写入都要读角色并 fail closed
- 存过的密钥显示空框而不是标记值
- **改自己的密码不能在写权限门后面**——一个无法应对自己凭据泄露的账号，不会让
  任何人更安全
- 每个 lib 测试文件都必须在 package.json 的手写清单里（专抓永远不会跑的测试）

关键在于**这些测试是靠读源码文本工作的**（`readFileSync` + 字符串匹配），不是
靠渲染组件。所以它们**从来就不需要 `.tsx` 测试运行器**——「不加测试运行器」和
「保住安全测试」并不冲突。

做法因此改成：**纯设计的退休，安全的更新**。判断哪些是设计类不靠猜——改完主题
后让测试自己红，红的才动。最终退休 29 条，201 条仍在跑。

已退休的：类名必须住在 `lib/tokens.ts`（3 条）、禁止任意值（1 条，shadcn 用
`[&:has(...)]`）、文件里不许出现裸类名字符串（2 条）。

已更新而不是退休的：危险区按钮色、表格列在两端一起收起、密码表单不在门后。
（原先这里还列着「溢出触发器」和「手机栏标签裁切」——那两条后来随手机底栏一起
退休，见 39d6558 / e621f53。）

## 🔴 一条守卫救了四次，不能退休

「每个用到的类必须真的产出 CSS」——它连续抓到四个**静默失效**：

| 类 | 后果 |
| --- | --- |
| `bg-primary/10` | 透明度刻度被替换成四档，颜色悄悄变不透明 |
| `h-9 px-4 gap-2` | 间距刻度只有 s1..s7，组件没有内边距和高度，按钮塌成一条 |
| `focus-visible:ring-1` | 环宽刻度缺 1，**焦点环整体隐形**——无障碍问题 |
| `gap-4 mb-6` | 同上，布局内联时又撞一次 |

Tailwind 对刻度外的值**不报错**，只是不生成规则，类名照样写在 HTML 上。这个
项目原本把这些刻度**替换**（而不是扩展）成很小的几档，接 shadcn 时全部要改成
合并。

⚠️ **但它必要而不充分。** 它看不见「同一条规则里一个自定义属性声明了两次」——
那些类确实产出了 CSS，坏的是变量的运行时取值。配套守卫见下面「四个对比度缺陷」。

⚠️ `tailwindcss/defaultTheme` 不能 import：那个路径在 Node 的 ESM 加载器下解析
不了，而 `tokens.test.ts` 以 ESM 导入这份配置。所以默认刻度是**写死**在
`tailwind.config.ts` 里的（`FULL_OPACITY`、`FULL_SPACING`）。

## ⚠️ 装依赖组件不能用 CLI

`npx shadcn add alert-dialog` 会因为它依赖 button 而问「button.tsx 已存在，要
覆盖吗」，`--yes` 答不了这个问题——CLI 先挂住、再以退出码 1 失败。

**覆盖会毁掉 button 里的 `risk` 变体和它 21 处调用。**

绕开办法：单独 `npm install` Radix 依赖，从 registry 直取组件源码：

```
curl -s https://ui.shadcn.com/r/styles/new-york/<name>.json
```

再把 `@/lib/utils` 改成 `@/lib/cn`、`@/registry/new-york/ui/` 改成
`@/components/ui/`。以后给**任何已定制过的组件**装依赖项，都要这么做。

Sidebar（39d6558）就是这么装的。

## 第 4 阶段：布局

### 换掉导航外壳：shadcn Sidebar（39d6558 + e621f53）

组件换完之后量出来的实情：`lib/tokens.ts` 当时仍有 4049 行、**307 处调用**在用
它的手写配方。换掉的是组件内部，而 `PAGE` / `SHELL` / `FORM` 是**布局**——占比
最大的那块。所以布局外壳本身也得换成现成的。

导航从手写的双渲染器换成 shadcn 的 `Sidebar`：

- 原来有**两个** `NAV_GROUPS` 渲染器（`components/sidebar.tsx` 和
  `components/mobile-nav.tsx`），因为手机需要同样十个目的地的另一种排布，并且
  为此专门有一对测试防止两份列表漂移。`Sidebar` 把这件事收成一个：`md` 以上是
  导轨，以下是同一段 markup 被库画进 `Sheet`。**一个渲染器不会和自己不一致**，
  所以那条守卫随第二个渲染器一起退休。
- 🔴 **它仍然是服务端组件，而且这件事是承重的。** `SidebarProvider` 和 `Sidebar`
  自己是 `"use client"`，但下面的内容是**作为 children 传进去的**，于是
  `t(item.key, locale)` 在服务端跑，发出去的 HTML 里就带着操作员的语言。一个
  自己在 hydration 之后解析 locale 的导航，会给每个读者发默认语言的 HTML——
  而读这个页面的检查器一行 JavaScript 都不跑。**这个控制台已经出过两次这个缺陷。**
- 导航数据仍然留在 `lib/tokens.ts` 而不是写成 markup：`.tsx` 在这个 app 里测不
  了，写成 markup 的导航等于没有东西能检查的导航。

⚠️ **放弃手机底栏的代价，记成数字而不是感受**（e621f53）：原来是钉在屏幕底部的
五个 78px 格子，拇指可及，另外五个在溢出抽屉里；`bottomNavCellWidth()` 同时算
390px 宽度预算和 44px 触摸目标两笔账。现在是 header 里的一个触发器加一个抽屉。
**它不是因为做错了才被换掉，是因为它是手写的**；另一面是那条栏加它的边距长期占着
844px 屏幕里的 90px，也就是把手机的 **10.7%** 给了导航而不是数据。

守卫的账：三条改写（渲染器由树派生 / 导航渲染器不许自己写死目的地 / 读同一个数组
且是活读），八条随底栏一起退休，一条下限被**刻意调低**并写明理由。

🔴 **一个测试完全没抓到的缺陷：`list-none`。** shadcn 的 `SidebarMenu` 是个
`<ul>`，它默认 Tailwind 的 preflight 会去掉项目符号——而这个控制台
**`preflight: false`**。结果每个导航项前面都带一个圆点。**是看截图看出来的**，
不是测试。修法是给库组件加一个类：

```tsx
className={cn("flex w-full min-w-0 list-none flex-col gap-1", className)}
```

这是这次迁移里唯一对库组件做的项目侧修改。

### 主题统一：删掉本项目自己的调色板（2fb5dd8 + 9a47170）

分两步：先把页面和组件全部改读 shadcn 的语义色（2fb5dd8，18 个文件、27 行），再把
旧调色板从 `globals.css` 和 `COLOR_TOKENS` 里删掉（9a47170）。

自定义刻度和原生刻度是**精确的 1:1**，所以转换是机械的：

```
s1 0.25rem→1   s2 0.5rem→2   s3 0.75rem→3   s4 1rem→4
s5 1.5rem→6    s6 2rem→8     s7 3rem→12
```

颜色的最终映射（**这张表是历史记录，不是待办**：左列的 token 已经在 9a47170 从
`globals.css` 和 `COLOR_TOKENS` 里删除）：

```
text-fg          → text-foreground        border-line       → border-border
text-fg-muted    → text-muted-foreground  text-fg-faint     → text-muted-foreground
text-bad         → text-destructive       bg-surface-raised → bg-muted
text-fg-accent   → text-primary
```

- `text-fg-accent` 最终落到 `text-primary`，**不是** `text-brand`——`--brand`
  已经删除。（这份文档原先在这里挂着一条「`text-fg-accent → text-brand` 不要无
  条件套用」的警告：`--brand` 曾经只在暗色声明，亮色下 1.80:1。8b94949 把它取成
  无色相值让亮色升到 19.17，9a47170 把它连同旧调色板一起删了。警告本身现在作废。）
- `text-bad → text-destructive` 现在是**同色别名**，因为 8b94949 把 `--destructive`
  指回了 `--bad`。

**画布搬家 #010102 → #09090b，以及它拖着走的东西**（9a47170）：`body` 从
`var(--bg)` 改成 `hsl(var(--background))`；`lib/tokens.ts` 新增
`CANVAS = { dark: "#09090b", light: "#ffffff" }` 作为非 CSS 消费者（图标、
manifest、截图守卫）的单一取值口；两个 SVG 和五个 PNG 按新画布重绘。

🔴 **`CANVAS` 那个常量当天就救了一次。** 我手算 `240 10% 3.9%` 得到 `#0a0a0b`，
真值是 `#09090b`，图标已经用错值生成过一轮——把 `CANVAS` 和 `--background` 钉在
一起的那条守卫当场抓到。

**「原样保留，不猜」的清单已经清空到七个**：`bg-bad-wash`、`max-w-page`、
`max-h-panel`、`min-h-touch`、`min-h-dvh`、`rounded-pill`、`tracking-eyebrow`。
其余十二个在主题统一里全部消失。

⚠️ `TAILWIND_COLORS` 现在只剩 `inherit/current/transparent/white/black` 加状态
四色及其洗色和 `bad-ink`——**颜色那一半不再产出 CSS**。仍然有效的是刻度那一半
（`w-rail`、`max-w-page`、`max-h-panel`、`min-h-touch`、`min-w-touch`、
`min-h-dvh`、`rounded-pill`、`tracking-eyebrow`）。

### 配方内联：进度

原计划这一节只跟踪十个配方。**动手时清点发现还有八个同类的没进过这张表**，另有
`BADGE` 一个因为组件改用 `cva` 而早已是死代码、两张表都没收——十八 + 一 = 十九个，
最后在 9a47170 / e621f53 全部删除。

| 配方 | 起点 | 现在 |
| --- | --- | --- |
| PAGE | 154 | ✅ 0 |
| TABLE | 56 | ✅ 0 |
| SHELL | 34 | ✅ 0 |
| FORM | 21 | ✅ 0 |
| CARD | 18 | ✅ 0 |
| BOTTOM_NAV | 11 | ✅ 0（连同底栏一起删） |
| STAT | 6 | ✅ 1（`STAT.tone`，刻意保留，见下） |
| LOG | 3 | ✅ 0 |
| CONFIRM | 2 | ✅ 0 |
| BUTTON | 1 | ✅ 0 |

**原表之外，同类的八个（起点共 73 处），也已清零**（59e0e7a → c5855f8）：

| 配方 | 起点 | 现在 |
| --- | --- | --- |
| INBOX | 32 | ✅ 0 |
| PWA | 12 | ✅ 0 |
| CENTERED | 8 | ✅ 0 |
| SEGMENTED | 8 | ✅ 0 |
| JOURNAL | 6 | ✅ 0 |
| TABS | 4 | ✅ 0 |
| BUTTON_ROW | 2 | ✅ 0 |
| OUTPUT | 1 | ✅ 0 |

`SAFE_AREA`（3 处：`layout.tsx`、`shell.tsx`、`connection-status.tsx`）**不在
这份清单里**，而且不该进来：它是内联样式，`env(safe-area-inset-*)` 写不成类。
`NAV_MORE` 已随手机底栏在 e621f53 删除。

🔴 **删掉配方之前做过一次全量等价核对：133/133。** 配方对象一旦删除就无法回头
比对，所以在删之前，机械地把每一处已内联的字面量和它在内联前那个提交上的配方值
逐条比对——133 处全部相等，唯一一处不等有一个后来的刻意改动可以解释。

理由是量出来的：一次对抗性核查证明，当时的测试套件里**没有任何东西**在验证内联
后的字面量和配方一致——注入六个错误，五个 350/350 全绿通过。

### 哪些是刻意留下的

- **`STAT.tone`** —— `{ok, warn, bad}` 到状态色的映射。它不是样式而是语义；
  `StatTone` 这个类型就是 `keyof typeof STAT.tone` 推出来的。**这是生产代码里
  唯一还在读配方的地方**（`components/ui/card.tsx:240`）。

`lib/tokens.ts` 因此从 **4049 行降到 2572 行**。十七个配方对象连同
`buttonClass` / `badgeClass` / `tableCellClass` 在 9a47170 删除，`BOTTOM_NAV` 与
`NAV_MORE` 在 e621f53 删除。剩下的 2572 行不是样式配方，是 Tailwind 刻度表、导航
数据、命令守卫和设置字段表。

✅ 原先预告「删它的时候有两件事要一起处理，否则会互相卡住」——都已兑现：一是读
`FORM` 对象的那条守卫（e621f53 第一次付这笔账），二是 `lib/tokens.ts` 是 Tailwind
的 **content 文件**，没人用的配方照样把死规则编进出货的样式表（9a47170 把配方和
守卫同时删）。

🔴 **守卫的取值口跟着改了**（9a47170）。一大族 sweep 原本读配方对象，配方删掉
之后它们会**静悄悄地什么都不测**——这是这个仓库反复出现的同一类事故（把 markup
搬进 JS 数据结构，读源码的守卫就此变瞎，却一直是绿的）。所以：`everyClassList()`
改成「配方 ∪ 已迁移的源文件」，`paintedAsType()` 改成读 `.tsx`，z-index 角落那条
改成读源码（它自 BOTTOM_NAV 提交起已经死了一段时间）。

🔴 遗留：`components/ui/form.tsx:26` 还有一句注释说 `FORM.textarea`
「still has to exist」，以及另外两处指向已删除对象的注释引用
（`BUTTON.variant.risk`、`TABLE.cell`）——**还没改**。

### 测试状态

全绿：`npm run typecheck` 通过，`npm test` **336 条**全过。

## ✅ PWA 安装截图已重拍（9a47170）

组件全换、密度收紧、主题搬家，外观真的变了，而安装弹窗里展示给用户的曾经是一个
**已经不存在的界面**。欠账累了五笔之后真的重拍了，两张帧都是从跑起来的构建里截的。

**怎么拍**：`scripts/screenshots/capture.mjs` + `scripts/screenshots/stub-gateway.mjs`
（f639045 收进仓库）。完整步骤写在 `capture.mjs` 的文件头，要点：

- 需要一个**桩网关兼反向代理**。租户不是从 host 解析的，是网关注入的四个请求头，
  会话是 `vodoge_session` cookie——直连 `next start` 只会拿到登录页。
- `--disable-lcd-text`：Chromium 默认次像素抗锯齿会产生守卫的灰度混合模型解释不
  了的颜色。**第一次拍完就是被守卫打回来的；修的是拍摄方式，不是守卫的容差。**
- `clip` 必须从 `y=0` 开始，尺寸从 `lib/pwa.ts` 的 manifest 读，不写死。

守卫钉着这件事：`the screenshot recipe is a tool` 那条把「怎么拍」和真实工具绑在
一起，两个方向都验证过会在改动下变红。

⚠️ **`capture.mjs` 曾经跑不起来。** 它 `import "playwright"`，而 `package.json` 里
没有任何地方声明这个依赖——新克隆的仓库照文档做会失败。1d87b2c 补进
devDependencies。一个「照着做就能重拍」的说明，本身也得能跑。

### 🔴 重盖闸门：样式表一样，不代表画面没动（1d87b2c）

从 `sn/ui-completion`（SN-T037，4724359）捞回来的，那个分支从没进过 main。

`chromeDigest` 哈希的是源码**原始字节**，所以连改注释都会红，于是配套的出路是
「重建一次，样式表逐字节相同就可以只重盖摘要」。**那个论证有洞**：一个已经在样式表
里的工具类被新用到另一个元素上——CSS 一字不变，被拍下来的版面变了。

`sourceRecipeDigest` 把 TypeScript 的扫描器**只当词法器用**（不 import 也不运行
应用），逐 token 求摘要，唯独注释内容折叠成固定标记。于是：

| 改动 | 样式表 | `recipe` | 出路 |
| --- | --- | --- | --- |
| 只改注释措辞 | 相同 | 不变 | ✅ 可以只重盖 `chrome` |
| 动了 markup / 类名 / 布局代码 | **可能仍相同** | 变 | 🔴 只能重拍 |

**两个方向都端到端实测过**，不是靠论证：把 `app/page.tsx` 的 `gap-6` 改成
`gap-4`（两个类在别处都还在用，所以规则都还在），删掉 `.next` 全新构建，样式表
**43,261 字节、sha `dcd253a9…` 逐字节相同**——旧办法会放行这个真实的版面改动，而
`recipe` 当场变红。

闸门问在 `chrome` 之前，因为版面一旦动过，「重盖」这条路就是关着的，先读到它只会
把人带上一条死路。

⚠️ **两个容易误解的性质**（都是实测出来的，其中一个纠正了我自己写错的断言）：

- 对注释的**措辞**免疫，对注释的**存在与否**不免疫。JSX 里
  `<main>a {/* c */} b</main>` 的注释在一个表达式容器里，两侧空白是各自独立的文本
  节点，删掉它两段文本会合并，渲染出的空白可能改变。
- **空白也算**。跑一次格式化工具就会强制重拍。同样是因为 JSX 里的文本空白会被渲染。

📷 帧因此**真重拍了一次**（不是盖章了事）：自上次拍摄以来闭包里 `lib/tokens.ts` 有
真代码改动（13 个文件名进 `MIGRATED_SOURCES`），虽然那是测试输入数据、不影响渲染，
但这正是本闸门禁止「靠论证蒙混」的情形。这也是第一次重拍出来的 PNG **不是**逐字节
相同的：手机帧 0.607%、桌面帧 0.845%。量过分布才下的结论——差异散在 346/1688 和
141/800 行里、每行最多 169 像素，是文字抗锯齿的形状；版面真移动会出现连续成片、
接近整行宽的差异带并让包围盒位移。

⚠️ 摘要守卫（Guard A）一直都在，而且**正是它逼出了这次重拍**。退休的是 Guard B
那一族「画面里必须有什么」的断言——因为底栏和导轨的配方没有了。

## ✅ 换主题带进来的四个对比度缺陷（8b94949 已全部修掉）

它们能溜进来，是因为 `contrast.test.ts` 的取值口是 `COLOR_TOKENS`，而 shadcn 的
语义色直接写在 `globals.css` 里、从来没进过那张表——**守卫活着，但看不见半套调色
板**。（README 原先把这写成「13 条守卫已退休」，那是错的，见 README 的更正。）

**一、`--accent` 在同一个 `:root` 里声明了两次，后一次赢。** shadcn 块写
`--accent: 240 3.7% 15.9%`（HSL 三元组），旧调色板块在同一规则里更靠后处写
`--accent: #f5f5f5`（hex），于是 Tailwind 编出 `hsl(#f5f5f5 / 1)`——非法，整条
声明在计算值阶段作废。后果：`button.tsx` 的 `outline` / `ghost` 变体没有悬停
背景，`dropdown-menu.tsx` 四处、`select.tsx` 的选中项高亮全是死的，header 里的
品牌角标看不见。

✅ 已修：旧 accent 家族改名到 `--brand-*`（9a47170 删除），`--accent` 现在每个
主题块只声明一次。新守卫 `lib/contrast.test.ts:401`「同一条规则里一个自定义属性
只能声明一次」盯着这件事。品牌角标已经移进侧栏头部
（`components/sidebar.tsx:61-66`），用的是实心 `bg-primary` / `text-primary-foreground`，
没有渐变。

**二、`text-destructive` 暗色 2.08:1。** `--destructive` 暗色 `0 62.8% 30.6%`
= #7f1d1d，那是个**填充色**——shadcn 自己成对用 `bg-destructive
text-destructive-foreground`，而这个控制台额外把它当**前景**用了。

✅ 已修：`--destructive` 现在指回 `--bad`，`--destructive-foreground` 指回
`--bad-ink`，所以红字和红徽章在同一张表里是同一个红。

**三、`text-brand` 亮色 1.80:1。** `--brand: #7dd3a0` 只在暗色声明过。
✅ 已修：先取无色相值（1.80 → 19.17），再随旧调色板删除；两处链接现在是
`text-primary underline`。

**四、`--muted-foreground` 亮色在抬起表面上 3.91–4.40。** 这一条就是映射表里
`text-fg-muted` / `text-fg-faint` 合并到同一个 token 之后暴露出来的。
✅ 已修。

**修完之后现量的值**（`lib/palette-source.ts` 解析 `globals.css` 算出来）：

| | 暗色 | 亮色 |
| --- | --- | --- |
| 背景 | #09090b | #ffffff |
| `--foreground` | 19.06:1 | 19.90:1 |
| `--muted-foreground` | 8.27:1 | 8.72:1 |
| `--destructive` | **10.92:1**（原 2.08） | **7.90:1**（原 3.76） |
| `--primary` | 19.06:1 | 17.72:1 |

守卫的取值口也一并改了：对比度 sweep 现在解析 `globals.css` 里**真正生效**的值
（后声明的胜，和浏览器一致），解析器抽成 `lib/palette-source.ts`，只此一份。


## 🔴 查过并决定不做：shadcn / TanStack data-table

**shadcn 没有 data-table 组件。** registry 里 `table.json` 返回 200，
`data-table.json` 返回 **404**，每一个 `data-table-*` 子件也都 404。官方文档自己
的说法是：他们提供的不是组件，而是「教你自己搭一个」的指南。所以「引入现成的
data-table」这件事**在事实层面不存在**——实际要做的是装
`@tanstack/react-table`，再自己写 `columns.tsx` / `data-table.tsx`，那和这次重建
的前提正好相反。

另外两条理由：

- **要买的功能已经有了，而且实现得更好。** `app/devices/page.tsx` 是服务端组件，
  `?q=` 和 `?sort=` 写在 URL 里：不跑 JavaScript、链接可分享、和角色门天然兼容。
  换成 TanStack 是把它降级成客户端状态。
- **代价是 13 张表、约 91 条断言，而且会造出第七次「绿着但什么都没测」。** 23 张
  `<Table>` 里有 **7 张的最后一列是角色门控的危险写操作**（代理重启、移除卡策略、
  eSIM 切换），那些单元格正是按 markup 位置计数的 `writable` 守卫的对象。把控件
  挪进 column def 的 `cell` 函数，守卫会全绿地失明。另有 10 张是 `<SpecTable>`，
  根本没有表头，没有列可排。

### 改做的事：把服务端排序筛选铺开（686299d）

七张列表表补上了 `?q=` / `?sort=`：sessions、audit、schedule、support-ledger、
proxy 流量表、inbox 线程表、设备详情的模组表。页面仍是服务端组件，没加依赖，
那 7 张危险写表一张没动，一条守卫也没失明。

新增 `lib/table-query.ts`——**是 `.ts` 不是 `.tsx`，因为这个 app 测不了 `.tsx`**，
而容易悄悄写错的正是它管的那几件事：

| | 它拦住的东西 |
| --- | --- |
| `pickSort` | 返回值既进比较器又回填 `defaultValue`，不校验就同时是正确性 bug 和反射输入 |
| `biggestFirst` | **缺值排最后，不是当 0**——没测到信号的模组不是全队最差的模组 |
| `by(...)` | **全序**。最后一项必须是唯一键，否则打平的行由网关序列化顺序决定，列表在两次轮询之间重排 |
| `emptyKind` | 分开「本来就没有」和「被筛没了」 |

🔴 最后一条是把 `app/audit/page.tsx` 那个缺陷挡在门外：网关返回了事件、解析器全
丢了、什么都没抛，「暂无记录」被画在一份满的审计日志上。那一页当初靠「行与占位符
互斥构造」修好，**加一个筛选就会把洞重新打开**。

几处刻意的判断，写下来免得将来被当成疏漏：

- **审计页默认保持到达顺序。** `AuditRow` 只有 `{actor, action, target}`,没有时间
  戳,到达顺序是这一页唯一的时间信号。默认按 actor 排等于悄悄打乱一份日志。
- **inbox 只筛展示列表**,不筛未读总数和联系人表——筛一下未读总数就跟着变,那是在
  回答没人问过的问题。
- **设备详情页的表单带一个隐藏的 `tab`。** GET 表单会重写整个查询串,不带上就会把
  操作员踢回第一个标签页,正是链接式 Tabs 存在的理由。

⚠️ 顺带修的守卫：「每个元素都要有自己的类」对 `<input type="hidden">` 不适用——
那个规则的前提是「外观由两处决定」,而隐藏输入按规范根本不渲染。narrowly 排除,
并写明理由;给它加一个无意义的类只会满足字面而不是意图。
