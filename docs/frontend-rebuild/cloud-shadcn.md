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
```

### 进度

- ✅ **PAGE**（154 处）→ 0，`import { PAGE }` 已从 22 个文件清掉
- ⬜ TABLE 56
- ⬜ SHELL 35
- ⬜ FORM 21
- ⬜ CARD 18 / BOTTOM_NAV 11 / STAT 6 / LOG 3 / CONFIRM 2 / BUTTON 1

顺序：TABLE → SHELL → FORM。FORM 放最后，因为换成 shadcn 的 `Form` 那套要动
状态管理（react-hook-form）。

全部做完之后 `lib/tokens.ts` 基本可以删掉，只留状态色和 `toneForState` 这类
**真语义**——那些不是样式，是「哪个词算好、哪个算坏」。

### 当前红的测试（3 条，进行中）

- `usbnet switch` / `settings page` —— 都是「文件里不许出现裸类名」这条断言的
  残余，属于要退休的那类，还没清完
- PWA 截图摘要 —— 见下

## ⚠️ PWA 安装截图已经过期

组件全换、密度收紧，外观是真的变了。安装弹窗里展示给用户的是一个**已经不存在
的界面**。

拍摄需要浏览器、特定视口和一个已登录的会话。守着这件事的其余守卫已经退休，
**不会再有东西提醒**——`lib/pwa.test.ts` 里 `chrome` 那行上面的注释就是提醒本身。
