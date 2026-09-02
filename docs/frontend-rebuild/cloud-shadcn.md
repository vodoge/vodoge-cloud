# 云端：接 shadcn/ui

## 进度

| 阶段 | 状态 |
| --- | --- |
| 1 主题层 | ✅ |
| 2 退休设计守卫 | ✅ 部分——见下面「一个必须做的修正」 |
| 3 换组件 | ✅ |
| 4 布局与交互 | 🔄 进行中 |
| 5 压密度 | ✅ |

已部署到线上并验证过：样式表 34,629 字节，主题变量齐全，`animate-in` /
`slide-in-from-bottom` 在产物里。

### 组件

| | 来源 |
| --- | --- |
| Button / Badge / Card / Table | shadcn，加了产品需要的扩展 |
| Input / Textarea / Checkbox | shadcn |
| ConfirmDialog | Radix AlertDialog |
| 溢出导航 | Radix Sheet |
| Skeleton / DropdownMenu / Sonner | 已装，待用 |
| SecretInput | 自动完成（它委托给 Input） |

### 🔴 四处**刻意没有**换成 shadcn

不是没做完，是换过去会做错事。

**Tabs 保留链接式。** shadcn 的是 Radix 客户端状态组件。换过去会把服务端组件
变客户端，并且**丢掉 URL 里的 tab 状态**——设备页读 `?tab=`，为的是让操作员在
命令执行途中刷新页面不丢上下文。

**Select 保留原生 `<select>`。** 换 Radix 要重构 18 处 `<option>` 结构，并且丢掉
手机上的系统选择器。

**Checkbox 保留原生。** Radix 的是按钮，**不随 form 提交**，而那两处都在受控
表单里。

**Output / ButtonRow 保留。** 等宽输出块和按钮布局，shadcn 没有对应物。

原生 `<select>` 和 `<input type=checkbox>` 是浏览器元素，不是「手写的 UI 框架」。

## 一个必须做的修正：安全测试不能跟着设计守卫一起退休

原计划写的是「230 个钉住设计的测试全部退休」。动手时量了一下，`tokens.test.ts`
的 155 个里：

```
设计类 57    安全类 25    其余 73（需逐条看）
```

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
后让测试自己红，红的才动。

已退休的：类名必须住在 `lib/tokens.ts`（3 条）、禁止任意值（1 条，shadcn 用
`[&:has(...)]`）、文件里不许出现裸类名字符串（2 条）。

已更新而不是退休的：危险区按钮色、溢出触发器、手机栏标签裁切、表格列在两端一起
收起、密码表单不在门后。

## 🔴 一条守卫救了三次，不能退休

「每个用到的类必须真的产出 CSS」——它连续抓到三个**静默失效**：

| 类 | 后果 |
| --- | --- |
| `bg-primary/10` | 透明度刻度被替换成四档，颜色悄悄变不透明 |
| `h-9 px-4 gap-2` | 间距刻度只有 s1..s7，组件没有内边距和高度，按钮塌成一条 |
| `focus-visible:ring-1` | 环宽刻度缺 1，**焦点环整体隐形**——无障碍问题 |
| `gap-4 mb-6` | 同上，布局内联时又撞一次 |

Tailwind 对刻度外的值**不报错**，只是不生成规则，类名照样写在 HTML 上。这个
项目原本把这些刻度**替换**（而不是扩展）成很小的几档，接 shadcn 时全部要改成
合并。

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

## 第 4 阶段：布局

组件换完之后量出来的实情：`lib/tokens.ts` 仍有 4049 行，**307 处调用**在用它的
手写配方。换掉的是组件内部，而 `PAGE` / `SHELL` / `FORM` 是**布局**——占比最大
的那块。

这些配方的值本身就是纯 Tailwind 工具类（`"mb-s5 flex flex-wrap gap-s4"`），
所以它们不是另一套 CSS 框架，而是**给工具类组合起的名字**。但那仍然是自己在
决定标题多大、间距多宽。

自定义刻度和原生刻度是**精确的 1:1**，所以转换是机械的：

