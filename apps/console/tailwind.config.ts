import type { Config } from "tailwindcss";
import {
  TAILWIND_BORDER_RADIUS,
  TAILWIND_BORDER_WIDTH,
  TAILWIND_BOX_SHADOW,
  TAILWIND_COLORS,
  TAILWIND_FLEX,
  TAILWIND_FONT_FAMILY,
  TAILWIND_FONT_SIZE,
  TAILWIND_GRID_TEMPLATE_COLUMNS,
  TAILWIND_INSET,
  TAILWIND_LETTER_SPACING,
  TAILWIND_LINE_HEIGHT,
  TAILWIND_MAX_HEIGHT,
  TAILWIND_MAX_WIDTH,
  TAILWIND_MIN_HEIGHT,
  TAILWIND_OPACITY,
  TAILWIND_RING_OFFSET_WIDTH,
  TAILWIND_RING_WIDTH,
  TAILWIND_SPACING,
  TAILWIND_WIDTH,
  TAILWIND_Z_INDEX,
} from "./lib/tokens.ts";
// 静态导入而不是 require：`tokens.test.ts` 以 ESM 导入这个配置，
// 而 ESM 作用域里没有 require。
import animate from "tailwindcss-animate";

/**
 * The Tailwind theme is generated, not written.
 *
 * Every scale below comes from `lib/tokens.ts`, which is the same table
 * `app/globals.css` declares its custom properties from and the same table the
 * shared components build their class strings from. Writing the values here as
 * well would create a second place for a colour to live, which is how this
 * console arrived at a 1005-line hand-rolled stylesheet in the first place.
 *
 * Two choices worth knowing about before editing:
 *
 * **The scales replace rather than extend.** There is no `bg-red-500` and no
 * `p-4`; spacing is `p-s4`, colours are `bg-surface`. An off-token class
 * therefore produces no CSS at all instead of quietly producing the wrong
 * thing, and `lib/tokens.test.ts` asks the real build about every class the
 * migrated files use, so the silence becomes a failing test.
 *
 * **Replacing five scales was not enough.** Every axis Tailwind ships a default
 * for stays live until it is replaced, and the ones that were left alone were
 * exactly the ones seven page migrations would each have picked their own value
 * from: `max-w-md leading-7 opacity-75 z-50` used to generate real CSS from
 * numbers nobody here had chosen. They are replaced below too, with closed
 * scales in `lib/tokens.ts` holding the values the recipes already used —
 * nothing rendered changed, and the next off-scale class now generates nothing.
 * `lib/tokens.test.ts` asserts these arrive as replacements rather than under
 * `extend`, because putting one under `extend` restores the whole default.
 *
 * **Preflight is off.** The legacy stylesheet in `@layer legacy` still styles
 * bare `button`, `input`, `table` and `label` elements, and preflight is
 * unlayered, so switching it on would outrank all of it. `globals.css` carries
 * the reset instead, and that reset is now all four of preflight's opening
 * declarations rather than `box-sizing` alone — built both ways and compared in
 * a browser, every element computes the same border under it as under the real
 * preflight, which is what makes turning preflight on a no-op for borders on
 * the day the legacy layer is deleted. Turning it on still belongs with that
 * deletion: the rest of preflight is a great deal more than four declarations.
 *
 * There is no `darkMode` either. Colours are custom properties that already
 * flip with `:root[data-theme="light"]`, so a `dark:` variant would be a
 * second, disagreeing switch. `lib/tokens.test.ts` rejects `dark:` in migrated
 * files for that reason.
 */
/**
 * shadcn/ui 要求的颜色名。
 *
 * 组件全部按这套名字取色，所以它们必须在 theme 里存在。写成
 * `hsl(var(--x) / <alpha-value>)` 而不是 `var(--x)`：CSS 变量里存的是不带
 * hsl() 的三个分量，Tailwind 在这里补上函数和 alpha 通道，这就是
 * `bg-background/50`、`border-border/40` 这类透明度语法能工作的原因。
 *
 * 🔴 `accent` 在这里是 shadcn 的含义——**悬停时的表面**，不是品牌强调色。
 * 这个项目原本的品牌色让位改叫 `brand`。任何还写着 `bg-accent` 的旧代码，
 * 现在拿到的是悬停灰；换组件时要逐个改过来。
 */
