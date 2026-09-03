/**
 * The console's design system, as data.
 *
 * Everything visual in this app is supposed to come from here: the CSS custom
 * properties in `app/globals.css`, the Tailwind theme in `tailwind.config.ts`,
 * and the class recipes the shared components render with. One table, three
 * consumers, so a colour cannot be one value in the stylesheet and another in
 * a component.
 *
 * Why the recipes live in a `.ts` file rather than beside the components:
 * `apps/console` has no way to run a `.tsx` file in a test — there is no jsdom,
 * no testing-library, no vitest, no jest — and `package.json`'s test script is
 * a hand-written list of files, so a test that is not on that list never runs
 * and the pass count never moves. A class string kept here is data that
 * `tokens.test.ts` can import and check against the real Tailwind build. The
 * same string kept inside a `.tsx` is unreachable. That is the whole reason
 * for the split, and it is why `components/ui/*.tsx` hold no class literals.
 *
 * ⚠️ **This file used to say that renaming a token here changed another
 * repository too.** That was true while the edge panel (a single
 * self-contained HTML file in a different repo, no build step, no npm) copied
 * these names and values by hand, and `scripts/check-token-parity.cjs` held
 * the two in step in CI.
 *
 * That guard was retired and deleted on 2026-09-02, because each surface is
 * being rebuilt on its own framework — this console on shadcn/ui, the panel on
 * Leptos + Thaw. **The two visual languages have already diverged**: this
 * console's canvas is `#09090b`, the panel's is still `#010102`, and the panel
 * still declares sixteen tokens that no longer exist here. Renaming a token
 * here is now a local change. See `docs/frontend-rebuild/README.md`.
 */

/* ── Tokens ──────────────────────────────────────────────────────────────
 *
 * Split by whether the theme changes them, because that is exactly the split
 * `globals.css` has to make: `:root` carries everything, and
 * `:root[data-theme="light"]` re-declares only what differs.
 */

export type ThemeName = "dark" | "light";
export type ThemedValue = { readonly dark: string; readonly light: string };

/**
 * Dark first, because this is a monitoring console: it is looked at for long
 * stretches, often beside a terminal. Light is a real theme rather than an
 * inversion — its greys are warmer so text does not glare.
 */
/**
 * 画布色的十六进制写法，给读不到 CSS 变量的地方用。
 *
 * `app/globals.css` 的 `--background` 是唯一真源，但它是 HSL 三元组，而 PWA
 * manifest 是 JSON、`viewport.themeColor` 是一个 meta 标签——两者都只能吃十六
 * 进制字面量。所以这里是同一个真源的第二种写法，**并且有东西盯着它们不分家**：
 * `lib/palette-drift.test.ts` 断言它等于 globals.css 里 `--background` 解析出来
 * 的值。手抄一个十六进制而没有守卫，正是这个文件在别处警告过的「第三个要记得
 * 改的地方」。
 *
 * 亮色列在这里是为了完整，目前没有消费者：状态栏取的是「没有脚本跑过时真正画
 * 出来的那一个」，而那是暗色。
 */
export const CANVAS = { dark: "#09090b", light: "#ffffff" } as const;

export const COLOR_TOKENS = {

  // Status. These carry meaning, so they are never used decoratively.
  // Each is only ever read, never filled — what sits behind it is the separate
  // wash further down — with the single exception of the one solid red button,
  // whose ink is chosen against it below.
  //
  // Their worst backdrop is their own wash on a hovered row and not the page
  // behind it, which is the mistake T046 made about the green and T049 caught;
  // the washes are literal and do not follow the colour, so the pale pills
  // behind these words are unchanged in both themes.
  //
  // 🔴 T001 took the hue out of everything except these four, so they are the
  // only colour left in the console. It moved none of them. T010 moved two.
  //
  // 🔴 **Reading them on the canvas was never the failure, which is why three
  // earlier sweeps missed it.** On `--bg` the old `--bad` and `--info` were
  // 6.931 and 8.231 — comfortable, and exactly what a check of the four bare
  // surfaces reports. The backdrop that binds them is two washes deep:
  // `--ok-wash` over `--ok-wash` over `--surface-hover`, which composites to
  // #284f3e. There the old values were 3.062 and 3.637, both well under the 4.5
  // their words need. `--ok` and `--warn` cleared that same backdrop already
  // (5.361 and 4.945) and are untouched.
  //
  // ⚠️ **#284f3e is the guard's deliberate superset and not a stack anyone has
  // ever seen.** An earlier draft of this comment described it as a red
  // delivery badge inside a green outbound bubble on a hovered row. That site
  // does not exist: the outbound bubble is `--brand-wash`, which T001 made
  // neutral, and nothing in that subtree has a hover state. The worst stack
  // really painted is that same red badge inside the neutral bubble, #413030,
  // where the old red measured 4.127 — still short, so the defect was real and
  // not an artefact of the superset. `--info` is the honest half of the same
  // story: on every stack that is really painted it already cleared 4.5, and
  // only the superset ever asked it to move.
  //
  // 🔴 **How the two were re-derived, and the one axis that had to give.** Each
  // kept its hue to a tenth of a degree and had its saturation pushed to the
  // sRGB ceiling, so *only* the lightness moved, and it moved the least that
  // clears 4.5 by half a point: 5.058 and 5.077. Saturation going up is a
  // deliberate departure from the rule the light theme used, which held
  // saturation fixed because it had the room. Buying contrast against a dark
  // backdrop is paid for in lightness, and lightness is paid for in chroma, so
  // the saturation ceiling is how as much of the hue as the gamut allows is
  // handed back.
  //
  // ⚠️ **Chroma still falls, and that is the honest price of this repair.** In
  // Oklab, `--bad` goes 0.170 to 0.102 and `--info` 0.150 to 0.098 — a paler
  // red and a paler blue. Both land inside the range other systems ship for
  // dark-theme status text (Material 3's dark error is less chromatic again at
  // 0.068; Tailwind's red-300 is 0.104), and the hue is what carries the
  // meaning, so they still read as red and blue rather than as a tint. On
  // `--bg` the four are now 12.134 / 11.193 / 11.448 / 11.491.
  //
  // 🔴 `--bad` and `--info` are declared with the same names and values in the
  // edge panel's `:root`, in the other repository. Moving them here without
  // moving them there is real drift, and nothing inside this package will
  // notice: no test here opens the edge file. CI does. The `tokens` job in
  // .github/workflows/ci.yml runs `scripts/check-token-parity.cjs` on every
  // push and pull request to this repository, cloning the edge repository
  // beside the checkout so both trees are present, and passing both roots.
  //
  // 🔴 It fires on activity in THIS repository and reads edge `main`, so a
  // one-sided edit committed on the edge side is not seen until the next push
  // here. Running the script yourself is fast feedback, not the guarantee.
  //
  // ⚠️ This comment used to say oracle 1 caught it. Oracle 1 is a board
  // acceptance criterion, judged once against the deployed ends — never a
  // check that runs. Corrected by SN-T020.
  //
  // The four light values did move, and only because their backdrops did: the
  // light surfaces now darken as they rise, so the worst pairing is darker
  // than the one T049 and T051 derived against. Each was re-derived by the
  // rule those cards used — the lightest value on its own exact hue and
  // saturation whose worst real backdrop clears 4.5 by half a point — with the
  // hue and saturation carried across unchanged, so these are the same four
  // colours at a new lightness and not four new colours. Worst backdrops:
  // 5.040 / 5.037 / 5.015 / 5.006.
  ok: { dark: "#4ade9b", light: "#085d3f" },
  warn: { dark: "#f0b429", light: "#6a4c06" },
  bad: { dark: "#ffa9ac", light: "#9b222c" },
  info: { dark: "#97c3ff", light: "#1f5099" },
  // The ink for the one solid button filled with the status red. Both inks are
  // themed now — the accent's became so with this card, because a neutral
  // accent is near-white in one theme and near-black in the other — and both
  // follow the same rule: the ink is the opposite pole of the fill it sits on,
  // in each theme. 8.269 dark, 7.898 light.
  //
  // The ink itself has never moved. The dark figure was 5.006 until T010 raised
  // `--bad`, and it rose with it: a dark ink on a lighter fill can only gain,
  // which is why raising the red needed no compensating edit here. This is the
  // one place the repair paid a dividend rather than a price.
  "bad-ink": { dark: "#52070a", light: "#ffffff" },
  "ok-wash": { dark: "rgba(74, 222, 155, 0.14)", light: "rgba(16, 180, 122, 0.1)" },
  "warn-wash": { dark: "rgba(240, 180, 41, 0.14)", light: "rgba(184, 134, 11, 0.12)" },
  "bad-wash": { dark: "rgba(242, 104, 109, 0.14)", light: "rgba(214, 69, 80, 0.1)" },
  "info-wash": { dark: "rgba(99, 164, 255, 0.14)", light: "rgba(43, 111, 212, 0.1)" },
} as const satisfies Record<string, ThemedValue>;

/** Shadows are themed too: the dark ones are black, the light ones are ink. */
export const SHADOW_TOKENS = {
  shadow: {
    dark: "0 1px 2px rgba(0, 0, 0, 0.35)",
    light: "0 1px 2px rgba(16, 24, 40, 0.06)",
  },
  "shadow-lg": {
    dark: "0 12px 32px rgba(0, 0, 0, 0.45)",
    light: "0 12px 32px rgba(16, 24, 40, 0.12)",
  },
} as const satisfies Record<string, ThemedValue>;

/** Type scale, 1.2 ratio from 0.8125rem. */
export const TEXT_TOKENS = {
  "text-xs": "0.75rem",
  "text-sm": "0.8125rem",
  "text-base": "0.9375rem",
  "text-lg": "1.125rem",
  "text-xl": "1.5rem",
  "text-2xl": "2rem",
} as const;

export const FONT_TOKENS = {
  "font-ui":
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  "font-mono": 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const;

/** Spacing, 4px base. */
export const SPACE_TOKENS = {
  s1: "0.25rem",
  s2: "0.5rem",
  s3: "0.75rem",
  s4: "1rem",
  s5: "1.5rem",
  s6: "2rem",
  s7: "3rem",
} as const;

/**
 * Corner radii, derived from one base rather than written out four times.
 *
 * The corners here were three literals — 3px, 4px, 6px — and the operator's
 * word for the result was "hard". Literals are also why they were hard to
 * soften together: it meant editing three numbers and trusting they still
 * agreed with each other and with the other repo. So the names stay and the
 * numbers go. One base, `--radius-base`, and a ratio per step, with each step
 * written as a multiple of that base so the derivation survives into the
 * stylesheet instead of being flattened here. Moving the base moves every
 * step, in both repos, and nobody edits a step to do it.
 *
 * The base is the one the operator pointed at: 10px. The ratios are three the
 * same source declares — 0.8, 1, 1.4 — and they are assigned by role rather
 * than by name, which is why the two roles that source can be read for land
 * on its values exactly: a control at 8px, a card at 14px.
 *
 * `--radius-pill` is off the scale and has to stay off it. It is a shape, not
 * a step: a pill has to read as a pill at any base, and 999px is how that is
 * said. It is the one value here allowed to be a length of its own.
 *
 * The edge panel declares these same names with these same values. Renaming
 * one here is a change to the other repository, and nothing nearby will fail:
 * there is no check in the edge repo that reads its own tokens, and no test
 * here that reads the edge panel's.
 *
 * `scripts/check-token-parity.cjs` is what compares them, and the `tokens` job
 * in .github/workflows/ci.yml runs it on every push and pull request to this
 * repository, cloning the edge tree beside the checkout so both roots exist.
 * 🔴 That job fires on activity HERE and reads edge `main`: an edit made only
 * on the edge side waits for the next push here. Running it yourself after
 * touching any name is fast feedback, not the guarantee.
 * ⚠️ Corrected by SN-T020: this used to claim renaming one here "breaks a
 * check in the other repo". There was no such check.
 */
export const RADIUS_BASE = "10px";

/** Each derived step, as a multiple of `--radius-base`. */
export const RADIUS_RATIOS = {
  radius: 0.8,
  "radius-md": 1,
  "radius-lg": 1.4,
} as const;

/** A step's value: a multiple of the base, never a length of its own. */
export function radiusStep(ratio: number): string {
  return ratio === 1 ? "var(--radius-base)" : `calc(var(--radius-base) * ${ratio})`;
}

export const RADIUS_TOKENS = {
  "radius-base": RADIUS_BASE,
  radius: radiusStep(RADIUS_RATIOS.radius),
  "radius-md": radiusStep(RADIUS_RATIOS["radius-md"]),
  "radius-lg": radiusStep(RADIUS_RATIOS["radius-lg"]),
  "radius-pill": "999px",
} as const;

/** Anything a finger has to hit. */
export const SIZE_TOKENS = {
  touch: "44px",
} as const;

/** Every token whose value depends on the theme. */
export const THEMED_TOKENS = { ...COLOR_TOKENS, ...SHADOW_TOKENS } as const;

/** Every token that is the same in both themes. */
export const STATIC_TOKENS = {
  ...TEXT_TOKENS,
  ...FONT_TOKENS,
  ...SPACE_TOKENS,
  ...RADIUS_TOKENS,
  ...SIZE_TOKENS,
} as const;

/**
 * What `:root` has to declare, in order.
 *
 * `globals.css` is checked against this, so the stylesheet and this file
 * cannot drift apart without a test failing.
 */
export function rootTokenValues(theme: ThemeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(THEMED_TOKENS)) {
    out[name] = value[theme];
  }
  for (const [name, value] of Object.entries(STATIC_TOKENS)) {
    out[name] = value;
  }
  return out;
}