```
s1 0.25rem→1   s2 0.5rem→2   s3 0.75rem→3   s4 1rem→4
s5 1.5rem→6    s6 2rem→8     s7 3rem→12

text-fg → text-foreground        text-fg-muted → text-muted-foreground
text-bad → text-destructive      text-fg-accent → text-brand
border-line → border-border      text-fg-faint → text-muted-foreground
bg-surface-raised → bg-muted
```

⚠️ **`text-fg-accent → text-brand` 这一条不要无条件套用。** `--brand` 只在暗色
里声明过，亮色主题没有覆盖，所以亮色下它是 #7dd3a0 on #ffffff = **1.80:1**，
而它替换掉的 `--fg-accent` 亮色下是 19.17:1。导航当前项（`SHELL.navLinkCurrent`、
`BOTTOM_NAV.cellCurrent`、`sheetLinkCurrent`）因此走的是 `text-foreground`：
`--fg-accent` 的定义注释本来就写着它等于 `--fg`，这样既保值又保意图。

没有确认等价物的一律**原样保留，不猜**：`bg-surface`、`bg-surface-hover`、
`border-line-strong`、`bg-accent-wash`、`bg-bad-wash`、`from-accent`、
`to-accent-strong`、`text-accent-ink`、`bg-bg`、`accent-accent`、
`focus:border-accent-edge`、`w-rail`、`max-w-page`、`max-h-panel`、
`min-h-touch`、`min-w-touch`、`min-h-dvh`、`rounded-pill`、`tracking-eyebrow`。
`tailwind.config.ts` 的 `colors` 是 `{...TAILWIND_COLORS, ...SHADCN_COLORS}`
合并的，这些名字仍然产出 CSS——它们属于「仍然有效」而不是「已改名」。

### 进度

原计划这一节只跟踪十个配方。**动手时清点发现还有八个同类的没进过这张表**，
所以下面分成两半：上半是原表（已清零），下半是补上的。

| 配方 | 起点 | 现在 |
| --- | --- | --- |
| PAGE | 154 | ✅ 0 |
| TABLE | 56 | ✅ 0 |
| SHELL | 34 | ✅ 0 |
| FORM | 21 | ✅ 0（余 1 处注释引用，见下） |
| CARD | 18 | ✅ 0 |
| BOTTOM_NAV | 11 | ✅ 0 |
| STAT | 6 | ✅ 1（`STAT.tone`，刻意保留，见下） |
| LOG | 3 | ✅ 0 |
| CONFIRM | 2 | ✅ 0 |
| BUTTON | 1 | ✅ 0（那 1 处本来就只是注释） |

**原表之外，同类且未开始的（73 处）：**

| 配方 | 调用点 | 在哪 |
| --- | --- | --- |
| INBOX | 32 | inbox 两页、conversation、send-sms |
| PWA | 12 | connection-status、pwa |
| CENTERED | 8 | login、not-a-tenant、not-found |
| SEGMENTED | 8 | journal、locale-switch |
| JOURNAL | 6 | journal |
| TABS | 4 | ui/tabs |
| BUTTON_ROW | 2 | ui/button-row |
| OUTPUT | 1 | ui/output |

`SAFE_AREA`（7 处）和 `NAV_MORE`（2 处）**不在这份清单里**，而且不该进来：前者
是内联样式（`env(safe-area-inset-*)` 写不成类），后者是导航数据。

### 哪些是刻意留下的

- **`STAT.tone`** —— `{ok, warn, bad}` 到状态色的映射。它不是样式而是语义，
  正好属于下面说的「tokens.ts 删干净之后仍然留下」那一类；而且 `StatTone` 这个
  类型就是 `keyof typeof STAT.tone` 推出来的。
- **`FORM.textarea`** —— 没有调用点了，但 `tokens.test.ts` 有一条守卫断言
  「控制台渲染的每个表单元素都要有配方」，它读的就是 FORM 对象。
- 两处注释引用（`FORM.textarea`、`BUTTON.variant.risk`），说明的正是上面两件事。

全部做完之后 `lib/tokens.ts` 基本可以删掉，只留状态色和 `toneForState` 这类
**真语义**——那些不是样式，是「哪个词算好、哪个算坏」。

🔴 **删它的时候有两件事要一起处理**，否则会互相卡住：一是上面那条读 FORM 对象
的守卫（单删配方它会红）；二是 `lib/tokens.ts` 是 Tailwind 的 **content 文件**，
没人用的配方照样把规则编进出货的样式表（单留着就一直出货死规则）。

