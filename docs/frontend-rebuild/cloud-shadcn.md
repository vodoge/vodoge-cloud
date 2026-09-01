# 云端：接 shadcn/ui

## 现状

控制台**已经是纯 Tailwind 了**，这一点和动手前的印象不同，值得先摆正：

```
app/globals.css      384 行，自定义类 0 个，只有 76 个 CSS 变量
tailwind.config.ts   128 行，全部由 lib/tokens.ts 生成
lib/tokens.ts        4049 行，一张表喂三个消费者
components/ui/*.tsx  10 个自写组件，内部一个类名字面量都没有
```

类配方长这样，是原生工具类：

```
"mb-s5 flex flex-wrap items-start gap-s4"
"text-xl font-semibold tracking-tight text-fg"
```

唯一非 stock 的是刻度命名（`s1..s5`、`fg-muted`、`bad`），那正是 `tailwind.config` 存在的意义。

`globals.css` 的注释里还留着一段历史：这个 app 曾经有 862 行手写样式，已经被移除过一次。所以"模仿别的网站"那段在云端早就清理完了。

**要换掉的不是技术栈，是那 10 个自写组件和它们背后的设计系统。**

## 已装的依赖

```
@radix-ui/react-slot        ^1.3.3
class-variance-authority    ^0.7.1
lucide-react                ^1.38.0
tailwindcss-animate         ^1.0.7
```

`clsx` 和 `tailwind-merge` 本来就有。shadcn CLI 是 4.19.1，Tailwind 3.4.19 在支持范围内。

🔴 **不跑 `shadcn init`。** 它会覆写 `globals.css` 和 `tailwind.config.ts`，而这两个是由 `tokens.ts` 生成、并被测试钉住的。手工写 `components.json`，每一步自己控制。

## 阶段

### 阶段 1：主题层

换成 shadcn 的语义变量命名：

```
--background --foreground --card --card-foreground --popover --popover-foreground
--primary --primary-foreground --secondary --secondary-foreground
--muted --muted-foreground --accent --accent-foreground
--destructive --destructive-foreground --border --input --ring --radius
```

🔴 **`--accent` 是撞车的**：shadcn 用它表示"悬停表面"，我们现在用它表示品牌强调色。两个含义无法共存，现有的 `--accent` 必须改名或让位。这是阶段 1 要解决的第一件事。

`tailwind.config.ts` 从生成改为 shadcn 约定的写法，加上 `tailwindcss-animate` 插件。

**验收**：现有页面还能渲染（会变丑，但不能白屏）。

### 阶段 2：退休设计守卫

删掉 `tokens.test.ts` / `pwa.test.ts` / `contrast.test.ts` / `palette-drift.test.ts`，从 `package.json` 的 test 列表里摘掉。

`lib/tokens.ts` 大幅缩水——类配方跟着组件走进 `.tsx`，只留下真正还有人读的常量。

同时退休 `scripts/check-token-parity.cjs` 和 CI 里的 tokens job。

**验收**：`npm test` 绿，`npm run typecheck` 绿。

⚠️ 这一步之后**没有任何自动检查在守着对比度和色板漂移**。

### 阶段 3：换组件

`components/ui/` 下十个文件逐个换成 shadcn 生成的：

```
badge  button  button-row  card  confirm-dialog  form  output  secret-input  table  tabs
```

其中三个没有直接对应，要想清楚：

- `button-row` —— 布局，shadcn 没有对应组件，用工具类
- `output` —— 等宽的命令输出块，可能仍要一个薄封装
- `secret-input` —— 带遮罩的密钥输入，shadcn 的 `Input` 加状态

**一次换一个，每个换完页面都能跑**。不要十个一起换。

### 阶段 4：布局与交互

页面级重做，用 shadcn 现成的：`Sheet`（移动端导航）、`Dialog`、`DropdownMenu`、`Command`（快捷搜索）、`Sonner`（通知）、`Skeleton`（加载态）。

动画用 `tailwindcss-animate` 和 Radix 自带的 `data-state` 过渡，不手写 keyframes。

### 阶段 5：压密度

shadcn 的默认间距对运维界面偏宽松。**集中改一次**：改掉复制进来的组件的默认 size 变体（`h-9` → `h-8`、`px-4` → `px-3`、表格行 `p-4` → `p-2`），而不是在调用处逐个覆盖。

**验收**：设备页在 1080p 上一屏能看到的模组行数，不少于现在。

## 风险

**PWA 截图会全部过期。** `pwa.test.ts` 里有一个 chrome 摘要机制，安装弹窗那两张截图是对着当前外观拍的。守卫退休之后没人会提醒，但截图仍然是给用户看的，重做完要**手工重拍**——否则安装界面展示的是一个已经不存在的界面。

**`lib/tokens.ts` 有 4049 行，其中相当一部分是解释「为什么是这个值」的推导。** 删掉配方的时候容易连同这些一起删掉。凡是记录了**测量结果或事故**的注释，值得搬进 git 历史之外的地方再删。