/** What `:root[data-theme="light"]` has to re-declare: the themed half. */
export function themeOverrideValues(theme: ThemeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(THEMED_TOKENS)) {
    out[name] = value[theme];
  }
  return out;
}

/** `--bg` → `var(--bg)`. The only way a class recipe should name a colour. */
function refs<T extends Record<string, unknown>>(table: T): { [K in keyof T]: string } {
  const out: Record<string, string> = {};
  for (const name of Object.keys(table)) {
    out[name] = `var(--${name})`;
  }
  return out as { [K in keyof T]: string };
}

/* ── Tailwind scales ─────────────────────────────────────────────────────
 *
 * These *replace* Tailwind's colour, spacing, type, radius and shadow scales
 * rather than extending them. That is deliberate. If `bg-red-500` and `p-4`
 * still worked, "use the tokens" would be a convention, and this codebase has
 * fifteen pages of evidence about what happens to visual conventions. With the
 * defaults gone, an off-token class produces no CSS at all, and
 * `tokens.test.ts` turns that silence into a failing test.
 */

export const TAILWIND_COLORS = {
  inherit: "inherit",
  current: "currentColor",
  transparent: "transparent",
  white: "#ffffff",
  black: "#000000",
  ...refs(COLOR_TOKENS),
} as const;

export const TAILWIND_SPACING = {
  "0": "0px",
  px: "1px",
  ...refs(SPACE_TOKENS),
  ...refs(SIZE_TOKENS),
} as const;

export const TAILWIND_FONT_SIZE = {
  xs: "var(--text-xs)",
  sm: "var(--text-sm)",
  base: "var(--text-base)",
  lg: "var(--text-lg)",
  xl: "var(--text-xl)",
  "2xl": "var(--text-2xl)",
} as const;

export const TAILWIND_BORDER_RADIUS = {
  none: "0px",
  DEFAULT: "var(--radius)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  pill: "var(--radius-pill)",
  full: "9999px",
} as const;

export const TAILWIND_BOX_SHADOW = {
  none: "none",
  DEFAULT: "var(--shadow)",
  lg: "var(--shadow-lg)",
} as const;

export const TAILWIND_FONT_FAMILY = {
  sans: "var(--font-ui)",
  mono: "var(--font-mono)",
} as const;

/* ── The scales that were nearly forgotten ───────────────────────────────
 *
 * Replacing colour, spacing, type, radius and shadow is not enough. Tailwind
 * ships a default scale for every other axis too, and those defaults stay live
 * unless they are replaced: before this table existed,
 * `max-w-md leading-7 opacity-75 z-50` produced perfectly good CSS out of
 * numbers nobody in this repository had ever chosen, and no test could see it.
 * That is the drift this design system was built to stop, arriving through the
 * back door — seven pages of migration each picking its own `max-w-*` is
 * exactly the failure mode.
 *
 * Each scale below is closed and small: the entries are the ones the recipes
 * actually use, at the values Tailwind's defaults gave them, so nothing that is
 * rendered changed when they were replaced. Needing another step is fine —
 * add it here, with a reason, where `tokens.test.ts` and a reviewer can see it.
 */

/** Line lengths. Two: a readable measure, and the content column. */
export const TAILWIND_MAX_WIDTH = {
  none: "none",
  full: "100%",
  /** The measure a sentence stays readable at: the centred card, empty states. */
  measure: "24rem",
  /** The content column the shell and every page share. */
  page: "80rem",
} as const;

/**
 * Only `leading-none`, for a 2rem number that carries its own space.
 *
 * Body line-height is set once on `body` in `app/globals.css`; a utility per
 * paragraph is how a page ends up with four of them.
 */
export const TAILWIND_LINE_HEIGHT = {
  none: "1",
} as const;

/**
 * Tight for large type, wider for small caps, and one step for the eyebrows.
 *
 * `eyebrow` is the only pixel value on this scale, and it is in pixels
 * because that is how it was specified: both of the design references this
 * console borrows from set the same 1.4px on their uppercase monospace
 * labels. An `em` step cannot stand in for it — the eyebrows sit at two
 * different sizes (`text-xs` for the column headings, `text-sm` for a section
 * heading), and a step that scales with the type would open the letters of
 * the larger one further than the smaller. The point of the treatment is that
 * every label in the console is spaced alike, so the value that has to be
 * equal is the one in pixels.
 *
 * `wider` stays where it is. It is 0.05em, which on `text-xs` works out near
 * 0.6px, so this is not a rename of the same measurement.
 */
export const TAILWIND_LETTER_SPACING = {
  normal: "0em",
  tight: "-0.025em",
  wider: "0.05em",
  eyebrow: "1.4px",
} as const;

/**
 * Disabled, and the one hover state that dims instead of recolouring.
 *
 * Opacity is not a colour: fading text to 75% produces a grey that is in no
 * theme and passes no contrast check. `text-fg-muted` exists for that.
 */
export const TAILWIND_OPACITY = {
  "0": "0",
  "50": "0.5",
  "90": "0.9",
  "100": "1",
} as const;

/**
 * Four layers, because a console with a `z-50` in it has already lost.
 *
 * 20 is the sticky header, and it matches `.shell-header` in the legacy
 * stylesheet so the two chromes cannot fight during the migration. 30 is the
 * confirmation dialog, and it exists because 20 is not enough: a modal that
 * asks "this strands a module you cannot reach physically, continue?" has to
 * sit above the header, or the header sits on top of the question.
 */
export const TAILWIND_Z_INDEX = {
  auto: "auto",
  "0": "0",
  "10": "10",
  "20": "20",
  "30": "30",
} as const;

/** Spacing plus the two keywords. No fractions: a `w-7/12` is a magic number. */
export const TAILWIND_WIDTH = {
  auto: "auto",
  full: "100%",
  /**
   * The desktop navigation rail, and the one width here that is not spacing.
   *
   * A named step rather than a spacing token because it is not spacing: the
   * scale tops out at 3rem, which is an icon and no word beside it, and the
   * next thing up is the whole content column. What settles this number is the
   * longest label the rail draws — `nav.group.settings` beside a 1rem glyph —
   * and it is the same 14rem the reference console this board is modelled on
   * arrived at from the same list.
   */
  rail: "14rem",
  ...TAILWIND_SPACING,
} as const;

/**
 * Fixed column counts only.
 *
 * Tailwind's default goes to twelve; six is past the point where a table is the
 * right control. `auto-fill`/`minmax` layouts need an arbitrary value, which
 * this system rejects, so a layout that wants one says it with a breakpoint
 * and a fixed count instead.
 */
export const TAILWIND_GRID_TEMPLATE_COLUMNS = {
  none: "none",
  "1": "repeat(1, minmax(0, 1fr))",
  "2": "repeat(2, minmax(0, 1fr))",
  "3": "repeat(3, minmax(0, 1fr))",
  "4": "repeat(4, minmax(0, 1fr))",
  "5": "repeat(5, minmax(0, 1fr))",
  "6": "repeat(6, minmax(0, 1fr))",
} as const;

/* ── The five scales the operator asked for on 2026-08-25 ────────────────
 *
 * The seven replaced above closed the `max-w-md leading-7 opacity-75 z-50`
 * hole. Five more were still on Tailwind's defaults, so `min-h-96 border-4
 * ring-8 inset-3 flex-1` all produced CSS out of numbers nobody here chose,
 * and — exactly as before — no test could see it. Six are replaced below;
 * `maxHeight` is the sixth, because the payload block this card adds is the
 * first recipe that needs one and it would otherwise arrive as `max-h-96`.
 *
 * 🔴 **Two of these carry a trap, and measuring beat guessing on both.**
 *
 * `flex` was measured as unused before this card. It is not: `STAT.root` and
 * `SHELL.main` both carry `flex-1`, which comes from the `flex` shorthand scale
 * and *not* from the display or direction utilities that share the word (those
 * are `display` and `flexDirection`, which nothing here touches). Replacing
 * `flex` with an empty table would have collapsed the stat row and stopped the
 * shell's main column filling the viewport — a layout break with a green suite,
 * since nothing asserts that a class which vanishes used to exist.
 *
 * `inset` was measured as unused too, on the `inset-*` prefix. But `top-*`,
 * `right-*`, `bottom-*` and `left-*` all read the same scale, and `top-0`
 * holds up both sticky headers — `TABLE.headerCell` and `SHELL.header`. Both
 * keep their `0`.
 *
 * Each table below therefore holds exactly what the recipes use today, at the
 * values Tailwind's defaults gave them, so nothing rendered changed.
 */

/**
 * Spacing, plus the viewport unit the shell and the centred pages stand on.
 *
 * Tailwind's default `minHeight` folds in the whole spacing scale, so this has
 * to as well or `min-h-touch` — every control a finger has to hit — stops
 * generating.
 */
export const TAILWIND_MIN_HEIGHT = {
  "0": "0px",
  full: "100%",
  /** `dvh`, not `vh`: mobile Safari's toolbars make `100vh` taller than the screen. */
  dvh: "100dvh",
  ...refs(SPACE_TOKENS),
  ...refs(SIZE_TOKENS),
} as const;

/**
 * One height: how tall a block of verbatim output may get before it scrolls.
 *
 * 22rem is what the deleted stylesheet's verbatim-output block used, so the
 * three payload blocks keep their size. It is a scroll threshold rather than a
 * measure, which is why it is not in `TAILWIND_MAX_WIDTH`.
 */
export const TAILWIND_MAX_HEIGHT = {
  none: "none",
  full: "100%",
  dvh: "100dvh",
  panel: "22rem",
} as const;

/**
 * One rule, no rule, and the tab underline.
 *
 * `2` earns its place: an underlined tab is how the device page's four tabs say
 * which one is showing, and a 1px rule under a tab is not visible next to the
 * 1px rule under the tab list. `border-4` and `border-8` produce nothing now.
 */
export const TAILWIND_BORDER_WIDTH = {
  DEFAULT: "1px",
  "0": "0px",
  "2": "2px",
} as const;

/** The focus ring, and nothing else. `ring-8` is a glow, not a focus state. */
export const TAILWIND_RING_WIDTH = {
  DEFAULT: "3px",
  "0": "0px",
  "2": "2px",
} as const;

/** The gap between a control and its focus ring, so the ring reads as separate. */
export const TAILWIND_RING_OFFSET_WIDTH = {
  "0": "0px",
  "2": "2px",
} as const;

/**
 * `0` only: an element pinned to an edge, or stretched across all four.
 *
 * Read by `inset-*`, `top-*`, `right-*`, `bottom-*` and `left-*` alike. Every
 * offset this console needs is either "against the edge" (`top-0` on the two
 * sticky headers, `inset-0` on the dialog's scrim) or handled by flow. A
 * `top-3` would be a nudge nobody can explain a year later.
 */
export const TAILWIND_INSET = {
  "0": "0px",
  auto: "auto",
  /**
   * The edge of the parent rather than a length — for something parked
   * immediately above or beside its anchor.
   *
   * The phone bar's overflow sheet needs to open upwards from a bar that is
   * itself pinned to the bottom of the viewport, and "as tall as whatever it
   * is sitting on" is not a number this scale could hold: the bar's height is
   * a touch target plus the home-indicator inset, which is a device fact. The
   * one alternative was an arbitrary value, and this system rejects those.
   */
  full: "100%",
} as const;

/**
 * `flex-1` and the two ways of refusing it.
 *
 * ⚠️ This is the `flex` *shorthand* scale. It is not the display utility of
 * the same name, and not the direction utilities either — those come from
 * `display` and `flexDirection`, which nothing here touches. Nothing in this
 * table decides how anything is laid out.
 */
export const TAILWIND_FLEX = {
  "1": "1 1 0%",
  auto: "1 1 auto",
  none: "none",
} as const;

