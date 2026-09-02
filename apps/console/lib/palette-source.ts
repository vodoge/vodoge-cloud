import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `app/globals.css` 读成一张表，给测试用。
 *
 * 🔴 **为什么存在：这个控制台的调色板真源是 CSS，不再是 TypeScript。**
 *
 * 从前 `COLOR_TOKENS` 是真源，`app/globals.css` 从它生成，所以测试 import 那张表
 * 就等于读到了真值。采用 shadcn 的主题之后不是这样了：shadcn 的语义色直接写在
 * globals.css 里，`COLOR_TOKENS` 缩到只剩状态四色和它们的洗色——那是这个产品自己
 * 的语义（「哪个词算好、哪个算坏」），shadcn 没有对应物。
 *
 * 于是每个想问「`--background` 到底是什么颜色」的测试都得去解析 CSS。三个测试
 * 文件各抄一份解析和 HSL→十六进制的转换，就是三份会各自长歪的实现——这个仓库
 * 已经因为同一类重复吃过亏（`app.messages` 曾经有两个写入者并行跑了很久）。所以
 * 解析只此一份。
 *
 * ⚠️ **这个模块只给测试用，不要从组件里 import**：它读文件系统，进不了客户端
 * 包。它也刻意不在 `tailwind.config.ts` 的 `content` 里，所以写在这里的类名不会
 * 泄进出货的样式表。
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const GLOBALS: string = readFileSync(join(root, "app/globals.css"), "utf8");

/** 一条规则的正文，按顶层大括号配平取出来。 */
function ruleBody(selector: string): string {
  const at = GLOBALS.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`app/globals.css no longer has a ${selector} block`);
  const open = GLOBALS.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < GLOBALS.length; i += 1) {
    if (GLOBALS[i] === "{") depth += 1;
    else if (GLOBALS[i] === "}") {
      depth -= 1;
      if (depth === 0) return GLOBALS.slice(open + 1, i);
    }
  }
  throw new Error(`${selector} is unterminated`);
}

/**
 * 一个主题里每个自定义属性**真正生效**的值。
 *
 * 🔴 后声明的胜，和浏览器一样。不要改成 first-wins：`--accent` 曾经在同一条规则
 * 里被声明两次，而正是「后者胜」把一个 HSL 三元组换成了十六进制，让
 * `hsl(var(--accent) / 1)` 变成非法值、下拉菜单和按钮的悬停背景全部消失。
 * `lib/contrast.test.ts` 有一条守卫现在拦着这种事，但这里的语义必须和浏览器一致，
 * 否则守卫和被守的东西会对不上。
 */
export function declarationsIn(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of ruleBody(selector).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1], match[2].trim());
  }
  return found;
}

/** 暗色是 `:root`；亮色继承暗色里没被覆盖的那些。 */
export function themeTokens(theme: "dark" | "light"): Map<string, string> {
  const dark = declarationsIn(":root");
  if (theme === "dark") return dark;
  const light = new Map(dark);
  for (const [name, value] of declarationsIn(':root[data-theme="light"]')) light.set(name, value);
  return light;
}

/**
 * shadcn 的三元组 `H S% L%` 转成十六进制；不是三元组就返回 null。
 *
 * Tailwind 把这些名字包成 `hsl(var(--x) / <alpha-value>)`，所以它们**必须**是
 * 三元组——一个十六进制值会让整条声明在计算值阶段作废。这个函数返回 null 正是
 * 「这个 token 不是 shadcn 那一套」的判据，调用方据此跳过。
 */
export function hslTripletToHex(triplet: string): string | null {
  const parsed = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(triplet.trim());
  if (!parsed) return null;
  const hue = Number(parsed[1]);
  const saturation = Number(parsed[2]) / 100;
  const lightness = Number(parsed[3]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = lightness - chroma / 2;
  const [r, g, b] = (
    [
      [chroma, second, 0],
      [second, chroma, 0],
      [0, chroma, second],
      [0, second, chroma],
      [second, 0, chroma],
      [chroma, 0, second],
    ] as const
  )[Math.floor(hue / 60) % 6];
  const byte = (channel: number) =>
    Math.round((channel + base) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * 一个 shadcn 语义色在某个主题下的十六进制值,直接从 globals.css 读。
 *
 * 名字不带 `--`：`shadcnHex("background", "dark")`。
 */
export function shadcnHex(name: string, theme: "dark" | "light"): string {
  const value = themeTokens(theme).get(`--${name}`);
  if (value === undefined) throw new Error(`app/globals.css declares no --${name}`);
  const hex = hslTripletToHex(value);
  if (hex === null) {
    throw new Error(`--${name} is ${value}, which is not an HSL triplet — Tailwind wraps it in hsl()`);
  }
  return hex;
}