### 测试状态

全绿：`npm run typecheck` 通过，`npm test` 349 条全过。

（这一节原本记着「当前红的测试 3 条」——`usbnet switch` / `settings page` /
PWA 截图摘要。前两条已经不红，第三条每次盖章后也是绿的；记录留在这里是因为
**它绿不代表截图是对的**，见下。）

## ⚠️ PWA 安装截图已经过期

组件全换、密度收紧，外观是真的变了。安装弹窗里展示给用户的是一个**已经不存在
的界面**。

拍摄需要浏览器、特定视口和一个已登录的会话。守着这件事的其余守卫已经退休，
**不会再有东西提醒**——`lib/pwa.test.ts` 里 `chrome` 那行上面的注释就是提醒本身。

这一天四次盖章里，**三次是「看得见但拍不了」**（SHELL、BOTTOM_NAV、STAT），
只有 CARD 是逐条核过、确认画面里真的看不见。三笔欠账是叠在一起的。
`lib/pwa.test.ts` 里的注释把这两类分开记着——前者是判断，后者是欠账。

## 🔴 换主题带进来的三个缺陷（配方内联时量出来的，都还没修）

README 里写着「退休 13 条对比度守卫」这个取舍被明确接受过，代价是「配色改错只能
靠肉眼发现」。下面三条就是那个代价，都是在做内联时顺手量出来的，**不属于内联本身
的范围，没有在那几个提交里改**。

**一、`--accent` 在同一个 `:root` 里声明了两次，后一次赢。**
shadcn 块写 `--accent: 240 3.7% 15.9%`（HSL 三元组），旧调色板块在同一个规则里
更靠后的位置写 `--accent: #f5f5f5`（hex）。而 `tailwind.config.ts` 的 `colors`
里 `accent` 走的是 shadcn 的包装 `hsl(var(--accent) / <alpha-value>)`，于是编出
`hsl(#f5f5f5 / 1)` —— 非法，整条声明在计算值阶段作废。

后果：`button.tsx` 的 `outline` 和 `ghost` 变体**没有悬停背景**、
`dropdown-menu.tsx` 四处、`select.tsx` 的选中项高亮全是死的；`SHELL.brandMark`
的渐变 from 停失效，`background-image` 算成 `none`，那个近黑色的「V」落在近黑
背景上——**header 里的品牌角标现在是看不见的**。（对照：`screenshot-wide.png`
里它还有浅色渐变底，说明是接 shadcn 主题时引入的。）

⚠️ 现有那条「每个用到的类必须产出 CSS」的守卫**抓不到这一类**：这些类确实产出了
CSS 规则，坏的是变量的运行时取值。

**二、`text-destructive` 在默认的暗色主题下是 2.08:1。**
`--destructive` 暗色 `0 62.8% 30.6%` = #7f1d1d，那是个**填充色**——shadcn 自己
的组件是 `bg-destructive text-destructive-foreground` 这样成对用的。这个控制台
额外把它当**前景**用了：

```
暗色 #7f1d1d on --bg #010102 ............ 2.08:1
暗色 #7f1d1d on --surface #0d0d0d ....... 1.94:1
亮色 #ef4444 on #ffffff ................. 3.76:1
对照，它替换掉的 --bad：暗色 11.45:1 / 亮色 7.90:1
```

`button.tsx` 的 `risk` 变体首当其冲——它的 docstring 说自己是给「让模组离开总线、
或者不可撤销」的操作用的，而那行字现在在暗色下约 2:1。

**三、`text-brand` 在亮色主题下是 1.80:1。** `--brand: #7dd3a0` 只在暗色声明过，
亮色没有覆盖。已落地的两处是 `rules/page.tsx` 的链接和 `devices/page.tsx` 打开
设备的主链接。详见上面映射表下的那条 ⚠️。

三条同一个根因：**shadcn 的默认主题被整体采纳，但有三个 token 现在被用在它们没
有被调过的角色上**。README 接受的那个取舍是「推导重来」，不是「出货 2:1 的文字」。
修法都在主题层（globals.css / tailwind.config.ts），不在调用点，所以没有夹带进
配方内联的提交里。