/**
 * Which Tailwind scales are still on their defaults is asserted in
 * `lib/tokens.test.ts`, against Tailwind's own default theme.
 *
 * 🔴 The *list* deliberately lives in the test file rather than here, and the
 * reason is a trap this file already warns about once. `lib/tokens.ts` is
 * Tailwind **content** — the build scans it for class names, which is the whole
 * reason the recipes work — and four of Tailwind's scale names are also bare
 * utilities in the filter family. Writing them here put four real, dead rules
 * into the stylesheet the console ships, from an array of identifiers. It was
 * found by diffing the built CSS against the previous build, not by reading.
 * `tailwind.config.ts` records the same accident happening to
 * `lib/tokens.test.ts` back when the content glob was `./lib/**`; a test file
 * is not content, so the list is safe there.
 *
 * "The shipped stylesheet contains no rule that no file asks for" is a test of
 * its own now, so the next one of these is a failure rather than a discovery.
 * Note what that test cannot do: prose about a design system uses the words
 * "table", "inline", "block" and "visible", and every one of those is also a
 * utility. Its ledger is what separates a word from a mistake.
 */

/* ── Class recipes ───────────────────────────────────────────────────────
 *
 * Read by `components/ui/*.tsx`, and by `tokens.test.ts`, which asks the real
 * Tailwind build whether each class produces CSS. A typo here is a test
 * failure rather than a control that silently loses its padding.
 */

/**
 * One number per card, in a row that becomes a column on a phone.
 *
 * Laid out with flex, and it stays that way now the collision that forced it
 * is gone. The deleted stylesheet asked for
 * `repeat(auto-fill, minmax(min(100%, 260px), 1fr))`, which cannot be written
 * with the token spacing scale and would need an arbitrary value. Equal
 * columns above `sm` and a stack below say the same thing for the counts this
 * console actually shows, and say it without a magic number.
 */
/**
 * 语气到状态色的映射，**这是语义不是样式**。
 *
 * 「哪个词算好、哪个算坏」是这个产品自己的判断，shadcn 没有对应物，
 * docs/frontend-rebuild/cloud-shadcn.md 把这一类明确划进「tokens.ts 删干净之后
 * 仍然留下」的那部分。`StatTone` 这个类型也是从这个对象推出来的。
 *
 * ⚠️ 这是 STAT 唯一剩下的键。row / root / label / value / hint 五个是布局，
 * 已经内联进 components/ui/card.tsx。
 */
export const STAT = {
  tone: {
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
  },
} as const;

/* ── The shell ───────────────────────────────────────────────────────────
 *
 * The chrome every signed-in page renders inside: header bar, grouped
 * navigation, content column, and the source footer.
 */

/* ── The phone's bottom bar ──────────────────────────────────────────────
 *
 * 🔴 **The second renderer of `NAV_GROUPS`, and it is not allowed to hold a
 * list of its own.** The rail draws the array as labelled groups; below
 * shadcn's own breakpoint the library draws the same markup inside a Sheet,
 * so there is one renderer and it cannot disagree with itself.
 *
 * ⚠️ **The overflow trigger deliberately does not sink when pressed.** Every
 * other control in this console does — `BUTTON.base` carries the press — and
 * the reference this board follows guards that press so it skips anything with
 * `aria-haspopup`: a control that opens something should stay put while the
 * thing it opened moves. That guard is written there as a variant with square
 * brackets in it, and this system rejects every class containing one, so the
 * guard is expressed by construction instead: the trigger is a `<summary>`
 * with its own recipe and it never reads `BUTTON.base`. `tokens.test.ts` pins
 * that, because "we simply did not add it" is the kind of decision that gets
 * undone by someone tidying up.
 *
 * ⚠️ **`env(safe-area-inset-bottom)` cannot be a class here.** `position:
 * fixed` takes the bar out of `<body>`'s padding box, so it inherits none of
 * the inset `app/globals.css` puts there, and the class form would need an
 * arbitrary value. It is an inline style — `SAFE_AREA.fixedBottom`, the same
 * one the connection banner uses.
 */

/**
 * The one thing the token scales cannot express.
 *
 * `env(safe-area-inset-top)` is not reachable from a Tailwind class without an
 * arbitrary value, and adding it as a token would mean declaring a custom
 * property in `app/globals.css` — a file this card is not allowed to touch,
 * and one `tokens.test.ts` checks declares *exactly* the token table. So it
 * stays an inline style, which beats every class anyway. Dropping it would put
 * the header under the notch on an installed iOS console, since
 * `app/layout.tsx` asks for `viewportFit: "cover"`.
 */
export const SAFE_AREA = {
  headerTop: { paddingTop: "calc(var(--s2) + env(safe-area-inset-top))" },
  /**
   * The left and right halves, which were missing.
   *
   * Top and bottom were covered — the header by `headerTop`, the content by
   * `padding-bottom` on `body` in `app/globals.css` — and the sides were not.
   * They are not a hypothetical: an iPhone held in landscape puts the notch on
   * one edge and the rounded corners on both, and Safari renders edge to edge
   * horizontally even in a browser tab, so this is clipped text on a device
   * that is *not* installed. Applied to `<body>` in `app/layout.tsx`.
   */
  sides: {
    paddingLeft: "env(safe-area-inset-left)",
    paddingRight: "env(safe-area-inset-right)",
  },
  /**
   * All three again, for a bar fixed to the viewport.
   *
   * `position: fixed` takes the element out of `<body>`'s padding box, so it
   * inherits none of the above: the connection banner would otherwise sit
   * under the home indicator and behind the landscape notch, which is where
   * the one element whose entire job is being read would be least readable.
   */
  fixedBottom: {
    paddingLeft: "env(safe-area-inset-left)",
    paddingRight: "env(safe-area-inset-right)",
    paddingBottom: "env(safe-area-inset-bottom)",
  },
} as const;

/* ── Auth, 404 and the apex page ─────────────────────────────────────────
 *
 * One card centred in the viewport. The login page and the two error pages
 * are the same shape, and all three render without the shell.
 */

/* ── The two PWA affordances ─────────────────────────────────────────────
 *
 * An install offer and a connection banner. They are deliberately at opposite
 * ends of the page and never share an edge, because they can be on screen at
 * the same time — a console being read offline is exactly a console somebody
 * would rather have installed — and two overlapping fixed bars is how one of
 * them becomes invisible.
 */

/* ── Navigation ──────────────────────────────────────────────────────────
 *
 * Four groups, confirmed with the operator. This is data for the same reason
 * the class recipes are: a `.tsx` cannot be read by a test in this app, so a
 * nav written as markup is a nav nothing can check. `tokens.test.ts` asserts
 * every key here resolves in both catalogues and every href is unique.
 *
 * 🔴 **`/sessions` is in Comms, and the reason it was ever anywhere else is
 * worth keeping written down.** The grouping was confirmed with the operator
 * against a description of `/sessions` as *sign-in sessions*, which put it
 * under Settings; it is nothing of the kind. `sessions.desc` says "SMS threads
 * grouped by peer number", it reads `GET /v1/sessions`, and its columns are
 * peer, count and last message — it is `/inbox`'s data seen per peer instead
 * of per message. Under Settings the nav rendered as "Settings > Sessions,
 * Settings", which is the repeated label `navGroupLabel` exists to avoid.
 * Re-confirmed with the operator 2026-08-25 and moved next to `/inbox`.
 * (T007's note records it as absent from the nav entirely, which is the state
 * this replaces.)
 */

export type NavItem = {
  readonly href: string;
  readonly key: string;
  /**
   * `d` of one path drawn in a 24×24 box, stroked, no fill.
   *
   * ⚠️ Absolute commands and no minus signs anywhere, on purpose. This file is
   * scanned by Tailwind, which reads text and not meaning, so a coordinate
   * pair that happens to spell a utility name would put a rule nobody asked
   * for into the stylesheet the console downloads. Upper-case commands with
   * no separators cannot spell one. The check that would catch it either way
   * is "the stylesheet contains no rule that no file asks for".
   */
  readonly icon: string;
};
export type NavGroup = {
  /** `null` when the group is a single link whose own label names it. */
  readonly label: string | null;
  readonly items: readonly NavItem[];
};

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "nav.group.fleet",
    items: [
      {
        href: "/",
        key: "nav.overview",
        icon: "M4 4H10V10H4ZM14 4H20V10H14ZM4 14H10V20H4ZM14 14H20V20H14Z",
      },
      {
        href: "/devices",
        key: "nav.devices",
        icon: "M7 3H17V21H7ZM10 18H14",
      },
      {
        href: "/journal",
        key: "nav.journal",
        icon: "M6 3H15L19 7V21H6ZM9 12H16M9 16H14",
      },
      {
        // What has been measured on which module and network. It sits with
        // the fleet rather than with settings because it decides what the
        // fleet will attempt, and reading it is how somebody finds out why a
        // stick refused.
        href: "/support-ledger",
        key: "nav.ledger",
        icon: "M4 6H20M4 12H20M4 18H13",
        // Explicitly null, not omitted. `bottomNavItems` filters on
        // `!== null`, so an omitted key is `undefined`, passes the filter, and
        // lands the destination on the phone bar with a slot that sorts as
        // NaN. The type says `number | null` for this reason; leaving it out
        // is the one way to get a fifth cell by accident.
      },
      {
        href: "/audit",
        key: "nav.audit",
        icon: "M12 3L20 6V12C20 17 16 20 12 21C8 20 4 17 4 12V6Z M9 12L11 14L15 10",
      },
    ],
  },
  {
    label: "nav.group.comms",
    items: [
      {
        href: "/inbox",
        key: "nav.inbox",
        icon: "M3 6H21V18H3Z M3 7L12 13L21 7",
      },
      {
        href: "/sessions",
        key: "nav.sessions",
        icon: "M21 12C21 16 17 19 12 19C11 19 10 19 9 18L4 20L5 16C4 15 3 14 3 12C3 8 7 5 12 5C17 5 21 8 21 12Z",
      },
      {
        href: "/rules",
        key: "nav.rules",
        icon: "M4 7H20M4 17H20 M9 4V10M15 14V20",
      },
      {
        href: "/schedule",
        key: "nav.schedule",
        icon: "M4 6H20V20H4ZM4 10H20M9 3V7M15 3V7",
      },
    ],
  },
  {
    label: "nav.group.network",
    items: [
      {
        href: "/proxy",
        key: "nav.proxy",
        icon: "M4 4H10V10H4ZM14 14H20V20H14ZM10 7H17V14",
      },
    ],
  },
  {
    label: "nav.group.settings",
    items: [
      {
        href: "/settings",
        key: "nav.settings",
        icon: "M12 8A4 4 0 1 0 12 16A4 4 0 1 0 12 8Z M12 2V5M12 19V22M2 12H5M19 12H22",
      },
    ],
  },
];

/**
 * Every destination, in the order the groups declare them.
 *
 * The desktop rail keeps the groups; the phone bar and its sheet want one
 * sequence. Both start here, so neither can be looking at a set the other is
 * not.
 */
export function navItems(): readonly NavItem[] {
  return NAV_GROUPS.flatMap((group) => group.items);
}

/** Exact match, an ancestor of the current path, or neither. */
export type NavState = "page" | "section" | null;

/**
 * Which nav entry the current path belongs to.
 *
 * A plain prefix test would light up the overview link on every page, since
 * its href is `/`. Only `page` becomes `aria-current="page"`: a device detail
 * page is *inside* the devices section, it is not the devices page, and saying
 * otherwise to a screen reader is a lie told for a highlight.
 */
export function navState(pathname: string, href: string): NavState {
  if (pathname === href) return "page";
  // The trailing slash is doing two jobs: it keeps `/` from matching every
  // path, and it keeps `/rules` from claiming `/rules-archive`. A bare
  // `startsWith(href)` breaks both at once.
  return pathname.startsWith(`${href}/`) ? "section" : null;
}

/* ── The device page's tabs ──────────────────────────────────────────────
 *
 * Data for the same reason the nav is: a `.tsx` cannot be rendered by a test in
 * this app, so a tab strip written as markup is a tab strip nothing can check.
 *
 * The page is split because the survey measured its interactive weight at 1679
 * lines in two components, which is more than one card can carry — so the
 * skeleton is built by one card and two of the four panels are filled by
 * another. That seam is the reason the order and the ids are here rather than
 * inline: the second card adds no tab and renames none, it fills the two whose
 * ids are already written down, and if it disagrees the assertion below fails
 * rather than the two cards shipping different strips.
 *
 * The labels of the last two are keys that already existed — the console panel
 * and the eSIM panel have been titled on this page since it was written, and
 * inventing `device.tabConsole` beside `device.console` is how a catalogue ends
 * up with two spellings of one word.
 */

export type DeviceTabId = "overview" | "diagnostics" | "console" | "esim";

export type DeviceTab = {
  readonly id: DeviceTabId;
  readonly key: string;
  /** `false` for a panel that writes: it decides nothing, it labels the seam. */
  readonly readOnly: boolean;
};