/**
 * 整条透明度刻度。
 *
 * 🔴 shadcn 的组件用它——`bg-primary/10`、`bg-black/80`、`border-border/40`
 * 都在它生成的代码里。这个项目原本把刻度**替换**成四档（0/50/90/100），而
 * Tailwind 对刻度外的值**不报错，只是静默不生成那条规则**：类名照样写在
 * HTML 上，样式表里没有它，颜色悄悄变成完全不透明。
 *
 * 实测确认过这个行为：同一次构建里 `text-foreground/50` 能编出来，
 * `bg-primary/10` 编不出来，差别只在数字在不在那四档里。
 *
 * 写死而不是从 `tailwindcss/defaultTheme` 导入：那个路径在 Node 的 ESM 加载器
 * 下解析不了，而 `tokens.test.ts` 正是以 ESM 导入这个配置的。
 */
/**
 * Tailwind 的默认间距刻度，写死。
 *
 * 原因和 FULL_OPACITY 一样：`tailwindcss/defaultTheme` 在 Node 的 ESM 加载器下
 * 解析不了，而 tokens.test.ts 以 ESM 导入这个配置。
 *
 * 需要它是因为布局正在从 `PAGE.head` 这种命名配方换成直接写工具类，而写的就是
 * 原生刻度。此前 theme 只有 s1..s7，`gap-4` 根本不会生成——又一次静默失效。
 *
 * 项目原有的 s1..s7 和它精确对齐（0.25/0.5/0.75/1/1.5/2/3rem = 1/2/3/4/6/8/12），
 * 所以两套并存期间不会出现同名不同值。
 */
const FULL_SPACING = {
  "0": "0px", px: "1px", "0.5": "0.125rem", "1": "0.25rem", "1.5": "0.375rem",
  "2": "0.5rem", "2.5": "0.625rem", "3": "0.75rem", "3.5": "0.875rem",
  "4": "1rem", "5": "1.25rem", "6": "1.5rem", "7": "1.75rem", "8": "2rem",
  "9": "2.25rem", "10": "2.5rem", "11": "2.75rem", "12": "3rem", "14": "3.5rem",
  "16": "4rem", "20": "5rem", "24": "6rem", "28": "7rem", "32": "8rem",
  "36": "9rem", "40": "10rem", "44": "11rem", "48": "12rem", "52": "13rem",
  "56": "14rem", "60": "15rem", "64": "16rem", "72": "18rem", "80": "20rem",
  "96": "24rem",
} as const;

const FULL_OPACITY = {
  "0": "0", "5": "0.05", "10": "0.1", "15": "0.15", "20": "0.2", "25": "0.25",
  "30": "0.3", "35": "0.35", "40": "0.4", "45": "0.45", "50": "0.5",
  "55": "0.55", "60": "0.6", "65": "0.65", "70": "0.7", "75": "0.75",
  "80": "0.8", "85": "0.85", "90": "0.9", "95": "0.95", "100": "1",
} as const;

const SHADCN_COLORS = {
  background: "hsl(var(--background) / <alpha-value>)",
  foreground: "hsl(var(--foreground) / <alpha-value>)",
  card: {
    DEFAULT: "hsl(var(--card) / <alpha-value>)",
    foreground: "hsl(var(--card-foreground) / <alpha-value>)",
  },
  popover: {
    DEFAULT: "hsl(var(--popover) / <alpha-value>)",
    foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
  },
  primary: {
    DEFAULT: "hsl(var(--primary) / <alpha-value>)",
    foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
  },
  secondary: {
    DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
    foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
  },
  muted: {
    DEFAULT: "hsl(var(--muted) / <alpha-value>)",
    foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
  },
  accent: {
    DEFAULT: "hsl(var(--accent) / <alpha-value>)",
    foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
  },
  destructive: {
    DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
    foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
  },
  border: "hsl(var(--border) / <alpha-value>)",
  input: "hsl(var(--input) / <alpha-value>)",
  ring: "hsl(var(--ring) / <alpha-value>)",
  /** 这个产品自己的强调色，从 accent 让位之后的名字。 */
  brand: "var(--brand)",
} as const;