export const DEVICE_TABS: readonly DeviceTab[] = [
  { id: "overview", key: "device.tabOverview", readOnly: true },
  { id: "diagnostics", key: "device.tabDiagnostics", readOnly: true },
  { id: "console", key: "device.console", readOnly: false },
  { id: "esim", key: "esim.title", readOnly: false },
];

/**
 * Which panel a request is asking for.
 *
 * Total, and the fallback is the first tab rather than a thrown error: `?tab=`
 * comes from a URL, and a mistyped or stale one has to land somewhere. Returning
 * the id rather than a boolean per panel is what keeps "exactly one panel is
 * rendered" true by construction instead of by four conditions agreeing.
 *
 * `string[]` is not a defensive flourish — `?tab=a&tab=b` really does arrive as
 * an array from Next's search params, and `String(["a","b"])` is `"a,b"`, which
 * matches nothing and would silently fall back. Taking the first is the same
 * answer a link with one value would have given.
 */
export function deviceTab(value: string | string[] | undefined): DeviceTabId {
  const asked = Array.isArray(value) ? value[0] : value;
  const found = DEVICE_TABS.find((tab) => tab.id === asked);
  return found ? found.id : DEVICE_TABS[0].id;
}

/**
 * The href of one tab on one device.
 *
 * A tab that changes the URL rather than client state is what keeps this page a
 * server component — which is what keeps its language right in the HTML, the
 * defect this console has shipped twice — and what makes a tab survive the
 * reload an operator does when a command is slow.
 *
 * The device id is encoded because it reaches this from the path segment.
 */
export function deviceTabHref(deviceId: string, tab: DeviceTabId): string {
  return `/devices/${encodeURIComponent(deviceId)}?tab=${tab}`;
}

/** 徽章的语气。原本是 `keyof typeof BADGE.tone`；BADGE 那个配方随组件换成
 * shadcn 的 cva 之后成了死代码，语气本身是产品语义，所以直接写下来。 */
export type BadgeTone = "ok" | "warn" | "bad" | "info" | "neutral";
export type StatTone = keyof typeof STAT.tone;

/**
 * Status word to badge tone.
 *
 * An unknown state falls back to neutral rather than guessing. A wrong colour
 * on a fleet dashboard is worse than no colour: green is read as "fine".
 */
const TONE_BY_STATE: Record<string, BadgeTone> = {
  online: "ok",
  registered: "ok",
  offline: "neutral",
  busy: "warn",
  searching: "warn",
  denied: "bad",
  error: "bad",
};

export function toneForState(state: string): BadgeTone {
  return TONE_BY_STATE[state.toLowerCase()] ?? "neutral";
}

/**
 * What happened to a sent message, as a colour.
 *
 * A second table rather than more rows on `TONE_BY_STATE`, because these are
 * answers to a different question and one of them collides: a modem is `busy`
 * and a message is `queued`, and both mean "wait", but a message that is
 * `failed` and a modem that is in `error` are not the same kind of thing to a
 * reader scanning a fleet.
 *
 * `sent` and `delivered` are both green and are still two states. `sent` is the
 * module reporting that it took the message; `delivered` is the network
 * reporting that the recipient got it, and it arrives separately and later.
 * Colour cannot carry that difference, so the word beside it does.
 *
 * ⚠️ `toneForState` cannot be reused here and looked as if it could. It knows
 * seven modem states, none of which are these, so every delivery badge would
 * have come back neutral — a colour silently lost, which is the same defect the
 * overview's bearer pill was fixed of.
 */
const TONE_BY_DELIVERY: Record<string, BadgeTone> = {
  delivered: "ok",
  sent: "ok",
  failed: "bad",
  undelivered: "bad",
};

/**
 * `queued` is deliberately absent and falls through to the default.
 *
 * The table holds what the old ternary spelled out and nothing more: it named
 * four states and gave everything else the warning colour, `queued` included.
 * Adding a fifth row here saying `queued: "warn"` would read as a decision and
 * change nothing, and the first person to add a sixth state would then have two
 * places to look for what it is coloured.
 */

export function toneForDeliveryStatus(status: string): BadgeTone {
  return TONE_BY_DELIVERY[status.toLowerCase()] ?? "warn";
}

/**
 * A relayed command's status word to a badge tone.
 *
 * Its own table rather than an extra row in `TONE_BY_STATE`, because these are
 * a different vocabulary about a different thing: `failed` is a device state
 * and also a command status, and `pending` is neither. Folding them together
 * would mean one map answering two questions, which is how a device that has
 * never checked in ends up wearing the colour of a command that timed out.
 *
 * ⚠️ Anything not listed comes out neutral, and it has to: the gateway records
 * whatever status a newer console or a newer edge produced, and guessing a
 * colour for a word this build does not know is worse than not colouring it.
 */
const TONE_BY_COMMAND_STATUS: Record<string, BadgeTone> = {
  succeeded: "ok",
  failed: "bad",
  expired: "bad",
  cancelled: "neutral",
  pending: "warn",
  dispatched: "warn",
  running: "warn",
};

export function toneForCommandStatus(status: string): BadgeTone {
  return TONE_BY_COMMAND_STATUS[status.toLowerCase()] ?? "neutral";
}

/**
 * An eUICC profile's state to a badge tone.
 *
 * `enabled` is the one carrying traffic, `deleted` is gone from the chip, and
 * everything else — `disabled` above all — is inventory rather than news. The
 * eSIM panel shows deleted profiles on purpose: which ICCID *used to* be on a
 * chip is exactly what somebody needs when a card stops working after a switch.
 */
const TONE_BY_PROFILE_STATE: Record<string, BadgeTone> = {
  enabled: "ok",
  deleted: "bad",
};

export function toneForProfileState(state: string): BadgeTone {
  return TONE_BY_PROFILE_STATE[state.toLowerCase()] ?? "neutral";
}

/* ── A confirmation has to say what will happen ──────────────────────────
 *
 * T030 read every confirmation in this console. Two of them state a
 * consequence. `messages/zh.json:179` `device.confirmUsbnet` says the module
 * re-enumerates, loses its QMI port, leaves the device list, and how to get it
 * back; `:431` `esim.dlWarn` says the write cannot be undone, that it installs
 * without enabling, and that a ppr1/ppr2 profile will be refused. Everything
 * else is a question with nothing behind it: `device.confirmDisruptive` is one
 * sentence shared by seven commands and names none of them, and
 * `proxy.confirmRemove` is "Remove this permanently?" for two different kinds
 * of object.
 *
 * The rules below are the shape of the two that work, made into a check. The
 * dialog owns the question, so the caller can only supply the statement — which
 * is why "asks a question" is a rejection rather than an oversight. `T011` is
 * the card that splits `confirmDisruptive` into seven; this is what stops it
 * handing in seven copies of the sentence it started with.
 */

/**
 * Short enough that a real consequence clears it, long enough that the two
 * strings this console actually ships do not.
 *
 * It is a floor against the observed failure mode — a seven-character question
 * — and not a measure of quality. The rules that carry the real weight are
 * "not a question" and "at least one complete statement"; a length alone would
 * be satisfied by padding, and is written down here so nobody mistakes it for
 * the whole test.
 */
export const CONFIRM_MIN_CONSEQUENCE = 16;

const SENTENCE_END = /[.。!！;；]/;
const QUESTION_END = /[?？]\s*$/;

/**
 * Why this text cannot be used as a consequence, or `null` if it can.
 *
 * Returns a reason rather than a boolean because the reason is what tells the
 * next person what to write instead.
 */
export function consequenceProblem(consequence: string): string | null {
  const text = consequence.trim();
  if (text === "") return "a confirmation with no consequence is a speed bump";
  if (QUESTION_END.test(text)) {
    return "this is the question, and the dialog asks that itself; say what will happen";
  }
  if (!SENTENCE_END.test(text)) {
    return "not one complete sentence — name the object and say what happens to it";
  }
  if (text.length < CONFIRM_MIN_CONSEQUENCE) {
    return `${text.length} characters cannot say which thing this is or what it does`;
  }
  return null;
}

/**
 * The same rule, as a throw.
 *
 * `ConfirmDialog` calls this while rendering, so a confirmation with nothing
 * behind it fails loudly at the point of use instead of quietly asking a bare
 * question. That is the right way round for this fleet: a dialog that crashes
 * gets fixed, and a dialog that says "Continue?" over `restart_modem` gets
 * clicked.
 */
export function assertConsequence(consequence: string): string {
  const problem = consequenceProblem(consequence);
  if (problem) throw new Error(`ConfirmDialog: ${problem} — got ${JSON.stringify(consequence)}`);
  return consequence.trim();
}

/**
 * Message keys used as a consequence, checked in both catalogues.
 *
 * Page cards append to this. `tokens.test.ts` runs every key here through
 * `consequenceProblem` in `zh` *and* `en`, so a consequence written in one
 * language and skipped in the other is a failing test rather than an English
 * dialog that asks a naked question.
 *
 * It starts with the one key this console already has that is a consequence
 * rather than a question: `device.usbnetWarning`, the paragraph the USB-net
 * control shows above its own button. T011 attaches it to that control's
 * confirmation and adds the seven it has to write.
 *
 * The five `proxy.*` entries came next, with the proxy page. Four of them
 * replace `proxy.confirmRemove` — one sentence, "Remove this permanently?",
 * which was the whole of the guard on two different kinds of object and named
 * neither — and the fifth is a confirmation where there was none at all. Each
 * takes `{…}` placeholders that `interpolate` fills at the point of use, so
 * the object is named in the sentence rather than left to the reader.
 */
export const CONFIRM_CONSEQUENCE_KEYS = [
  "device.usbnetWarning",
  // Writing an APN context. The module keeps it across a reboot and there is
  // no automatic way back, which is the same shape as the usbnet warning above.
  "device.confirmConfigureApn",
  "device.confirmClaimCandidate",
  // Unmanaging a module. Nothing is written to the hardware, so this is not a
  // warning about the stick -- it is a warning about the list: a working
  // module disappears from it, and the operator who did this by accident has
  // to find it again in the candidates card to put it back.
  "device.confirmUnregister",
  "device.confirmDisableProfile",
  "device.confirmDeleteProfile",
  /**
   * The five edits the card policy table can make. Every one of them is a write
   * that reaches every device in the tenant, and until this card none of the
   * five asked anything at all — see the note above `CARD_POLICY_CONFIRMATIONS`.
   */
  "cards.confirmCellularOff",
  "cards.confirmCellularOn",
  "cards.confirmVertical",
  "cards.confirmAdd",
  "cards.confirmRemove",
  // A plan declaration is the same kind of write: it reaches every device in
  // the tenant, and withholding one stops the edge attempting the operation.
  "cards.confirmCapabilityOff",
  "cards.confirmCapabilityOn",
  "cards.confirmCapabilityClear",
  "proxy.confirmRemoveUpstream",
  "proxy.confirmRemoveInstance",
  "proxy.confirmRemoveRule",
  "proxy.confirmStop",
  "proxy.confirmRestart",
  /**
 * The settings page adds three. Two of them belong to "send a test
 * notification", which was the only unguarded action in this console that
 * reaches a *person* — it dials out through a channel using the credential the
 * gateway is holding, and nothing about the button said so. The third is the
 * save, which writes every field of a section at once, credentials included.
 * `settingsSaveConsequence` joins the last two, so a section with no credential
 * in it does not claim to be writing one.
 */
  "settings.confirmTest",
  "settings.confirmSave",
  "settings.confirmSaveSecrets",
  /**
   * The inbox's four, from T014. Three of these had no confirmation at all —
   * a text message that costs money and cannot be recalled, and two server-side
   * deletions that read like hiding something locally.
   *
   * `inbox.confirmDeleteThread` is the fourth and was already a confirmation.
   * It is here because its Chinese text was fourteen characters ending in a
   * question, which is exactly what `consequenceProblem` refuses: the dialog
   * asks the question itself now, so the string had to become the answer.
   */
  "inbox.confirmSend",
  "inbox.confirmDeleteMessage",
  "inbox.confirmDeleteThread",
  "inbox.confirmForgetContact",
  /**
   * The device console's, from T011. `device.confirmDisruptive` — one sentence
   * shared by seven commands, naming none of them — is retired here and these
   * are what replaced it, one per command, each naming the module, what it
   * loses, and what the way back is.
   *
   * Four of them are new guards rather than new copy: manual PLMN selection,
   * opening a USSD session, replying into one, and every typed AT command that
   * trips `AT_COMMAND_GUARDS`. T030 found all four sending with nothing in
   * front of them, and T021's twenty-three-row survey of dangerous actions had
   * missed the AT box entirely.
   */
  "device.confirmRestartModem",
  "device.confirmResetModemUsb",
  "device.confirmScanOperators",
  "device.confirmRotateIp",
  "device.confirmRadioOff",
  "device.confirmDataOff",
  "device.confirmReregister",
  "device.confirmSelectOperator",
  "device.confirmUssdSend",
  "device.confirmUssdReply",
  "device.confirmUsbnet",
  "device.confirmUsbnetRmnet",
  "device.confirmUnknownCommand",
  "device.atGuardUsbnet",
  "device.atGuardCfunReset",
  "device.atGuardCfunOff",
  "device.atGuardCops",
  "device.atGuardCrsm",
  "device.atGuardCsim",
  "device.atGuardChannel",
  "device.atGuardNvram",
  /** The eSIM panel's two writes. Both already asked; neither said anything. */
  "esim.confirmSwitch",
  "esim.dlWarn",
] as const;

/** The dialog's own chrome, so every confirmation asks in the same words. */
export const CONFIRM_LABEL_KEYS = [
  "confirm.question",
  "confirm.proceed",
  "confirm.cancel",
] as const;

/* ── Editing a card policy is a write to the whole fleet ─────────────────
 *
 * `components/card-policies.tsx` has no save button. A tick in a row and a
 * picker in the next cell each called `save()` from their own `onChange`, and
 * `save()` is a `PUT` to `/v1/cards/{iccid}/policy` — a policy this console
 * pushes to every device in the tenant, which is what `cards.note` has always
 * said in as many words. Clearing that tick takes cellular data away from that
 * SIM everywhere, with nothing asked first and nothing to undo it but ticking
 * it again.
 *
 * T021's survey of dangerous actions has twenty-three rows and this is not one
 * of them. T030 found it by reading the file. It is the same defect as seven
 * commands sharing one question, reached from the other side: there was no
 * question.
 *
 * Every edit this component can make is now the answer to a dialog, and this is
 * the table of which dialog. Confirming *all five* rather than only the
 * destructive direction is deliberate, for two reasons:
 *
 * - The guard in `tokens.test.ts` is about the call site: the function that
 *   performs the request has to be reachable from an `onConfirm` and from
 *   nowhere else. A component with one confirmed path and one unconfirmed path
 *   into the same `fetch` cannot make that claim, and a guard that is green
 *   while an unconfirmed path exists is the false green this board has paid for
 *   six times.
 * - There is no small edit here. Allowing data on a card starts it billing;
 *   changing its vertical re-routes it and drops the sessions in flight; adding
 *   a policy takes the card off every device's defaults. The tick was only the
 *   loudest of the five.
 *
 * ⚠️ **None of this belongs in the design system.** It is here for the reason
 * `secretInputProps` is: `lib/tokens.ts` was the only file under `lib/` this
 * card was allowed to edit, and a `.tsx` cannot be tested in this app, so the
 * alternative was not a better home — it was no test at all. Move it to its own
 * module the moment a card owns one.
 */

/** An edit the card policy table can make, before anything has been sent. */
export type CardPolicyEdit =
  | { readonly kind: "cellular"; readonly enabled: boolean }
  | { readonly kind: "vertical"; readonly from: string; readonly to: string }
  // What the plan on this card is sold as doing. `null` clears the
  // declaration back to undeclared, which withholds nothing.
  | {
      readonly kind: "capability";
      readonly operation: import("./card-capability.ts").CardCapabilityOperation;
      readonly value: boolean | null;
    }
  | { readonly kind: "add" }
  | { readonly kind: "remove" };

export type { CardCapabilityOperation } from "./card-capability.ts";

/** Which of the five dialogs an edit goes through. */
export type CardPolicyGuard = keyof typeof CARD_POLICY_CONFIRMATIONS;

/**
 * The copy for each dialog: what is about to happen, and what it will do.
 *
 * Data rather than five call sites choosing their own strings, so that
 * `tokens.test.ts` can hold every one of them to `consequenceProblem` in both
 * languages and the page can hand the whole table down without listing it by
 * hand. A sixth edit added here without its copy is a failing test.
 */
export const CARD_POLICY_CONFIRMATIONS = {
  cellularOff: { title: "cards.confirmCellularOffTitle", consequence: "cards.confirmCellularOff" },
  cellularOn: { title: "cards.confirmCellularOnTitle", consequence: "cards.confirmCellularOn" },
  vertical: { title: "cards.confirmVerticalTitle", consequence: "cards.confirmVertical" },
  add: { title: "cards.confirmAddTitle", consequence: "cards.confirmAdd" },
  remove: { title: "cards.confirmRemoveTitle", consequence: "cards.confirmRemove" },
  // Withholding stops the edge attempting the operation at all. Restoring is
  // asked for the same reason cellular is asked in both directions: a card
  // somebody marked as not sending was marked that way on purpose.
  capabilityOff: {
    title: "cards.confirmCapabilityOffTitle",
    consequence: "cards.confirmCapabilityOff",
  },
  capabilityOn: {
    title: "cards.confirmCapabilityOnTitle",
    consequence: "cards.confirmCapabilityOn",
  },
  capabilityClear: {
    title: "cards.confirmCapabilityClearTitle",
    consequence: "cards.confirmCapabilityClear",
  },
} as const;

/**
 * The confirmation an edit needs, or `null` when there is nothing to do.
 *
 * 🔴 `null` means **send nothing**, and never "send it without asking". That is
 * the whole shape of the fix: the component's one entry point asks this
 * question and can only either open a dialog or drop the edit, so there is no
 * branch left that reaches a `fetch` on its own. The only `null` case today is
 * a picker that ends up on the value it started from, which a browser does not
 * even fire — but a re-render that resets a control is exactly how one would
 * arrive, and a no-op `PUT` on the whole fleet is not a no-op.
 */
export function cardPolicyGuardFor(edit: CardPolicyEdit): CardPolicyGuard | null {
  switch (edit.kind) {
    case "cellular":
      // Both directions ask. Allowing data is not the harmless one: a card
      // blocked to stop it billing is a card somebody blocked on purpose.
      return edit.enabled ? "cellularOn" : "cellularOff";
    case "vertical":
      return edit.to === edit.from ? null : "vertical";
    case "capability":
      if (edit.value === false) return "capabilityOff";
      if (edit.value === true) return "capabilityOn";
      return "capabilityClear";
    case "add":
      return "add";
    case "remove":
      return "remove";
  }
}

/**
 * The fields an edit changes. Everything else in the request body comes from
 * the row being edited, exactly as it did before.
 *
 * `remove` is not a parameter: it is a `DELETE`, and typing it out of this
 * function is cheaper than a branch that returns something nobody sends.
 */
export function cardPolicyPatch(edit: Exclude<CardPolicyEdit, { kind: "remove" }>): {
  cellularEnabled?: boolean;
  vertical?: string;
  // The four plan declarations, named as the row names them so the caller can
  // spread this straight into the body it already builds. `null` is a value
  // here and not an absence: it clears a declaration back to undeclared.
  smsSend?: boolean | null;
  smsReceive?: boolean | null;
  data?: boolean | null;
  voice?: boolean | null;
} {
  switch (edit.kind) {
    case "cellular":
      return { cellularEnabled: edit.enabled };
    case "vertical":
      return { vertical: edit.to };
    case "capability":
      return { [edit.operation]: edit.value };
    case "add":
      // What the "add policy" form has always sent for a card that has none.
      return { cellularEnabled: true, vertical: "cn" };
  }
}

/**
 * Writes that may only happen after somebody answered the question.
 *
 * The ledger of confirmed writes, the module that must not send, and the
 * fail-closed answer to "may this form send" all moved to `lib/sms-safety.ts`.
 * T014 left them here under protest and said so twice; T032 moved them.
 *
 * That last clause is the whole point. A file can keep its dialog, keep its
 * confirmation copy, and have somebody wire the button straight back to the
 * function during a later change; every other guard in this repository stays
 * green through that, because the dialog is still *defined*. This board has
 * already been bitten once by an assertion that matched a definition rather
 * than a use (T004), so the rule here is the use.
 *
 * Only the card policy table is listed. The other dangerous actions T030 found
 * live in files this card could not edit, and a name added here for a function
 * that does not exist yet is a failing test rather than a reminder — which is
 * the right way round: the card that writes the confirmation adds the line.
 */

/* ── Modules this console will not send a message from ───────────────────
 *
 * Not a policy invented here, and — this is the part that keeps being got
 * wrong — **not "SMS is broken on that stick"**.
 *
 * `867018069509705` stalls its own QMI interrupt endpoint on every MO submit:
 * the USB/IP session is torn down and the module leaves the bus for tens of
 * seconds. Both transports trigger it, and a full `AT+CFUN=1,1` does not clear
 * it. `edge-bin/src/main.rs:537-560` is the primary record, and it says the
 * opposite of what this board believed until T006 checked:
 *
 * > The submit itself is not undone by that -- the SIM's own MO reference
 * > counter in `EF_SMSS` advanced by 34 over a day of sends the console
 * > recorded as failures, and 10086 kept replying to them. Told "failed", an
 * > operator resends and the recipient gets it twice.
 *
 * So the cost is not a lost message. It is a lost module, and the copy in
 * `messages/*.json` has to say that: telling an operator the message cannot be
 * sent is the exact lie that daemon comment exists to stop, and it produces
 * duplicate messages at the far end.
 *
 * ⚠️ **Keyed by IMEI, and matched against a whole device.** The console's send
 * takes a `device_id` and no module, so which module carries the message is
 * decided at the edge — and with nothing to aim it, the edge takes the first
 * entry out of its modem map. A device holding one of these is therefore a
 * device this console cannot promise anything about, which is why the whole
 * device is refused rather than one option in a picker this form does not have.
 *
 * ⚠️ **This does not belong in the design system**, and it is here because the
 * card that had to write it could edit exactly one file under `lib/`. A `.tsx`
 * cannot be tested in this app, so the alternative was not a better home; it
 * was no test at all. Move it to its own module the moment a card owns one.
 */

/** IMEI → the message keys that say why, and what the cost really is. */

/* ── The free-text AT box ────────────────────────────────────────────────
 *
 * 🔴 **This is the hole T021's twenty-three-row survey of dangerous actions
 * did not have a row for.** `device-console.tsx` has an input that sends
 * whatever is typed into it as `run_at_command`, and until this card the only
 * thing between an operator and the modem was `command.trim().length < 2`.
 * `AT+CFUN=0` and `AT+CFUN=4` therefore reached the module **without passing
 * the confirmation the seven `DISRUPTIVE` buttons have** — and `AT+CFUN=1,1`
 * is the command the vowifi board's T078 watched leave a module stranded at
 * `+CFUN: 7`, on hardware that arrives over USB/IP where nobody can pull a
 * stick.
 *
 * The edge debug panel has had `guardFor(command)` since T004 and it now
 * carries eight entries (T031). This is the same table, in the same order,
 * for the cloud console.
 *
 * ## The test an entry has to pass
 *
 * **It can leave the module in a state software cannot get it out of**, on
 * hardware nobody can physically reach. That is the property, and it is the
 * reason for the one entry people keep asking about:
 *
 * ⚠️ **`AT+COPS=?` is deliberately absent.** The full-band sweep is slow — the
 * daemon gives it 180 seconds — but it is not irreversible: the modem comes
 * back by itself with nothing to undo. It was in the edge's table for one card
 * and was taken back out, because **a dialog in front of a safe command is what
 * teaches an operator to confirm without reading**, and that is precisely how
 * the entries below stop working. The *manual* forms, `AT+COPS=1,…` and `=2`,
 * are here: locking onto a PLMN that is not on the air leaves the module with
 * nothing on screen to say why.
 *
 * For the same reason `AT+CRSM` is trapped on the update codes only — the
 * agent itself sends `AT+CRSM=176,…` on every report — and a plain `AT+CFUN=1`,
 * which is the *recovery*, goes through untouched.
 *
 * ## What this is not
 *
 * A confirmation in a browser, and nothing else. The gateway validates each
 * command on its own terms and this table is not part of that; a page cannot
 * be a security control for a request it is not the only sender of. It stops a
 * slip of the hand, which is what the box is dangerous for.
 */

export type AtCommandGuard = {
  /** Stable id, so a test can name an entry without quoting its regex. */
  readonly id: string;
  /** The shape, as it is shown to the operator before they type. */
  readonly label: string;
  /** Matched against the trimmed command, case-insensitively. */
  readonly pattern: RegExp;
  /** The message key of the sentence saying what this one costs. */
  readonly consequence: string;
};