export default {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    // The class recipes live here, so this file is content, not config. Named
    // exactly rather than as `./lib/**`, because that glob also swept up
    // `lib/tokens.test.ts` — and a test about arbitrary values has to write
    // `p-[13px]` and `dark:bg-bad` down to reject them, whereupon Tailwind
    // found them and emitted them into the stylesheet the console ships. Dead
    // rules, but dead rules that look exactly like the thing being guarded
    // against, in the artefact an audit would read.
    "./lib/tokens.ts",
  ],
  corePlugins: {
    preflight: false,
  },
  theme: {
    colors: { ...TAILWIND_COLORS, ...SHADCN_COLORS },
    fontFamily: TAILWIND_FONT_FAMILY,
    // 🔴 shadcn 的组件用整条透明度刻度——bg-primary/10、bg-black/80、
    // border-border/40 都在它生成的代码里。这个项目原本把刻度**替换**成了
    // 四档（0/50/90/100），而 Tailwind 对刻度外的值不会报错，只是**静默不
    // 生成那条规则**：类名照样写在 HTML 上，样式表里没有它，颜色悄悄变成
    // 完全不透明。
    //
    // 实测：text-foreground/50 能编出来，bg-primary/10 编不出来——差别只在
    // 数字在不在那四档里。所以这里恢复 Tailwind 的默认刻度，并保留原有的
    // 四档（值相同，是默认刻度的子集）。
    opacity: FULL_OPACITY,
    gridTemplateColumns: TAILWIND_GRID_TEMPLATE_COLUMNS,
    // The six the operator asked for on 2026-08-25. `flex` and `inset` are the
    // two with a trap in them: `flex` is `flex-1` and not the `flex` display
    // utility, and `inset` is read by `top-*` as well as by `inset-*`. Both are
    // in use — `STAT.root`, `SHELL.main`, `TABLE.headerCell`, `SHELL.header` —
    // so both tables keep the entry the recipes need. See lib/tokens.ts.
    flex: TAILWIND_FLEX,
    /* 🔴 从「替换」改成「扩展」，因为 shadcn 的组件用的是 Tailwind 的默认刻度。
     *
     * 这个项目原本在 `theme:` 里替换掉整条 spacing / width / fontSize /
     * borderRadius，只留自己的 `s1..s5`。后果是 shadcn 生成的每一个组件都
     * **没有内边距、没有高度**：`px-2.5` `py-0.5` `h-9` `px-4` `h-8` `w-9`
     * `gap-2` 在这个配置下**一条 CSS 都编不出来**，按钮会塌成一条线。
     *
     * 实测确认过——上面九个类名逐个构建，产出全是 0。
     *
     * 放在 extend 之后两套并存：shadcn 的组件拿到它要的默认值，这个项目原有的
     * `s1..s5`、`text-2xl` 这些也继续有效，调用处一个都不用改。
     */
    extend: {
    ringWidth: TAILWIND_RING_WIDTH,
    ringOffsetWidth: TAILWIND_RING_OFFSET_WIDTH,
    borderWidth: TAILWIND_BORDER_WIDTH,
    minHeight: TAILWIND_MIN_HEIGHT,
    maxHeight: TAILWIND_MAX_HEIGHT,
    inset: TAILWIND_INSET,
    // 🔴 合并而不是替换。原本这里只有 s1..s7，`gap-4` 这类原生刻度**不会生成**
    // ——和透明度、环宽那两次是同一类静默失效：类名照写，样式表里没有。
    // 布局正在从 PAGE.* 这种命名配方换成直接写工具类，写的就是原生刻度。
    spacing: { ...FULL_SPACING, ...TAILWIND_SPACING },
    fontSize: TAILWIND_FONT_SIZE,
    borderRadius: TAILWIND_BORDER_RADIUS,
    maxWidth: TAILWIND_MAX_WIDTH,
    zIndex: TAILWIND_Z_INDEX,
    width: TAILWIND_WIDTH,
    lineHeight: TAILWIND_LINE_HEIGHT,
    letterSpacing: TAILWIND_LETTER_SPACING,
    boxShadow: TAILWIND_BOX_SHADOW,
      // Tailwind's defaults for these point at palette entries that no longer
      // exist (`gray.200`, `blue.500`). They fall back to `currentColor`
      // rather than failing, which would make a bare `border` mean something
      // different from every `border-line` next to it.
      //
      // 🔴 `borderColor.DEFAULT` did nothing at all until the reset in
      // `app/globals.css` started writing it out. It is read by preflight and
      // by nothing else: with preflight off there is no `border-DEFAULT`
      // utility to carry it, so a bare border really did fall to the text
      // colour, exactly what this line says it exists to prevent. The reset
      // states the same value, and `lib/tokens.test.ts` asserts the two agree
      // so switching preflight on cannot recolour anything.
      borderColor: { DEFAULT: "var(--line)" },
      ringColor: { DEFAULT: "var(--accent)" },
      ringOffsetColor: { DEFAULT: "var(--bg)" },
    },
  },
  // shadcn 的组件用 `data-state` 驱动进出场动画，这个插件提供它们要的
  // `animate-in` / `fade-in-0` / `zoom-in-95` 这类工具类。
  plugins: [animate],
} satisfies Config;