export const AT_COMMAND_GUARDS: readonly AtCommandGuard[] = [
  {
    id: "usbnet",
    label: 'AT+QCFG="usbnet",N',
    pattern: /^at\+qcfg\s*=\s*"usbnet"\s*,\s*\d+/i,
    consequence: "device.atGuardUsbnet",
  },
  {
    // Before the bare forms below, because `AT+CFUN=0,1` is a reset and
    // `AT+CFUN=0` is not, and the first match wins.
    id: "cfun-reset",
    label: "AT+CFUN=N,1",
    pattern: /^at\+cfun\s*=\s*\d+\s*,\s*1\s*$/i,
    consequence: "device.atGuardCfunReset",
  },
  {
    id: "cfun-off",
    label: "AT+CFUN=0 / =4 / =7",
    pattern: /^at\+cfun\s*=\s*(?:0|4|7)\s*(?:,\s*0\s*)?$/i,
    consequence: "device.atGuardCfunOff",
  },
  {
    id: "cops-manual",
    label: "AT+COPS=1,… / =2",
    pattern: /^at\+cops\s*=\s*[12]\s*(?:,|$)/i,
    consequence: "device.atGuardCops",
  },
  {
    id: "crsm-write",
    label: "AT+CRSM=214/219/220,…",
    pattern: /^at\+crsm\s*=\s*(?:214|219|220)\b/i,
    consequence: "device.atGuardCrsm",
  },
  {
    id: "csim",
    label: "AT+CSIM=…",
    pattern: /^at\+csim\s*=/i,
    consequence: "device.atGuardCsim",
  },
  {
    id: "logical-channel",
    label: "AT+CCHO / +CGLA / +CCHC",
    pattern: /^at\+(?:ccho|cgla|cchc)\b/i,
    consequence: "device.atGuardChannel",
  },
  {
    id: "nvram",
    label: "AT+QPRTPARA=…",
    pattern: /^at\+qprtpara\s*=/i,
    consequence: "device.atGuardNvram",
  },
];

/** The first guard a typed command trips, or `null`. */
export function atCommandGuard(command: string): AtCommandGuard | null {
  const typed = String(command ?? "").trim();
  for (const guard of AT_COMMAND_GUARDS) {
    if (guard.pattern.test(typed)) return guard;
  }
  return null;
}

/* ── What stands in front of each command ────────────────────────────────
 *
 * One ledger for every command the device page can issue, from either panel,
 * because both of them post to the same `/v1/commands`. Data rather than a
 * condition inside a handler, for the reason everything else in this file is:
 * a `.tsx` cannot be read by a test in this app, so a guard written into a
 * click handler is a guard nothing can check.
 *
 * `consequence: null` is a *decision*, not an omission, and it carries its
 * reason. That is the half that keeps the table honest: a guard in front of a
 * harmless command trains the reflex that defeats every other guard, so
 * refusing to add one has to be as visible as adding one.
 *
 * `tokens.test.ts` derives the set of kinds the two components actually issue
 * from their source and requires it to equal these keys, so a command added to
 * a panel with no entry here is a failing test rather than an unguarded write.
 */

export type CommandGuard = {
  /** The message key of the sentence saying what will happen, or `null`. */
  readonly consequence: string | null;
  /** Why it is guarded, or why it deliberately is not. For a reviewer. */
  readonly why: string;
};

/**
 * One command's guard, possibly depending on what it is being asked to do.
 *
 * `when` is a subset of the request payload that has to match. The last
 * variant of every entry has an empty `when` and is therefore the fallback,
 * which is what makes the lookup total.
 */
export type CommandGuardVariant = CommandGuard & {
  readonly when: Readonly<Record<string, unknown>>;
};

export const DEVICE_COMMAND_GUARDS: Readonly<Record<string, readonly CommandGuardVariant[]>> = {
  /* ---- device-console.tsx: reads ---- */
  modem_report: [
    { when: {}, consequence: null, why: "a diagnostic read; it changes nothing on the module" },
  ],
  refresh_modems: [
    { when: {}, consequence: null, why: "re-enumerates what the agent can already see" },
  ],

  /* ---- device-console.tsx: writes ---- */
  restart_modem: [
    {
      when: {},
      consequence: "device.confirmRestartModem",
      why: "the vowifi board's T078: this is how a module reaches +CFUN: 7, and nobody can reach the hardware to power-cycle it",
    },
  ],
  reset_modem_usb: [
    {
      when: {},
      consequence: "device.confirmResetModemUsb",
      why: "the module leaves the USB bus; it arrives over USB/IP, so a stick that does not come back cannot be replugged",
    },
  ],
  scan_operators: [
    {
      when: {},
      consequence: "device.confirmScanOperators",
      why: "the radio is taken away for up to three minutes; the way back is nothing, which the old shared sentence got wrong",
    },
  ],
  rotate_ip: [
    {
      when: {},
      consequence: "device.confirmRotateIp",
      why: "the data session is torn down and rebuilt for a new address; the old sentence said 'off the network', which is not what this does",
    },
  ],
  reregister_network: [
    {
      when: {},
      consequence: "device.confirmReregister",
      why: "detach and attach: the module is off the air until the network takes it back",
    },
  ],
  set_radio: [
    {
      when: { enabled: false },
      consequence: "device.confirmRadioOff",
      why: "no calls, no messages, no data until it is switched back on",
    },
    { when: {}, consequence: null, why: "switching the radio back on is the way back from the guarded half" },
  ],
  set_data_network: [
    {
      when: { enabled: false },
      consequence: "device.confirmDataOff",
      why: "the default bearer goes down and anything routed through this module stops",
    },
    { when: {}, consequence: null, why: "bringing data back up is the way back from the guarded half" },
  ],
  rename_esim_profile: [
    {
      when: {},
      consequence: null,
      why: "it changes a label stored on the card and nothing about the subscription; a dialog in front of renaming trains people to click through the one in front of deleting",
    },
  ],
  disable_esim_profile: [
    {
      when: {},
      consequence: "device.confirmDisableProfile",
      why: "the module is left with no profile in service, so it drops off the network until another one is enabled",
    },
  ],
  delete_esim_profile: [
    {
      when: {},
      consequence: "device.confirmDeleteProfile",
      why: "the only irreversible command in this catalogue: the card keeps no copy and a paid profile generally needs a fresh activation code from the operator",
    },
  ],
  claim_modem_candidate: [
    {
      when: {},
      consequence: "device.confirmClaimCandidate",
      why: "approving one lets the agent write AT to a port it has only looked at, and a serial endpoint is not necessarily a modem",
    },
  ],
  register_modem: [
    {
      when: {},
      consequence: null,
      why: "adopting a module the agent already identified changes nothing on the hardware; reading its identity is what already happened, and the list it joins is the point",
    },
  ],
  unregister_modem: [
    {
      when: {},
      consequence: "device.confirmUnregister",
      why: "the module stops being polled and leaves the list; what it carried is kept, but an operator who did this by accident would see a working stick vanish",
    },
  ],
  read_logs: [
    {
      when: {},
      consequence: null,
      why: "it returns the agent's own recent output and touches no module; a dialog in front of reading a log is how people stop reading logs",
    },
  ],
  configure_apn: [
    {
      when: {},
      consequence: "device.confirmConfigureApn",
      why: "the module keeps a written context across a reboot, so a wrong APN takes the stick off data until somebody notices and there is no automatic way back",
    },
  ],
  select_operator: [
    {
      when: { mode: "manual" },
      consequence: "device.confirmSelectOperator",
      why: "T030: pinning a module to a PLMN that is not on the air leaves it searching for ever, and the page shows that as 'searching'",
    },
    {
      when: {},
      consequence: null,
      why: "automatic selection is the recovery from a manual one; guarding the way back is how a dialog becomes reflex",
    },
  ],
  set_usbnet_mode: [
    {
      when: { usbnet_mode: "rmnet" },
      consequence: "device.confirmUsbnetRmnet",
      why: "rmnet keeps the QMI port, so the module comes back by itself — but it still re-enumerates on the spot",
    },
    {
      when: {},
      consequence: "device.confirmUsbnet",
      why: "every other mode removes the port the agent finds the module through, so the undo cannot travel back",
    },
  ],
  send_ussd: [
    {
      when: { stage: "cancel" },
      consequence: null,
      why: "cancelling closes a session somebody already opened; it is the way out, not a way in",
    },
    {
      when: { stage: "continue" },
      consequence: "device.confirmUssdReply",
      why: "T030: a menu item is a chargeable choice, and the call-forwarding menus change the subscription",
    },
    {
      when: {},
      consequence: "device.confirmUssdSend",
      why: "T030: a service code can be billed and can change the subscription; nothing asked before this card",
    },
  ],
  /**
   * The free-text box. Its answer comes from `AT_COMMAND_GUARDS` against what
   * was typed, which is why the variant here says `null`: the decision is per
   * command, not per kind, and `deviceCommandGuard` routes it.
   */
  run_at_command: [
    {
      when: {},
      consequence: null,
      why: "decided per typed command by AT_COMMAND_GUARDS; a command that trips no entry is a read or a reversible write",
    },
  ],

  /* ---- esim-panel.tsx ---- */
  list_esim_profiles: [
    { when: {}, consequence: null, why: "ES10c list; it reads the chip's inventory and writes nothing" },
  ],
  read_esim_info: [
    { when: {}, consequence: null, why: "ES10b read-only, which is what its own heading says" },
  ],
  retrieve_esim_notification: [
    {
      when: {},
      consequence: null,
      why: "fetches a notification the card is already holding for delivery; it is the delivery step, not a change of state",
    },
  ],
  initiate_esim_authentication: [
    {
      when: {},
      consequence: null,
      why: "an ES9+ round trip that stops before PrepareDownload; the panel renders the evidence that it stopped",
    },
  ],
  switch_esim_profile: [
    {
      when: {},
      consequence: "esim.confirmSwitch",
      why: "disable one profile and enable another: the card is off the network across the re-registration, and a switch that half-lands leaves no profile enabled",
    },
  ],
  download_esim_profile: [
    {
      when: {},
      consequence: "esim.dlWarn",
      why: "writes a profile into the eUICC and cannot be undone from here; a ppr1/ppr2 profile could never be removed at all",
    },
  ],
};

/**
 * What has to be answered before `kind` is sent with `payload`.
 *
 * Total, and **fail-closed**: a kind with no entry gets a confirmation rather
 * than a free pass. The alternative — an unknown command going straight out —
 * is the failure this whole table exists to stop, and it is exactly what a new
 * command kind added to a panel would do.
 */
export function deviceCommandGuard(
  kind: string,
  payload: Readonly<Record<string, unknown>> = {},
): CommandGuard {
  if (kind === "run_at_command") {
    const guard = atCommandGuard(String(payload.command ?? ""));
    if (guard) {
      return { consequence: guard.consequence, why: `AT_COMMAND_GUARDS: ${guard.id}` };
    }
    return DEVICE_COMMAND_GUARDS.run_at_command[0];
  }
  const variants = DEVICE_COMMAND_GUARDS[kind];
  if (!variants) {
    return {
      consequence: "device.confirmUnknownCommand",
      why: "no entry in DEVICE_COMMAND_GUARDS; fail closed rather than send it unasked",
    };
  }
  for (const variant of variants) {
    if (Object.entries(variant.when).every(([field, value]) => payload[field] === value)) {
      return { consequence: variant.consequence, why: variant.why };
    }
  }
  // Unreachable while every entry ends in an empty `when`, which the test
  // asserts. Fail closed anyway: the day it is reachable is the day somebody
  // deleted the fallback.
  return {
    consequence: "device.confirmUnknownCommand",
    why: "no variant matched, so the fallback was removed from this entry",
  };
}

/* ── A switch is not done because the command said so ────────────────────
 *
 * `/api/esim/switch` reports success in cases where the profile did not change
 * — the vowifi board is fixing that at the edge (T080), and this card must not
 * touch it. What this card owes is a console that does not repeat the claim.
 *
 * So the panel never says "switched". It says which ICCID was asked for, and
 * then whether **a read of the chip taken after the switch** agrees. A read
 * taken before the switch says nothing about it, which is the whole reason
 * this compares timestamps rather than looking at the newest row.
 */

export type EsimSwitchState = "unverified" | "confirmed" | "contradicted";

export type EsimSwitchVerdict = {
  readonly targetIccid: string;
  readonly modemImei: string | null;
  readonly state: EsimSwitchState;
  /** When the chip was read, for `confirmed` and `contradicted`. */
  readonly readAt: number | null;
  /** What the read said the profile's state was, when there was a read. */
  readonly observed: string | null;
};

type SwitchCommand = {
  readonly kind: string;
  readonly status: string;
  readonly completed_at: number | null;
  readonly payload: Readonly<Record<string, unknown>> | null;
};

type ObservedProfile = {
  readonly iccid: string;
  readonly state: string;
  readonly collectedAt: number;
};

/**
 * The newest switch this device was asked for, and whether the chip agrees.
 *
 * `null` when nothing has been switched, which is not the same as "fine".
 */
export function esimSwitchVerdict(
  commands: readonly SwitchCommand[],
  observed: readonly ObservedProfile[],
): EsimSwitchVerdict | null {
  let newest: SwitchCommand | null = null;
  for (const row of commands) {
    if (row.kind !== "switch_esim_profile" || row.status !== "succeeded") continue;
    if (!newest || (row.completed_at ?? 0) > (newest.completed_at ?? 0)) newest = row;
  }
  if (!newest) return null;

  const targetIccid = String(newest.payload?.target_iccid ?? "");
  if (targetIccid === "") return null;
  const imei = newest.payload?.modem_imei;
  const switchedAt = newest.completed_at ?? 0;

  // Strictly after, and only for the profile that was asked for. A reading
  // collected before the command describes the chip as it was.
  let latest: ObservedProfile | null = null;
  for (const profile of observed) {
    if (profile.iccid !== targetIccid || profile.collectedAt <= switchedAt) continue;
    if (!latest || profile.collectedAt > latest.collectedAt) latest = profile;
  }

  return {
    targetIccid,
    modemImei: typeof imei === "string" ? imei : null,
    state: latest === null ? "unverified" : latest.state === "enabled" ? "confirmed" : "contradicted",
    readAt: latest?.collectedAt ?? null,
    observed: latest?.state ?? null,
  };
}

/* ── Secrets that are already stored ─────────────────────────────────────── */

/**
 * What the gateway sends in place of a stored credential, and what it takes
 * back to mean "leave it alone".
 *
 * The console never holds a real credential; it would otherwise be in the
 * page's HTML on every visit.
 */
export const REDACTED_SECRET = "••••••••";

export type SecretInputProps = {
  readonly type: "password";
  readonly value: string;
  readonly placeholder: string;
  readonly autoComplete: "new-password";
  readonly spellCheck: false;
  /** Whether the gateway is holding one. For the caller's own wording, not for the box. */
  readonly stored: boolean;
};

/**
 * The stored-secret behaviour `settings-form.tsx:161-172` already has, as data.
 *
 * "A secret that is already stored shows an empty box with the placeholder as
 * its hint: typing replaces it, leaving it keeps it." Four more password fields
 * are about to be migrated across three cards, and each of them getting to
 * decide what an already-stored secret looks like is how one of them ends up
 * echoing `••••••••` into the value — which then gets *saved* as the new
 * password the first time someone submits the form without touching it.
 *
 * ⚠️ There is no count here, and there must not be. The seven notification
 * channels people talk about are not in any `.tsx`: the fields arrive from the
 * gateway as a runtime `Field[]` (`settings-form.tsx:64`), so a `secret` field
 * is whatever the server says is one. This takes a value and answers about that
 * value.
 */
export function secretInputProps(value: unknown): SecretInputProps {
  const stored = value === REDACTED_SECRET;
  return {
    type: "password",
    // Empty, never the placeholder text: a value of `••••••••` is what gets
    // submitted, and submitting it would be saving eight bullets as the secret.
    value: stored ? "" : String(value ?? ""),
    placeholder: stored ? REDACTED_SECRET : "",
    // Never `current-password`: browsers offer to fill that one, and this box
    // is for a new value.
    autoComplete: "new-password",
    spellCheck: false,
    stored,
  };
}

/* ── Migration guards ────────────────────────────────────────────────────
 *
 * **The stylesheet these guarded against is gone.** `app/globals.css` held
 * 862 lines of hand-written rules in a `legacy` cascade layer; it now holds
 * tokens, a reset and two `@tailwind` directives, and `tokens.test.ts`
 * asserts it defines no class selector at all.
 *
 * The lists below are kept and pinned rather than deleted, and the difference
 * matters. `tokens.test.ts` derives each of them from the stylesheet and the
 * real Tailwind build — which class names the sheet defines, which of those
 * Tailwind also generates, which are declared only under an ancestor. Every
 * one of those derivations now yields the empty set, and asserting that it
 * equals an empty list is a live check that it stays empty. Deleting the
 * lists would delete the derivation with them, and the first hand-written
 * rule to reappear in `globals.css` would be found by nobody.
 */

/**
 * Every `.tsx` under `app/` and `components/`. All of them, now.
 *
 * This list *is* criterion ①, and it is complete: `UNMIGRATED_SOURCES` below
 * is empty and pinned empty, and `tokens.test.ts` asserts the two together
 * account for every `.tsx` under `app/` and `components/`. A new file has to
 * be added here or the ledger test fails, which is what stops a page being
 * written that no guard in this file reads.
 *
 * 🔴 Thirteen `components/ui/*.tsx` were missing from this list until
 * 2026-09-03 — every shadcn component installed after the first batch
 * (alert-dialog, checkbox, dropdown-menu, input, label, select, separator,
 * sheet, sidebar, skeleton, sonner, textarea, tooltip). Nothing noticed,
 * because the ledger test pinned this list's *length* and never compared it
 * to the directory, while its own failure message claimed a neighbouring test
 * did exactly that. Every class in those thirteen files was therefore
 * invisible to "each class used must produce a rule" — including a
 * `list-none` this project added to `sidebar.tsx` by hand, whose absence had
 * put a bullet in front of every nav item and was caught by looking at a
 * screenshot. The ledger test now derives the expected set from the directory,
 * so a file cannot arrive without being read.
 *
 * Three entries draw nothing and are listed anyway, so that the guard rather
 * than a reader's memory is what keeps them that way: `pwa.tsx` and
 * `live-reload.tsx` render `null`, and `app/unknown-tenant/page.tsx` calls
 * `notFound()`. That last one was the only name left on the unmigrated side
 * until the stylesheet was deleted — kept there because promoting a file
 * with no markup would have counted as migration progress with none in it.
 * There is nothing left to be unmigrated *from*, so it moved.
 */
export const MIGRATED_SOURCES = [
  "app/audit/page.tsx",
  "app/devices/[deviceId]/page.tsx",
  "app/devices/page.tsx",
  "app/inbox/[peer]/page.tsx",
  "app/inbox/page.tsx",
  "app/journal/page.tsx",
  "app/layout.tsx",
  "app/login/page.tsx",
  "app/not-a-tenant/page.tsx",
  "app/not-found.tsx",
  "app/page.tsx",
  "app/proxy/page.tsx",
  "app/rules/page.tsx",
  "app/schedule/page.tsx",
  "app/support-ledger/page.tsx",
  "app/sessions/page.tsx",
  "app/settings/page.tsx",
  "app/unknown-tenant/page.tsx",
  "components/card-policies.tsx",
  "components/support-ledger.tsx",
  "components/connection-status.tsx",
  "components/conversation.tsx",
  "components/device-admin.tsx",
  "components/device-console.tsx",
  "components/esim-panel.tsx",
  "components/journal.tsx",
  "components/live-reload.tsx",
  "components/locale-switch.tsx",
  "components/login-form.tsx",
  "components/modem-network.tsx",
  "components/proxy-manager.tsx",
  "components/pwa.tsx",
  "components/send-sms.tsx",
  "components/settings-form.tsx",
  "components/shell.tsx",
  "components/sidebar.tsx",
  "components/sign-out.tsx",
  "components/theme-toggle.tsx",
  "components/ui/badge.tsx",
  "components/ui/button-row.tsx",
  "components/ui/button.tsx",
  "components/ui/card.tsx",
  "components/ui/confirm-dialog.tsx",
  "components/ui/form.tsx",
  "components/ui/output.tsx",
  "components/ui/secret-input.tsx",
  "components/ui/table.tsx",
  "components/ui/tabs.tsx",
  "components/ui/alert-dialog.tsx",
  "components/ui/checkbox.tsx",
  "components/ui/dropdown-menu.tsx",
  "components/ui/input.tsx",
  "components/ui/label.tsx",
  "components/ui/select.tsx",
  "components/ui/separator.tsx",
  "components/ui/sheet.tsx",
  "components/ui/sidebar.tsx",
  "components/ui/skeleton.tsx",
  "components/ui/sonner.tsx",
  "components/ui/textarea.tsx",
  "components/ui/tooltip.tsx",
] as const;

/**
 * Every file under `components/ui/`, what it exports, and which recipes it
 * draws with.
 *
 * This is the answer to "a component was added and nothing checks it", which
 * is the defect the pattern review found twice. The two ledgers above make a
 * new `.tsx` be *classified*; they do not make it be *covered*. A new
 * primitive that is put on the migrated list and reads its classes from a
 * recipe passes everything already written and is still a component no test
 * knows the name of — so deleting its export, or leaving the recipe it was
 * built for unused, is silent.
 *
 * `tokens.test.ts` checks five things from this table: the directory listing
 * equals these keys, every export named here is declared in that file, every
 * recipe named here is an export of this file that is walked as a recipe,
 * every helper named here is an exported function of this file, and every one
 * of those names is actually *referenced* in that component's code — not
 * merely imported, and not merely mentioned in a comment.
 *
 * `helpers` is a separate field because some components never touch a recipe
 * object directly: `button.tsx` asks `buttonClass()` for the combination of
 * base, variant and size, which is where the defaulting lives. Listing the
 * recipe would have been a lie, and listing nothing would have left the file
 * uncovered.
 */
export const UI_PRIMITIVES = {
  "components/ui/badge.tsx": {
    exports: ["Badge", "StateBadge"],
    recipes: ["BADGE"],
    helpers: ["badgeClass", "toneForState"],
  },
  "components/ui/button-row.tsx": {
    exports: ["ButtonRow", "RowActions"],
    recipes: ["BUTTON_ROW"],
    helpers: [],
  },
  "components/ui/button.tsx": {
    exports: ["Button"],
    recipes: [],
    helpers: ["buttonClass"],
  },
  "components/ui/card.tsx": {
    exports: [
      "Card",
      "CardHeader",
      "CardTitle",
      "CardNote",
      "CardActions",
      "CardContent",
      "CardPanel",
      "CardDisclosure",
      "StatRow",
      "StatCard",
      "CardEmpty",
    ],
    recipes: ["CARD", "STAT"],
    helpers: [],
  },
  "components/ui/confirm-dialog.tsx": {
    exports: ["ConfirmDialog"],
    recipes: ["CONFIRM"],
    helpers: ["assertConsequence"],
  },
  "components/ui/form.tsx": {
    exports: [
      "Form",
      "InlineForm",
      "Field",
      "InlineField",
      "Input",
      "Select",
      "Checkbox",
      "FormError",
      "FormHint",
    ],
    recipes: ["FORM"],
    helpers: [],
  },
  "components/ui/output.tsx": {
    exports: ["Output"],
    recipes: ["OUTPUT"],
    helpers: [],
  },
  "components/ui/secret-input.tsx": {
    // No recipe of its own: it is an `Input` plus the stored-secret behaviour,
    // and the behaviour is in `secretInputProps` where a test can reach it.
    exports: ["SecretInput"],
    recipes: [],
    helpers: ["secretInputProps"],
  },
  "components/ui/table.tsx": {
    exports: [
      "Table",
      "TableHead",
      "TableBody",
      "TableRow",
      "TableHeaderCell",
      "TableCell",
      "SpecTable",
      "SpecRow",
    ],
    recipes: ["TABLE"],
    helpers: ["tableCellClass"],
  },
  "components/ui/tabs.tsx": {
    exports: ["TabList", "Tab", "TabPanel"],
    recipes: ["TABS"],
    helpers: [],
  },
} as const;

/**
 * Class names a `.tsx` asks for that nothing anywhere defines. Empty.
 *
 * Not a stylesheet, not the Tailwind build — nothing. Markup carrying one
 * renders as plain unstyled markup, reviews perfectly, and is invisible to
 * every other check in this file, because every other check asks whether a
 * class is *allowed* rather than whether it does anything.
 *
 * The list is frozen at empty and `tokens.test.ts` asserts the *computed* set
 * equals it, which cuts both ways: a card that invents a new dead class fails
 * immediately. The five it was frozen with are worth keeping written down,
 * because none of them was found by reading:
 *
 * - **`card-grid`**, on three pages. The deleted stylesheet had rules named
 *   `.grid` and `.grid-wide`; it never had `.card-grid`. Those pages stacked
 *   their cards in ordinary block flow while their markup said they were
 *   laying them out in a grid. Found by running the check.
 * - **`panel`, `primary`**, on `components/send-sms.tsx`. The one form in this
 *   console that sends a text message was an unstyled block with an unstyled
 *   button from the day it was written until T014.
 *
 * A sixth of the same family did not come through here, because the class
 * *did* exist: `card-span-all` was a real rule (`grid-column: 1 / -1`) that
 * placed nothing, because no container in this console has ever been a grid.
 * `tokens.test.ts` has its own derivation for that shape.
 */
export const CLASSES_WITH_NO_STYLESHEET = [] as const;

/**
 * Class names the stylesheet declares only under an ancestor. Empty, pinned.
 *
 * The one entry this ever held is worth keeping written down, because it is
 * the failure mode the list exists to catch and no amount of reading finds
 * it. `.risk` looked like a class. It was not: the stylesheet declared it only
 * as `.button-row button.risk` and `.row-actions button.risk`, so it coloured
 * a button in those two containers and did nothing anywhere else. The USB-net
 * mode switch — the control that takes a module off the device list — put a
 * `.risk` button inside a form whose class was `inline-form`, and its warning
 * colour was never once drawn.
 *
 * `tokens.test.ts` re-derives the set from `app/globals.css` every run and
 * asserts it equals this list, so the check is live rather than historical: a
 * rule added to that file tomorrow that only bites under an ancestor turns it
 * red. It also holds `BUTTON.variant.risk` to the standard the class failed —
 * it has to generate CSS standing on its own, with no container.
 */
export const CLASSES_NEEDING_AN_ANCESTOR: readonly string[] = [];

/**
 * The other side of the same ledger. Empty, and it can only ever be empty.
 *
 * This held the files still rendered by the hand-written stylesheet. That
 * stylesheet has been deleted, so there is nothing for a file to be unmigrated
 * *from*, and the last name on it — `app/unknown-tenant/page.tsx`, which calls
 * `notFound()` and renders nothing — moved up.
 *
 * Kept rather than removed for the same reason as the lists below it: several
 * tests iterate both ledgers together, and `tokens.test.ts` pins the length of
 * this one at zero. A page added here would be a page declaring that some
 * stylesheet outside the design system is painting it, which is the thing
 * criterion ① says is finished.
 */
export const UNMIGRATED_SOURCES: readonly string[] = [];

/**
 * Utility names a file may not use at all. Empty, pinned, and derived.
 *
 * This held two names for most of the refactor, and the reason is the one
 * piece of cascade-layer behaviour that cost this board real time: a layer
 * settles which rule wins a property *both* rules declare, and does nothing
 * whatever about the properties only the layered rule declares. The old
 * stylesheet's grid rule set a gap and a column template; the utility of the
 * same name sets a display and nothing else. So those two declarations
 * reached every element carrying the utility, through a layer that was
 * supposed to be keeping the old stylesheet away from migrated pages.
 *
 * The rule that could not be written down was “override every property the
 * old rule sets”: true of whatever it happened to set that week, and
 * checkable by nothing. “Do not use the colliding name” was one line of test,
 * and that line is still here — `tokens.test.ts` recomputes the collision set
 * from `app/globals.css` and the real Tailwind build every run. It is empty
 * because that file now defines no class selector at all.
 */
export const FORBIDDEN_IN_MIGRATED_SOURCES: readonly string[] = [];

/**
 * Class names `app/globals.css` defines that Tailwind also generates.
 *
 * Empty, and empty for a structural reason rather than a lucky one: that file
 * defines no class selector at all any more, which `tokens.test.ts` asserts
 * separately. The set is still recomputed from the stylesheet and the real
 * build on every run and compared with this list, so a hand-written rule
 * added to `globals.css` tomorrow that shares a name with a utility fails
 * here — which is the shape of the defect that was live in this repository
 * for the whole of the refactor and was found by measuring, not by reading.
 */
export const LEGACY_UTILITY_COLLISIONS: readonly string[] = [];

/**
 * Classes that legitimately generate no CSS.
 *
 * `group` and `peer` are markers Tailwind reads on other elements' variants.
 *
 * The two below arrived with `components/ui/*.tsx` when those files joined
 * `MIGRATED_SOURCES` on 2026-09-03, and each is here for its own reason. Both
 * are library code from the shadcn registry, so neither is ours to rewrite —
 * but naming them is not the same as excusing them.
 *
 * - `toaster` is Sonner's own hook class. It does reach the stylesheet, just
 *   never as a rule of its own: it appears only as the ancestor in
 *   `.toaster .group-\[\.toaster\]\:bg-background` and its eight siblings.
 *   Sonner currently has no call site in this console.
 *
 * - 🔴 `group/sidebar-wrapper` is a *named* group marker, and **nothing
 *   references it.** A named marker earns its keep through a matching
 *   `group-…/sidebar-wrapper:` variant; there is no such variant in the tree
 *   and no `sidebar-wrapper` anywhere in the built stylesheet. It is dead
 *   boilerplate shipped by the registry, kept verbatim so a future
 *   `shadcn add` does not conflict, and recorded here rather than deleted so
 *   the deadness is written down instead of rediscovered.
 */
export const NON_UTILITY_CLASSES = [
  "group",
  "peer",
  "toaster",
  "group/sidebar-wrapper",
] as const;

export const SETTINGS_FIELD_KINDS = ["text", "secret", "number", "boolean", "list"] as const;
export type SettingsFieldKind = (typeof SETTINGS_FIELD_KINDS)[number];

/** One editable setting, addressed by the dotted path the gateway stores it at. */
export type SettingsField = {
  readonly path: string;
  readonly kind: SettingsFieldKind;
};

/**
 * The notification section's fields.
 *
 * Two of the old product's sections are deliberately absent. HTTPS and its
 * certificate are terminated at the gateway for every tenant at once, so they
 * are not a tenant's to configure; device defaults have no fields yet, and a
 * card with nothing in it only raises a question the page cannot answer.
 */
export const NOTIFICATION_FIELDS: readonly SettingsField[] = [
  { path: "webhook.enabled", kind: "boolean" },
  { path: "webhook.urls", kind: "list" },
  { path: "webhook.secret", kind: "secret" },
  { path: "email.enabled", kind: "boolean" },
  { path: "email.smtp_host", kind: "text" },
  { path: "email.smtp_port", kind: "number" },
  { path: "email.username", kind: "text" },
  { path: "email.password", kind: "secret" },
  { path: "email.from_address", kind: "text" },
  { path: "email.to_addresses", kind: "list" },
  { path: "bark.enabled", kind: "boolean" },
  { path: "bark.urls", kind: "list" },
  { path: "telegram.enabled", kind: "boolean" },
  { path: "telegram.chat_id", kind: "text" },
  { path: "telegram.bot_token", kind: "secret" },
  // The bot half. It shares the token above -- one bot, one credential -- and
  // is otherwise independent: a deployment may want alerts without a bot, or a
  // bot without alerts. Each operator line is "<telegram id>=<account email>",
  // and the account named there is the one the bot acts as, with that account's
  // role. Mapping a chat here grants exactly what that account can already do
  // and nothing more. It groups under `telegram` because it is the same bot.
  { path: "telegram.bot.enabled", kind: "boolean" },
  { path: "telegram.bot.operators", kind: "list" },
  { path: "feishu.enabled", kind: "boolean" },
  { path: "feishu.webhook_url", kind: "text" },
  { path: "feishu.secret", kind: "secret" },
  { path: "wecom.enabled", kind: "boolean" },
  { path: "wecom.webhook_url", kind: "text" },
  { path: "pushplus.enabled", kind: "boolean" },
  { path: "pushplus.token", kind: "secret" },
  { path: "pushplus.topic", kind: "text" },
];

export const SMS_FIELDS: readonly SettingsField[] = [{ path: "hourly_limit", kind: "number" }];

/**
 * The one bound on self-service enrolment.
 *
 * A device presents a certificate and registers itself, which is what makes
 * bringing an edge machine online a matter of installing the agent -- and what
 * means nothing else limits how many one tenant can bring. Leaving the box
 * empty is unlimited, which is what every tenant is until somebody decides
 * otherwise; the gateway refuses a zero rather than reading it as "none".
 */
export const DEVICE_FIELDS: readonly SettingsField[] = [{ path: "device_quota", kind: "number" }];

export const SECURITY_FIELDS: readonly SettingsField[] = [
  { path: "session_ttl_hours", kind: "number" },
];

/**
 * The channels a section can send a live test through, derived rather than
 * listed a second time.
 *
 * Every one of them can be tested, because the gateway has a sender for every
 * one — `settings.NotificationChannels()` and `notify.Registry()` are held
 * equal by a test on that side. Writing the set out by hand is how the last
 * drift started: telegram had fields here and no sender there, so configuring
 * it did nothing at all and said nothing about it.
 */
export function notificationChannels(fields: readonly SettingsField[]): string[] {
  return [...new Set(fields.map((field) => field.path.split(".")[0] as string))];
}

/**
 * A section's fields, gathered by the channel they configure.
 *
 * `name` is the path prefix — `email`, `telegram` — or `null` for a section
 * whose fields are not under one, which is what `hourly_limit` and
 * `session_ttl_hours` are. A `null` group is rendered flat; a named one folds.
 *
 * Folding is the point. Twenty-six inputs in a single column, each channel's
 * host and port and credential and recipients running straight into the next
 * one's, is the single biggest reason this page is hard to read, and it is the
 * one thing its card asks for by name.
 */
export type SettingsGroup = {
  readonly name: string | null;
  readonly fields: readonly SettingsField[];
  /** The `<name>.enabled` switch, when the group has one. */
  readonly enabledPath: string | null;
};

export function groupSettingsFields(fields: readonly SettingsField[]): SettingsGroup[] {
  const order: (string | null)[] = [];
  const byName = new Map<string | null, SettingsField[]>();

  for (const field of fields) {
    const parts = field.path.split(".");
    const name = parts.length > 1 ? (parts[0] as string) : null;
    if (!byName.has(name)) {
      byName.set(name, []);
      order.push(name);
    }
    (byName.get(name) as SettingsField[]).push(field);
  }

  return order.map((name) => {
    const own = byName.get(name) as SettingsField[];
    const enabledPath = name === null ? null : `${name}.enabled`;
    return {
      name,
      fields: own,
      enabledPath:
        enabledPath !== null &&
        own.some((field) => field.path === enabledPath && field.kind === "boolean")
          ? enabledPath
          : null,
    };
  });
}

/** Whether a group's own switch is on, for a folded summary that has to say so. */
export function settingsGroupIsOn(
  group: SettingsGroup,
  values: Record<string, unknown>,
): boolean {
  return group.enabledPath !== null && values[group.enabledPath] === true;
}

/** A stored value at a dotted path. `undefined` for anything that is not there. */
export function readSettingValue(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const key of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * What the form starts holding, from what the gateway sent.
 *
 * A stored list arrives as an array and is edited as one entry per line, which
 * is far easier to paste into than a comma-separated box.
 */
export function settingsFormValues(
  initial: Record<string, unknown>,
  fields: readonly SettingsField[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => {
      const stored = readSettingValue(initial, field.path);
      return [field.path, Array.isArray(stored) ? stored.join("\n") : stored];
    }),
  );
}

/**
 * A box's value, as the type the gateway stores.
 *
 * 🔴 A list splits on newlines **and** commas, and both have to stay. The box
 * was a single line with "one per line" as its placeholder, so the only way to
 * enter two entries was a comma; it is a textarea now, so the natural way is a
 * newline. Accepting one and not the other would turn a change of control into
 * a change of what the operator's existing input means.
 */
export function coerceSettingValue(field: SettingsField, value: unknown): unknown {
  switch (field.kind) {
    case "number": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case "boolean":
      return value === true;
    case "list":
      return String(value ?? "")
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
    default:
      return value ?? "";
  }
}

/**
 * The body of `PUT /v1/settings/{section}`.
 *
 * An untouched secret is left out entirely, which is what tells the gateway to
 * keep the one it is holding. That rule is here rather than in `SecretInput`
 * because it is a request shape, not a control: the box knows how to show a
 * stored credential, and the form knows what an empty box means.
 */
export function settingsDocument(
  fields: readonly SettingsField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.path];
    if (field.kind === "secret" && (value === "" || value === undefined)) continue;
    writeSettingValue(document, field.path, coerceSettingValue(field, value));
  }
  return document;
}

function writeSettingValue(
  document: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let cursor = document;
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1] as string] = value;
}

/**
 * A stored value as a read-only account sees it.
 *
 * A read-only account is not a lesser reader — the gateway refuses its PUT, so
 * the page draws the values instead of the boxes rather than offering a Save
 * button whose only possible outcome is a 403. The on/off words are passed in
 * because they are user-visible text and this console ships in two languages;
 * they were hard-coded English until the page was migrated.
 */
export function displaySettingValue(
  value: unknown,
  words: { readonly on: string; readonly off: string },
): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  if (typeof value === "boolean") return value ? words.on : words.off;
  return String(value);
}

/**
 * What a save is about to do, assembled from what the section actually holds.
 *
 * The credential sentence is appended only when the section has a credential in
 * it, so the SMS section's one number does not warn about passwords. Both
 * halves are complete statements on their own, which is what lets
 * `tokens.test.ts` run each through `consequenceProblem` in both languages.
 */
export function settingsSaveConsequence(
  fields: readonly SettingsField[],
  text: { readonly save: string; readonly secrets: string },
): string {
  const holdsSecret = fields.some((field) => field.kind === "secret");
  return holdsSecret ? `${text.save} ${text.secrets}` : text.save;
}
