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
 * The edge panel (a single self-contained HTML file in a different repository,
 * with no build step and no npm) copies the names and values below by hand.
 * That is the only way the two surfaces can share a visual language, so
 * **renaming a token here is a change to another repository too.**
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
export const COLOR_TOKENS = {
  // Surfaces, from furthest back to nearest the reader.
  //
  // Both themes now step *away* from their canvas as a surface rises, and the
  // step sizes are the same pair of sequences: 1.0735 / 1.0643 / 1.0833 in the
  // dark theme, 1.0713 / 1.0638 / 1.0851 in the light one. Ratios rather than
  // luminance deltas, because near white the same delta is a much smaller hex
  // step and the top of the ladder collapses.
  //
  // 🔴 It collapsed. The light theme used to run `--surface` and
  // `--surface-raised` at the same `#ffffff`, so the raised tier did not exist
  // and the four sites that ask for it — a card header, an entry, the status
  // bar, and a form section — were held apart from the card behind them by a
  // hairline and nothing else. Four values now, in both themes, all four
  // distinct.
  bg: { dark: "#010102", light: "#ffffff" },
  surface: { dark: "#0d0d0d", light: "#f7f7f7" },
  "surface-raised": { dark: "#151515", light: "#f0f0f0" },
  "surface-hover": { dark: "#1d1d1d", light: "#e7e7e7" },
  line: { dark: "#23252a", light: "#dcdcdc" },
  "line-strong": { dark: "#30333a", light: "#c8c8c8" },

  // Text. Four tiers, and the fourth is what this card added.
  //
  // 🔴 The faintest tier was unreadable in both themes and had been since the
  // day it shipped: 3.200 at worst in the dark theme, 2.810 in the light one,
  // while carrying every column heading, every navigation group label, the
  // footer and the hints. Three contrast cards swept the accent and the four
  // status colours and none of them swept the neutral ramp it lives on.
  //
  // Every tier now clears 4.5 on every one of the four surfaces, in both
  // themes: worst 7.007 dark, 7.055 light, over thirty-two pairings. The two
  // ramps are built to the same tier-to-tier ratios — 1.373 / 1.202 / 1.337
  // dark against 1.373 / 1.209 / 1.324 light — so a tier means the same
  // distance from its neighbour whichever theme a reader is in.
  fg: { dark: "#f5f5f5", light: "#0f0f0f" },
  "fg-strong": { dark: "#d3d3d3", light: "#2c2c2c" },
  "fg-muted": { dark: "#c1c1c1", light: "#393939" },
  "fg-faint": { dark: "#a7a7a7", light: "#4b4b4b" },
  // The accent when it is being read rather than filled.
  //
  // T049 needed this to be a second green, because no single green could both
  // carry a button's dark ink and be read on white. That problem is gone with
  // the hue: the accent is `--fg` itself now, which is a text tier by
  // construction, so the two roles cannot disagree and this equals the accent
  // in *both* themes rather than only in the dark one. The entry stays rather
  // than folding into `--fg`, because the role is what the recipes name and a
  // later accent that is not `--fg` must have somewhere to land.
  "fg-accent": { dark: "#f5f5f5", light: "#0f0f0f" },

  // 🔴 **The accent has no hue at all, and that is the decision.**
  //
  // It is `--fg` in each theme, with `--bg` as its ink: a white button with
  // black type in the dark theme, the same pair inverted in the light one,
  // 19.137 and 19.169. Hue is reserved for the four status colours below, so
  // on a console whose job is to report device state the only coloured thing
  // on screen is state. A brand hue would compete with exactly the signal a
  // reader came for.
  //
  // The hover fill moves *down* the neutral ramp rather than up, in both
  // themes: 1.373 away from the rest fill, which is the same separation on
  // both sides, and the ink keeps 13.937 / 13.965 on it. Deriving it the other
  // way — toward the canvas — would be a smaller move than the eye can hold at
  // these luminances.
  accent: { dark: "#f5f5f5", light: "#0f0f0f" },
  "accent-strong": { dark: "#d3d3d3", light: "#2c2c2c" },
  "accent-ink": { dark: "#010102", light: "#ffffff" },
  // The accent when it has to be *seen as a line* rather than filled or read:
  // the focus outline, the current tab's rule, an input's focused edge. Its
  // bar is the 3:1 that WCAG 1.4.11 sets for non-text. T049 needed a third
  // green here because the fill missed that bar at 2.523 on a light page; a
  // neutral accent clears it everywhere by a wide margin — 8.455 dark and
  // 12.180 light on the worst backdrop a focused control sits against — so
  // this equals the fill in both themes. The entry stays for the same reason
  // the readable one does: the role is real even when two roles agree today.
  "accent-edge": { dark: "#f5f5f5", light: "#0f0f0f" },
  // The accent as a tint, behind the current navigation item and an outbound
  // message. Neutral now, because its colour is the accent's.
  //
  // The alpha in each theme is the largest one that costs the status colours
  // nothing, and that is a real edge rather than a round number: at 0.1 this
  // tint doubled is still darker than `--ok-wash` doubled, so the backdrop that
  // binds a status word stays `--ok-wash` over `--ok-wash` over
  // `--surface-hover`; at 0.12 the doubled tint overtakes it, becomes the
  // binding backdrop at #4e4e4e and drags all three down at once — warn 4.945
  // to 4.464, bad 5.058 to 4.566, info 5.077 to 4.583. The light side crosses
  // the same edge between 0.06 and 0.08.
  //
  // ⚠️ T001 described the 0.1 case as the binding backdrop staying "that word's
  // own wash". That is not what happens and the correction matters, because it
  // is the same optimistic reading that hid T010's defect: a status word's own
  // wash is never its worst backdrop — the doubled green is, for all three.
  //
  // Measured against the tint it replaces, the pill is 1.236 -> 1.188 on the
  // dark canvas and 1.099 -> 1.129 on the light one: a little fainter in the
  // dark theme, a little heavier in the light one, neither by enough to change
  // what the tint is for. It is not tuned to match the old weight — the bar
  // above is what picks it.
  "accent-wash": { dark: "rgba(245, 245, 245, 0.1)", light: "rgba(15, 15, 15, 0.06)" },

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
  // does not exist: the outbound bubble is `--accent-wash`, which T001 made
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

export const PAGE = {
  head: "mb-s5 flex flex-wrap items-start gap-s4",
  title: "m-0 text-xl font-semibold tracking-tight text-fg",
  description: "m-0 mt-s1 text-sm text-fg-muted",
  /**
   * The heading's second line when it is an identifier rather than a sentence.
   *
   * A device id under a device's name is read character by character against
   * something else — a log line, a URL — and the proportional face is where a
   * transposed pair hides. Same size and colour as `description`, so it is
   * still the quieter of the two lines.
   */
  identifier: "m-0 mt-s1 font-mono text-xs tabular-nums text-fg-muted",
  /** Up one level, above the title it belongs under. */
  back: "text-sm text-fg-muted no-underline hover:text-fg",
  actions: "ml-auto flex flex-wrap gap-s2",
  /** A load failure above the content it failed to load. */
  error: "m-0 mb-s4 text-sm text-bad",
  /**
   * A sentence between the heading and the content, pointing somewhere else.
   *
   * `/rules` is the only page with one: rules and schedules are the two halves
   * of automation, and the operator looking for the second is already standing
   * on the first. Quieter than the description under the title, because it is
   * about a different page.
   */
  hint: "m-0 text-sm text-fg-muted",
  /**
   * A link inside a sentence.
   *
   * `globals.css:258` sets `a { text-decoration: none }` for every anchor, so a
   * link in running text is indistinguishable from the text around it and has
   * to say it is a link itself. That rule is in the reset, not in the
   * stylesheet that was deleted, so it did not go with it — and preflight
   * removes the underline as well, so there is no version of this file's
   * future in which the anchor gets one for free.
   */
  link: "font-semibold text-fg-accent underline",
  /**
   * The blocks of a page below its heading, one under the other.
   *
   * A gap rather than a margin on each block, so that a block which is
   * sometimes absent — an error line, a section with nothing in it — cannot
   * leave its spacing behind. Wider than the gap *inside* a row of cards: the
   * rhythm is what says "this is a different question".
   */
  stack: "flex flex-col gap-s5",
  /**
   * One question inside a card that holds several.
   *
   * `/proxy` is the reason this exists: a single card carries upstreams,
   * listeners and country rules, each a heading over a list over a form. The
   * old stylesheet said this with `.stack`, and the tighter gap is what keeps
   * a heading reading as the roof of the list under it rather than as another
   * item in the outer sequence.
   */
  section: "flex flex-col gap-s4",
  /** The heading of one of those. `.section-title` in the old stylesheet. */
  sectionTitle: "m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-fg-muted",
  /**
   * A line of context under a control, or standing in for a list with nothing
   * in it yet. Quieter than `FORM.hint`, which is a note about what a control
   * will do.
   */
  note: "m-0 text-sm text-fg-faint",
  /** Context *inside* a line — a reason after a status word, a timestamp. */
  faint: "text-fg-faint",
  /**
   * A reading compared character by character outside a table cell: an
   * address, a country code. Same three declarations as `TABLE.cellMono`,
   * which is where the in-cell version lives.
   */
  mono: "font-mono text-xs tabular-nums",
} as const;

export const CARD = {
  root: "overflow-hidden rounded-lg border border-line bg-surface shadow",
  header: "flex items-center gap-s2 border-b border-line px-s4 py-s3",
  title: "m-0 text-sm font-semibold text-fg",
  note: "text-xs font-normal text-fg-faint",
  actions: "ml-auto flex gap-s2",
  content: "p-s4",
  /**
   * A centred column, laid out with flex.
   *
   * It was flex originally because it had to be: the deleted stylesheet had a
   * rule of its own under the same name as Tailwind's display utility, and it
   * also set a gap and a column template that leaked through the cascade layer
   * into anything carrying the utility. That constraint is gone. This is
   * unchanged anyway — one centred column is what flex says plainly, and
   * re-laying it out to prove a point would be a change nothing measured.
   */
  empty: "flex flex-col items-center gap-s2 px-s5 py-s7 text-center text-fg-muted",
  emptyTitle: "font-semibold text-fg",
  /** Says what would be here. "No rows" leaves the reader unsure it is not broken. */
  emptyDescription: "max-w-measure text-sm",
  /**
   * A card header that folds the card.
   *
   * The settings page renders seven notification channels from a runtime
   * `Field[]`, each with a host, a port, a credential and a recipient, one
   * after another — which is the single biggest reason that page is hard to
   * read. Its card says "group or fold them", and grouping is `CardPanel` per
   * group; folding had nothing, which would have meant that card editing a
   * shared component while six others were in flight.
   *
   * `<details>`, so it works with JavaScript off and needs no state. Nothing
   * in `app/globals.css` names `details` or `summary`, so this recipe is the
   * whole of what draws them. `list-none` removes the disclosure triangle's
   * default marker; the caller supplies its own affordance in the summary.
   */
  disclosureSummary:
    "flex cursor-pointer list-none items-center gap-s2 border-b border-line px-s4 py-s3 text-sm font-semibold text-fg",
  disclosureMarker: "ml-auto text-xs font-normal text-fg-faint",
  /**
   * A column of folding panels inside a card body.
   *
   * `CardContent` pads; it does not space what is stacked in it, and the
   * settings page puts seven `CardDisclosure`s in one card body. The rhythm is
   * the same as the one between a form's own fields — these *are* fields, with
   * a lid on — which is why the value matches `FORM.root` rather than
   * `PAGE.stack`, the wider gap that separates one question from another.
   */
  stack: "flex flex-col gap-s3",
  /**
   * The danger zone: a card holding controls that cannot be taken back.
   *
   * 🔴 **A red outline was the obvious answer and, when this was written, it
   * would not have rendered.** `CARD.root` asked for `border border-line` and
   * computed to zero: preflight is off and the reset standing in for it carried
   * no border style, so `border-bad` on a card would have produced markup that
   * reviews as a warning and paints nothing — the exact defect that card was
   * sent to fix on `device-console.tsx:663`. **That reason is gone.** The reset
   * in `app/globals.css` now carries the style, and an outline here would draw.
   *
   * The wash stays anyway, because the second reason below always was the
   * stronger one.
   *
   * It goes on the *header* rather than the whole card, because what is inside
   * is a row of buttons carrying their own red (`BUTTON.variant.risk`), and a
   * red field behind red outlines reads as one block of noise.
   *
   * ⚠️ Watch the prose here as well as the classes. `lib/tokens.ts` is Tailwind
   * content and Tailwind reads text: the first draft of this comment used an
   * ordinary English plural for "what is inside a box", which is also a bare
   * `display` utility, and it put one more dead rule into the stylesheet the
   * console downloads. The check that caught it is "the stylesheet contains no
   * rule that no file asks for" — and the fix is always to not write the name,
   * which is why this note does not write it either.
   */
  dangerHeader: "bg-bad-wash",
  dangerTitle: "text-bad",
} as const;

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
export const STAT = {
  row: "flex flex-col gap-s4 sm:flex-row",
  root: "flex flex-1 flex-col gap-s1 rounded-lg border border-line bg-surface p-s4 shadow",
  label: "font-mono text-xs font-medium uppercase tracking-eyebrow text-fg-muted",
  /**
   * `tabular-nums` so a count that changes on refresh does not shift the label
   * under it, and `leading-none` because a 2rem number carries its own space.
   */
  value: "font-mono text-2xl font-medium leading-none tracking-tight tabular-nums text-fg",
  hint: "text-xs text-fg-faint",
  /**
   * Only for a number that carries a judgement. Colouring a neutral count
   * spends the reader's attention on something that does not need it, and on a
   * fleet dashboard green is read as "fine".
   */
  tone: {
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
  },
} as const;

export const TABLE = {
  wrapper: "w-full overflow-x-auto",
  table: "w-full border-collapse text-sm",
  head: "",
  body: "",
  headerCell:
    "sticky top-0 border-b border-line bg-surface-raised px-s4 py-s3 text-left font-mono text-xs font-medium uppercase tracking-eyebrow text-fg-faint",
  /**
   * The rule lives on the row rather than on every cell: with
   * `border-collapse`, a row border renders, and `last:border-0` on a row is
   * reachable with a plain variant where "every cell of the last row" is not.
   *
   * 🔴 **This row drew nothing for the whole of this console's life, and the
   * line an operator saw between rows came from the deleted stylesheet's
   * `th, td` rule.** The reset learned to carry a border style first, so both
   * drew for one commit and `border-collapse` had them sharing a pixel; then
   * the cell's line went with the stylesheet and this one was what was left.
   * Measured at both ends: no row on any of the fifteen pages changes height,
   * at 390px or 1100px, in either theme. 40 cells lose a computed bottom
   * border and nothing moves.
   */
  row: "border-b border-line last:border-0 hover:bg-surface-hover",
  headRow: "",
  cell: "px-s4 py-s3 text-left align-top",
  cellMono: "font-mono text-xs tabular-nums",
  cellFaint: "text-fg-faint",
  /**
   * A column that is context rather than the answer, hidden below `sm`.
   *
   * **This is the narrow-screen table decision, and it is made here rather
   * than on the first page card, so that the six page cards after it do not
   * each have to modify `table.tsx`.**
   *
   * The table scrolls sideways inside its card (`wrapper`), and a column marked
   * secondary drops off the phone entirely. What was rejected, and why:
   *
   * - **Card-ification** — turning each row into a labelled block using the
   *   header text — fails on five of this console's twenty-six tables, which
   *   have *no* `<th>` at all (`app/devices/[deviceId]` key/value,
   *   `app/settings`, and three in `esim-panel`). A pattern that silently does
   *   nothing on a fifth of the tables is not a pattern.
   * - **Squeezing every column in** — the widest table here is nine columns of
   *   ICCIDs and UUIDs (`app/devices/page.tsx`). At 390px that is 43px a
   *   column; the values are 19 characters of monospace.
   *
   * Both cells of a column carry it, header and body alike, which is what
   * makes it work on a table with no header row.
   */
  cellSecondary: "hidden sm:table-cell",
  /**
   * A reading and its qualifier on one line inside a cell.
   *
   * An IMEI followed by an "unmanaged" pill, an operator followed by a roaming
   * pill: hand-written badges sit in a cell like that on both the device list
   * and the device page, and every one of them was spaced with an inline
   * `style={{ marginLeft: "var(--s2)" }}` — a gap written twice, in the one
   * place no guard here can read.
   *
   * `flex-wrap` rather than a nowrap row, and this is the part measurement
   * settled: a margin does not wrap, so at 390px the pill sat past the right
   * edge of its own column, and a pill that cannot wrap under an IMEI widens
   * the whole table instead.
   *
   * PM merge note (T009 + T010): both cards invented this recipe independently
   * and byte-identically, as `cellPair` and `cellInline`. Kept under one name;
   * `app/devices/page.tsx` was moved onto it.
   */
  cellInline: "flex flex-wrap items-center gap-s2",
  /**
   * A link inside a cell.
   *
   * The old stylesheet's only rule for an anchor is `color: inherit;
   * text-decoration: none` (`globals.css:162`), so the device name — the one
   * thing on that page you are meant to click — has been rendering as plain
   * text with a pointer cursor. Preflight does not restore that when the legacy
   * layer goes; it hands the browser's own blue-and-underlined default back.
   * Saying it here is both the migration and the fix.
   */
  cellLink: "font-medium text-fg-accent hover:underline",
  /**
   * A column of text with no width limit, allowed to be narrower than its
   * longest word.
   *
   * 🔴 **`word-break`, not `overflow-wrap`, and that is the whole point.**
   * The `overflow-wrap: break-word` utility lets a long word spill onto a
   * second line *after* the box has been sized, and explicitly does not change
   * the box's min-content size. A table cell is sized *from* min-content, so
   * that utility on one changes nothing at all: the column still demands the
   * width of the longest unbroken run in it, and the table grows until it does.
   * `word-break: break-all` does change min-content, so a cell carrying this
   * can be squeezed. (Measured, not read: T014 found the other half of this the
   * expensive way, and naming that utility here shipped a dead rule — see the
   * ledger in `tokens.test.ts`.)
   *
   * For the columns that hold something with no upper bound on width and no
   * spaces to break at — an SMS body carrying a 120-character activation URL,
   * a rule name somebody pasted, a journal payload. Automatic table layout
   * still lays the column out at its content's width when there is room, so
   * this only bites on the screens where the alternative was a table three
   * times the width of the phone.
   *
   * ⚠️ **Only on a column that dominates its row.** Lowering min-content to a
   * single character also lets the column be squeezed *to* a single character
   * when its neighbours want the space, and `/schedule` demonstrated it: eight
   * columns of dates and identifiers turned a task's name into a vertical
   * strip one character wide. A wide grid scrolls sideways in its card
   * instead; that is what `TABLE.wrapper` is for.
   */
  cellWrap: "break-all",
  /**
   * The opposite, and the reason it is needed is not obvious.
   *
   * 🔴 **A Chinese label's min-content width is one character.** CJK text has a
   * break opportunity between any two characters with no hyphen and no marker,
   * so a column holding 保号短信-移动-每月 can be squeezed to the width of 保 and
   * the browser is doing exactly what it is told. When a table's min-content
   * total exceeds its container every column is laid out at min-content, which
   * is how `/schedule` — eight columns at 390px — rendered a task's name as a
   * vertical strip one character wide. Measured; it survived removing
   * `cellWrap`, because `cellWrap` was never what caused it.
   *
   * For a cell holding one atomic reading: a name, a cadence, a timestamp. The
   * table gets wider and scrolls sideways inside its card, which is the
   * behaviour a wide grid is supposed to have.
   *
   * Not the default, though it arguably should be. Four other page migrations
   * are in flight against this same recipe and every table in the console
   * would change shape at once — that is a decision for whoever holds them
   * all, not for one page card. See the note for T015.
   */
  cellNowrap: "whitespace-nowrap",
  /**
   * A second line under a cell's main value: the detail behind a status, the
   * number behind a name. `block` because it hangs under, not beside.
   */
  cellNote: "mt-s1 block font-mono text-xs text-fg-faint",
  /**
   * The other table shape: a two-column field/value specification.
   *
   * Four tables here are `<th>`-less pairs of a name and a reading — the eSIM
   * panel's three, and the device page's host details. Giving those the data
   * grid's uniform padding and sticky header treats a definition list as a
   * result set. The term column shrinks to its content and the detail column
   * takes the rest, so there is no width to invent.
   */
  spec: "w-full border-collapse text-sm",
  specRow: "border-b border-line last:border-0",
  specTerm:
    "whitespace-nowrap px-s4 py-s2 text-left align-top font-mono text-xs font-medium uppercase tracking-eyebrow text-fg-faint",
  specDetail: "w-full px-s4 py-s2 align-top text-sm text-fg",
} as const;

export const BUTTON = {
  base: "inline-flex cursor-pointer items-center justify-center gap-s2 whitespace-nowrap rounded border border-transparent font-semibold transition-all active:translate-y-px focus-visible:outline-none focus-visible:ring focus-visible:ring-accent-edge focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50",
  variant: {
    primary: "bg-accent text-accent-ink hover:bg-accent-strong",
    ghost:
      "border-line-strong bg-transparent text-fg-muted hover:border-accent-edge hover:bg-surface-hover hover:text-fg",
    subtle: "bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg",
    /**
     * Colour is a hint, never the safeguard. The confirmation is. This fleet
     * has commands that strand a module operators cannot reach physically.
     *
     * Filled, and therefore for the one button that carries out the destructive
     * act — the confirm button in the dialog. A row of eight filled red buttons
     * is a row in which nothing stands out.
     *
     * 🔴 **This was the one solid button in the console whose label was not
     * chosen against the fill under it.** The label was plain white on the
     * status red: 3.010:1 in the dark theme and 4.351:1 in the light one, both
     * under the 4.5 its own type asks for, and the dark half is the worse
     * failure by a distance. T046 settled the direction for the green button
     * — keep the fill, choose an ink for it — and this is the same repair on
     * the other filled button. 5.419:1 in dark, 7.122:1 in light.
     */
    danger: "bg-bad text-bad-ink hover:opacity-90",
    /**
     * The outlined red the legacy `.risk` class meant, standing on its own.
     *
     * 🔴 `.risk` has never been a rule. The stylesheet only ever declares it
     * as `.button-row button.risk` and `.row-actions button.risk`
     * (`globals.css:851` and `:946`), so a `.risk` button anywhere else has
     * been rendering in the ordinary colour the whole time — the USB-net mode
     * switch was one, inside an `<form className="inline-form">`, and its
     * warning colour never once appeared in the three years it carried the
     * class. T011 replaced it with this variant and measured the result.
     *
     * ⚠️ The two shapes are **not** equally bad, and T012 found the other one.
     * A `.risk` button that really is inside `.row-actions` renders red with
     * nothing behind it, which is worse than no colour: the red is what tells
     * a reader somebody already thought about this. A variant needs no
     * ancestor, which is the point of moving it here; `tokens.test.ts` derives
     * the "only ever a descendant selector" claim from the stylesheet rather
     * than trusting this comment.
     */
    risk: "border-bad bg-transparent text-bad hover:bg-bad-wash",
  },
  size: {
    md: "min-h-touch px-s4 text-sm",
    sm: "min-h-s6 px-s3 text-xs",
    icon: "min-h-touch w-touch px-0 text-sm",
  },
} as const;

export const BADGE = {
  base: "inline-flex items-center gap-s1 whitespace-nowrap rounded-pill px-s2 py-s1 text-xs font-semibold",
  dot: "size-s1 shrink-0 rounded-full bg-current",
  /**
   * Four tints and a grey. The four are translucent washes of their own hue,
   * so whatever carries them they are always a shade of that hue over it and
   * the pill keeps its shape.
   *
   * 🔴 **The grey one used to be a surface token, and that is why it could
   * disappear.** It was the same token a table row takes on hover, so on a
   * hovered row the pill's fill *was* the row's fill: not low contrast, ratio
   * exactly 1.000, no pill left at all. Two live sites, both with the dot
   * suppressed so the fill was the whole of the shape —
   * `app/audit/page.tsx` renders one on every row of the log, and
   * `app/devices/page.tsx` renders one for the resolved transport.
   *
   * The repair is the category and not the symptom. A line colour is never
   * painted as a surface anywhere in this console — there is no rule that
   * paints one, and the test below derives that rather than trusting this
   * sentence — so a pill filled with one cannot collide with a surface by
   * construction, today or after the next page is written. Measured against
   * all four surfaces it is 1.342 in light and 1.383 in dark, which is at or
   * above every one of the four tinted tones on the same hovered row
   * (1.091–1.135 and 1.211–1.352). A border would have hidden the collision
   * instead of removing it, and cost two pixels on every badge in the console
   * to keep the five tones the same size.
   *
   * The word on it moves up to the plain text tier at the same time, and that
   * is a repair too rather than a side effect: on the old fill it was the
   * faintest tier at 2.688:1 in light, and what these two badges carry is the
   * cell's own value — the action that was logged, the transport that was
   * resolved — which is the one thing in the row a reader came for. An
   * unbadged cell would have rendered it at this tier already. Now 10.895:1.
   */
  tone: {
    ok: "bg-ok-wash text-ok",
    warn: "bg-warn-wash text-warn",
    bad: "bg-bad-wash text-bad",
    info: "bg-info-wash text-info",
    neutral: "bg-line-strong text-fg",
  },
} as const;

/* ── The shell ───────────────────────────────────────────────────────────
 *
 * The chrome every signed-in page renders inside: header bar, grouped
 * navigation, content column, and the source footer.
 */

export const SHELL = {
  root: "flex min-h-dvh flex-col",
  /**
   * The rail and the content column, side by side.
   *
   * A row at every width. Below `md` the rail removes itself and this is a row
   * of one, which costs nothing and means there is no second arrangement to
   * keep in step with the first.
   */
  layout: "flex w-full flex-1",
  /**
   * The column beside the rail: header, then content.
   *
   * `min-w-0` is load-bearing rather than defensive. A flex item's automatic
   * minimum size is its content, so one wide table on one page would push the
   * whole column past the viewport and take the rail off the side of the
   * screen with it — the sort of overflow that only appears on the one page
   * with the widest row in it.
   */
  column: "flex min-w-0 flex-1 flex-col",
  /**
   * Pinned to the top at every width, which it could not be before.
   *
   * ⚠️ **The reason it used to unpin below `sm` is gone, and the old note is
   * kept here in outline because the number in it travelled.** The header
   * carried the navigation, four groups wrapping to about three rows on a
   * phone, and pinning that would have handed a quarter of a 390px screen to
   * navigation permanently. The phone now navigates from `BOTTOM_NAV` and the
   * header is one row of brand and controls, so there is nothing left to
   * unpin for.
   *
   * ⚠️ That old note also read "nine destinations" until 2026-08-27, and the
   * count was never nine — `NAV_GROUPS` holds 4 + 4 + 1 + 1 = ten hrefs, all
   * different. The wrong number reached a goal document and a review note
   * before anybody recounted. **Recount from the array, never from prose**,
   * and note that ten is still ten after this card: what changed is where they
   * are drawn, not how many there are.
   */
  header: "sticky top-0 z-20 border-b border-line bg-surface",
  bar: "mx-auto flex w-full max-w-page flex-wrap items-center gap-s3 px-s3 py-s2 sm:px-s5",
  /**
   * The brand in the header, which withdraws once the rail carries it.
   *
   * `SHELL.railHeader` arrives at the same breakpoint this leaves at, so the
   * console's name is on screen once at every width rather than twice at some
   * of them.
   */
  brand: "flex items-center gap-s2 text-base font-semibold tracking-tight text-fg md:hidden",
  /**
   * The word beside the mark, withheld on the narrowest screens.
   *
   * 🔴 **This line is what makes the header one row, and one row is what makes
   * pinning it honest.** Measured at 390px: the brand is 84px, the controls
   * are 302px, and 84 + 12 + 302 = 398 against 366px of usable width — so it
   * wrapped, and the header stood at 101px. Pinned, that plus the bar would
   * have taken 146px of a 844px screen permanently, where the old three-row
   * header took 156px that *scrolled away*. A pinned two-row header is a
   * worse trade than the arrangement this card replaced, which is the trap
   * `SHELL.header`'s old note was written about.
   *
   * The mark stays, so the console is still identified in the corner; the
   * word returns at `sm`, and the rail spells it out in full from `md`.
   *
   * 🔴 **`sr-only`, not `hidden`, and the difference is the whole link.** The
   * mark beside it is `aria-hidden` — it is a letter in a box, not a word — so
   * `display: none` on the text would leave this anchor with no accessible
   * name at all on exactly the screens the bar is for. `sr-only` takes the
   * word out of the layout and leaves it in the accessibility tree.
   */
  brandName: "sr-only sm:not-sr-only",
  brandMark:
    "flex size-s5 shrink-0 items-center justify-center rounded bg-gradient-to-br from-accent to-accent-strong text-xs font-bold text-accent-ink",
  side: "ml-auto flex flex-wrap items-center gap-s2",
  tenant:
    "inline-flex items-center gap-s2 rounded-pill border border-line bg-surface-hover px-s3 py-s1 text-xs text-fg-muted",
  tenantSlug: "font-semibold text-fg",
  /**
   * The region beside the slug, withheld on a phone.
   *
   * 🔴 **This is what decides whether the header is one row or two, and the
   * header being one row is what makes pinning it affordable.** Measured at
   * 390px: with the region in the chip the bar wraps and the header is 101px;
   * without it, one row. The old header was 156px but scrolled away, so a
   * pinned two-row header would have been a *worse* trade than the thing this
   * card replaced — 146px of a 844px screen gone permanently.
   *
   * The slug is what identifies the tenant; the region is a property of it,
   * and it is still one tap away on the settings page. Withholding the less
   * identifying half of a chip is the smallest cut that buys the row.
   */
  tenantRegion: "hidden text-fg-faint sm:inline",
  /**
   * The desktop rail, which removes itself on a phone.
   *
   * 🔴 **It draws from `NAV_GROUPS`, and so does `BOTTOM_NAV`.** That is the
   * whole point of this pair: the same ten destinations, two arrangements,
   * one array. Two lists that happened to agree on the day they were written
   * are the thing `tokens.test.ts` is set up to reject — it reads both
   * renderers and fails if either one names a destination itself.
   *
   * Below `md` this is `display: none` and the phone bar is what is drawn, so
   * exactly one of the two is ever on screen.
   */
  rail: "hidden w-rail shrink-0 flex-col border-r border-line bg-surface md:flex",
  /**
   * The rail's own head, carrying the brand the slim header gives up on wide
   * screens. `SHELL.brand` withdraws at the same breakpoint this arrives at,
   * so the name is on screen exactly once.
   */
  railHeader:
    "flex items-center gap-s2 border-b border-line px-s4 py-s3 text-base font-semibold tracking-tight text-fg",
  /**
   * A column, scrolling on its own if the groups ever outgrow the viewport.
   */
  nav: "flex flex-1 flex-col gap-s3 overflow-y-auto p-s2",
  /**
   * A rule between groups, not only a caption.
   *
   * `uppercase` does the work in English and nothing at all in Chinese, where
   * a dimmer label sitting next to links of the same size still reads as a
   * twelfth link. The divider is what makes the four groups four groups in
   * both languages. It moved from the leading edge to the top edge with the
   * rail, because a vertical rule between stacked groups separates nothing.
   */
  navGroup: "flex flex-col gap-s1 border-t border-line-strong pt-s3 first:border-t-0 first:pt-0",
  navGroupLabel: "px-s1 font-mono text-xs font-medium uppercase tracking-eyebrow text-fg-faint",
  /** Full touch height, and a glyph in front of the word. */
  navLink:
    "flex min-h-touch items-center gap-s2 rounded px-s3 text-sm text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg",
  navLinkCurrent: "bg-accent-wash font-semibold text-fg-accent",
  /**
   * The glyph itself, at both sizes it is drawn.
   *
   * `shrink-0` because a long label in a narrow rail would otherwise squeeze
   * the glyph rather than wrap, and a squeezed circle reads as a defect.
   */
  navIcon: "size-s4 shrink-0",
  main: "mx-auto w-full max-w-page flex-1 px-s3 py-s4 sm:px-s5 sm:py-s5",
  footer:
    "mx-auto flex w-full max-w-page flex-wrap items-center gap-s3 px-s3 py-s4 text-sm text-fg-muted sm:px-s5",
  footerLabel: "text-fg-faint",
  /** Anchors are `text-decoration: none` globally, so a bare link has to say so. */
  footerLink: "underline transition-colors hover:text-fg",
} as const;

/* ── The phone's bottom bar ──────────────────────────────────────────────
 *
 * 🔴 **The second renderer of `NAV_GROUPS`, and it is not allowed to hold a
 * list of its own.** `SHELL.rail` draws the same array as four labelled
 * groups; this draws four of them as cells with a glyph, and puts the other
 * six behind an overflow trigger. Which four is `NavItem.bottomSlot`; which
 * six is everything without one, by subtraction. Neither renderer names a
 * destination, and `tokens.test.ts` fails if either starts to.
 *
 * **Five cells, because of arithmetic and not taste.** 390px is the narrowest
 * phone this console is checked on. Ten destinations laid out at once give
 * each one 39px, and `SIZE_TOKENS.touch` — the target size the operator signed
 * off — is 44px. Five give 78px. ⚠️ **Both are budgets rather than
 * measurements** — the row draws no cell of 78, and `BOTTOM_NAV.cell` carries
 * the shape it does draw. `bottomNavCellWidth()` computes both, and the suite
 * recomputes them rather than quoting them, so a sixth cell fails a test
 * instead of shipping a target nobody can hit.
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

export const BOTTOM_NAV = {
  /**
   * ⚠️ Shares this exact corner with `PWA.connection.bar`, the connection
   * banner. The classes that do the pinning — the positioning, the edge, the
   * full width — are identical word for word in both recipes; what differs is
   * the paint (this one is the surface tone, the banner is the status red) and
   * the responsive hide, which only this one carries. That hide is why the
   * corner is contested on a phone and nowhere else: measured at 1280x800,
   * signed in and offline, the banner is present and this bar is not in the
   * corner at all. The other two conditions are a dropped network and a
   * signed-in tenant, since `app/layout.tsx` gates both components on that.
   *
   * 🔴 **This bar sits one layer below the banner, and that is deliberate.**
   * `app/layout.tsx` draws the banner first and this bar last. While both sat
   * on the same layer the later one won, and the bar painted over the alert.
   * Measured in a browser at 390x844, signed in, network dropped: the banner
   * occupied the strip from 787 to 844, this bar from 799 to 844, and of 400
   * points sampled across the banner the bar was the topmost element at 320 of
   * them. All four of the banner's own runs of text — the sentence, the
   * explanation, the clock, and the reload control — came back from
   * `elementFromPoint` as something inside this bar, so the alert was not
   * merely dimmed: the first three sat under one of the four links, and the
   * reload control sat under the overflow trigger, so pressing reload opened
   * the sheet.
   *
   * A banner nobody can see is worse than a nav briefly covered. That
   * judgement is what decides the tie, and it now decides it in
   * `TAILWIND_Z_INDEX` rather than by accident of source order: this recipe
   * takes the 10, and the banner keeps the 20.
   *
   * 🔴 **The layer moved and the source order did not, on purpose.** The other
   * way to settle this is to draw this component before the banner — but the
   * source footer's clearance depends on this component being drawn *after*
   * the footer, and `tokens.test.ts` pins that order for exactly that reason.
   * Reordering to fix one would have broken the other. Nothing else is left
   * wanting this corner: the sticky header holds the 20 at the opposite edge
   * (measured at 390x844 it runs 0 to 65, this bar 799 to 844), and the
   * confirmation dialog is on the 30 because it is meant to cover everything —
   * which is the other reason the banner was not simply raised to meet it.
   *
   * ⚠️ Before adding a third thing to this corner, give it a layer of its own.
   * `tokens.test.ts` derives the corner's occupants rather than listing them,
   * and requires that no two of them share one.
   */
  bar: "fixed inset-x-0 bottom-0 z-10 border-0 border-t border-solid border-line bg-surface md:hidden",
  /**
   * `relative` so the sheet can hang off the whole bar rather than off the one
   * 78px cell that opens it.
   */
  row: "relative mx-auto flex w-full max-w-page items-stretch",
  /**
   * One cell, grown from a zero basis so that nobody divides 390 by 5 in a
   * class name.
   *
   * ⚠️ **The five are not equal: measured, they span 8.02px.** At 390 the row
   * draws 79.59 / 79.61 / 79.59 / 79.61 / 71.59, summing to 389.99, and no
   * cell is the 78 that `bottomNavCellWidth()` returns — that function is the
   * budget the design was chosen against, not a description of the boxes.
   *
   * The 8.02 is this recipe's own horizontal padding, `SPACE_TOKENS.s1` a
   * side. Under the inherited border-box rule a zero basis cannot fall below
   * an item's own padding, so the four links enter the share-out already
   * carrying 8px while the overflow trigger carries nothing — its padding sits
   * on the `<summary>` within it rather than on the cell. The five then split
   * what is left, (390 − 32) / 5 = 71.6 apiece, which puts the links at 79.6
   * and the trigger at 71.6. Measured from the other side as well: take this
   * padding away and all five come out at exactly 78.00.
   *
   * 🔴 **Not a defect — what would make it one is the floor, not the span.**
   * The narrowest cell is 71.59 against a `SIZE_TOKENS.touch` of 44.
   *
   * 🔴 **The floor is stated, and stating it is what stops the text deciding
   * it.** A share of the row with no minimum of its own has its content's, so
   * the longest label in the row used to settle what every other cell was left
   * with. Measured: a twenty-one-letter German compound took the four links to
   * 128.77 apiece and left the overflow trigger — the only way to the other six
   * destinations — 24.00px wide, with that trigger and the fourth link both
   * past the right-hand edge of a 390px screen, and the bar 13.19px taller than
   * the gutter that holds the source footer clear of it. Neither language
   * shipped today can reach any of that; the narrowest cell zh or en can make
   * is 71.59, so it is the next translation that meets it.
   *
   * Stating a minimum *replaces* the content-based one rather than adding to
   * it, so the label loses that power outright — and what it is replaced by is
   * `SIZE_TOKENS.touch`, the same token the height is floored at, so there is
   * no second number here to keep in step.
   *
   * ⚠️ **Nothing was taken from the other four cells to pay for it.** What they
   * gave up is the claim to be as wide as their longest word, which was never a
   * claim about the target size. Measured after: zh and en draw the same five
   * widths to the hundredth of a pixel, and the German label now draws them
   * too. The arrangement holds down to a 220px viewport, below which five
   * targets no longer fit side by side at all. Geometry and the mutation run
   * are in the T012 note under `docs/goals/vodoge-shape-nav/notes/`.
   */
  cell: "flex min-h-touch min-w-touch flex-1 flex-col items-center justify-center gap-s1 px-s1 text-xs text-fg-muted transition-colors hover:text-fg",
  cellCurrent: "font-semibold text-fg-accent",
  /**
   * The label, in an element of its own so that there is something to clip.
   *
   * With the cell's width settled by the floor above, a label longer than its
   * cell still has to go somewhere, and both places it can go are defects. A
   * bare text node paints across its neighbours. A wrapping one makes the row
   * taller — and the gutter below is pinned at one target size, so a bar that
   * grows is a bar that no longer matches the gutter holding the source footer
   * clear of it. That is the 45 → 58.19px measured on the long label, and the
   * 13.33px of footer it buried.
   *
   * Capped to the cell and cut off with an ellipsis, it does neither. Measured
   * with the twenty-one-letter label in place: every cell reports its scrollable
   * width equal to its visible width, so no ink leaves any cell, and the bar
   * stays level with its gutter at every viewport from 220 to 767.
   *
   * ⚠️ **The sheet's rows deliberately do not carry this.** They are full
   * width with a whole viewport to lay a word out in, and cutting them off
   * would shorten labels that fit.
   */
  cellLabel: "max-w-full truncate",
  /**
   * The trigger, which is a `<summary>`.
   *
   * `list-none` removes the disclosure marker; the glyph below is the
   * affordance instead. Same arrangement as `CARD.disclosureSummary`, and the
   * same reason: `<details>` works with JavaScript off and needs no client
   * boundary, which is what keeps this whole bar server-rendered and its
   * labels in the language the server resolved.
   *
   * It repeats `BOTTOM_NAV.cell` rather than composing it because it is the
   * one cell that must **not** pick up a press or an `aria-current`. Sharing
   * the recipe and subtracting from it is how the press would arrive here the
   * next time someone adds one to `cell`.
   */
  moreTrigger:
    "flex min-h-touch w-full cursor-pointer list-none flex-col items-center justify-center gap-s1 px-s1 text-xs text-fg-muted transition-colors hover:text-fg",
  /**
   * The `<details>` itself, taking a cell's share of the row — a share, not a
   * width: carrying no padding of its own, it settles 8.02px under the four
   * links. `BOTTOM_NAV.cell` holds the measurement and why that is the shape
   * this row is supposed to have rather than a defect.
   *
   * 🔴 It carries the same floor as the other four, and it is the cell that
   * needed it: the remainder of the row lands here, so this is the one that
   * collapsed — to 24.00px — when a long label made the four links greedy.
   */
  more: "flex min-w-touch flex-1",
  /**
   * The sheet, opening upwards out of the bar.
   *
   * `bottom-full` is why `TAILWIND_INSET` has a `full` step: the bar's height
   * is a touch target plus a device inset, which is not a number this scale
   * could have held.
   */
  sheet:
    "absolute inset-x-0 bottom-full flex max-h-panel flex-col gap-s1 overflow-y-auto border-b border-line bg-surface p-s2 shadow-lg",
  sheetLabel: "px-s2 py-s1 font-mono text-xs font-medium uppercase tracking-eyebrow text-fg-faint",
  sheetLink:
    "flex min-h-touch items-center gap-s3 rounded px-s3 text-sm text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg",
  sheetLinkCurrent: "bg-accent-wash font-semibold text-fg-accent",
  /**
   * The gutter, and the reason it is an element rather than padding.
   *
   * A bar with `position: fixed` covers whatever the document ends with, and
   * what this document ends with is the source footer — the one thing on the
   * page addressed to people who are not signed in. Padding on the shell root
   * would not reach it, because `app/layout.tsx` draws the footer as a sibling
   * of the shell and not inside it; padding on the root itself would also land
   * on `/login`, which has no bar to clear.
   *
   * So the gutter is drawn after the footer, by the same component that draws
   * the bar, and it is exactly as tall: one border plus a touch target plus
   * the same inline inset. It goes away with the bar at `md`.
   *
   * ⚠️ **The content-box sizing on this line is the whole of it.** Measured:
   * under the inherited border-box rule the gutter came out 44px against the
   * bar's 45px, and the source footer sat 0.97px underneath the bar. The bar's
   * height is its 44px touch row *plus* its 1px top border, because nothing
   * constrains it; the gutter's minimum was swallowing the border inside the
   * same 44px. Sizing to the content makes the minimum apply to the content,
   * so both boxes are one border plus a touch target plus the same inline
   * inset — equal by construction rather than by two numbers kept in step.
   *
   * ⚠️ The utility's own name is deliberately not written in this comment.
   * This file is Tailwind content, so spelling it here would make the rule
   * ship whether or not any recipe still asks for it — and the check that
   * finds an orphaned rule would then answer for the prose instead of for the
   * layout. That is not hypothetical: it happened, and it made a mutation
   * that removes this class look as though it had been caught by a height
   * check when nothing here can measure a height.
   */
  spacer: "box-content min-h-touch border-0 border-t border-solid border-transparent md:hidden",
} as const;

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

export const CENTERED = {
  /**
   * Fills what is left of the shell root, rather than claiming the viewport.
   *
   * 🔴 **It asked for `min-h-dvh` until this card, and that made `/login`
   * taller than the screen by exactly the height of the footer.** The footer
   * moved out of the shell so that a stranger could see the source links, and
   * it is drawn as the last child of `SHELL.root` — which is itself
   * `min-h-dvh`. A child also demanding a full viewport therefore adds the
   * footer's height on top of it, and a page whose entire job is one centred
   * card scrolled.
   *
   * `flex-1` asks for the same thing the layout actually meant: everything the
   * root has that the footer is not using. The card stays centred in it, and a
   * card taller than the space still grows, because a flex item's automatic
   * minimum is its content.
   */
  root: "flex flex-1 flex-col items-center justify-center p-s5",
  card: "flex w-full max-w-measure flex-col gap-s4 rounded-lg border border-line bg-surface p-s6 shadow-lg",
  brand: "flex items-center gap-s2 text-lg font-semibold text-fg",
  hint: "m-0 text-sm text-fg-muted",
} as const;

/**
 * Form parts.
 *
 * Preflight is off, and nothing else styles a bare `form`, `label`, `input`,
 * `select` or `textarea` any more — the stylesheet that did has been deleted.
 * So every property that has to differ is spelled out here rather than left
 * to inherit, and there is no second answer anywhere for what a control looks
 * like.
 *
 * The one thing a control does *not* get from this table is its type. A user
 * agent gives a form control Arial at 13.33px with `line-height: normal`
 * whatever its ancestors say, and the deleted stylesheet was quietly handing
 * all four elements `font: inherit` by element name. The reset in
 * `app/globals.css` says it now, once, in preflight's own words. That is not
 * an aesthetic point: measured across the fifteen pages, taking it away moves
 * 176 buttons, 78 inputs, 12 selects and 4 textareas, and the boxes that size
 * to their text move with them.
 *
 * `focus` deliberately says nothing about `outline`: the global
 * `:focus-visible` ring is what draws it.
 */
export const FORM = {
  root: "flex flex-col gap-s3",
  label: "flex flex-col gap-s1 text-sm font-medium text-fg-muted",
  input:
    "min-h-touch w-full rounded border border-line-strong bg-bg px-s3 text-sm text-fg placeholder:text-fg-faint focus:border-accent-edge disabled:opacity-50",
  /**
   * The same box as `input`, minus the placeholder a `select` cannot have.
   * The native arrow is left alone: removing it means drawing and positioning
   * a replacement, and a picker that does not look like the platform's picker
   * is the kind of polish that costs an operator a tap.
   */
  select:
    "min-h-touch w-full cursor-pointer rounded border border-line-strong bg-bg px-s3 text-sm text-fg focus:border-accent-edge disabled:opacity-50",
  /**
   * A `select` inside a table cell rather than inside a field.
   *
   * One of the nine selects in this console lives in a row — the per-card
   * routing choice at `card-policies.tsx:100` — and a full-width, full-height
   * control there widens a five-column table by whatever the widest option is.
   * `w-auto` puts it back to its content, and the height comes down to match
   * the small buttons the other cells in that row carry. It stays above 32px,
   * which is the smallest thing the deleted stylesheet ever asked a finger to
   * hit.
   */
  selectCompact: "min-h-s6 w-auto px-s2 text-xs",
  /**
   * Padded on all four sides rather than only the sides, because the text
   * starts at the top rather than being centred on one line. Height comes from
   * the caller's `rows`, which is a count of lines and therefore survives a
   * change of type scale; a `min-h-*` here would not.
   */
  textarea:
    "w-full resize-y rounded border border-line-strong bg-bg p-s3 text-sm text-fg placeholder:text-fg-faint focus:border-accent-edge disabled:opacity-50",
  error: "m-0 text-sm text-bad",
  /** Not an error. `.hint` in the old stylesheet: a note under a control. */
  hint: "m-0 text-sm text-fg-muted",
  /**
   * A checkbox and its label on one line.
   *
   * 🔴 The checkbox needs its *own* size, and this is not cosmetic. Before the
   * stylesheet went, a checkbox escaped its `input { width: 100% }` rule only
   * because a second rule pinned one to 1rem inside a class that was in the
   * same doomed layer. Both of this console's checkboxes
   * (`card-policies.tsx:89` inside a table cell, `settings-form.tsx:153`) would
   * have stretched to fill their container the day it was deleted. They did
   * not, because the size is stated here.
   */
  inlineLabel: "flex items-center gap-s2 text-sm font-medium text-fg",
  /**
   * `min-h-s4` as well as `size-s4`, and it is not redundant.
   *
   * The deleted rule was `input, select, textarea { min-height: var(--touch) }`,
   * and `min-height` beats `height` no matter which layer either comes from.
   * Measured at 390px with only `size-s4`, the
   * checkbox rendered **16px wide and 44px tall** — a stretched box in a table
   * cell, which is the same defect as the `width: 100%` one, on the other axis.
   * Found by measuring, not by reading.
   */
  checkbox: "size-s4 min-h-s4 shrink-0 cursor-pointer accent-accent disabled:opacity-50",
  /**
   * A field and its own submit, side by side — sixteen of these across four
   * components, five in `device-console.tsx` alone, and no recipe until now.
   *
   * `items-end` so the button's baseline lines up with the input rather than
   * with the label above it.
   */
  inline: "flex flex-wrap items-end gap-s3",
  /**
   * The field inside an inline form: the whole row on a phone, the remainder
   * of the row above `sm`.
   *
   * The deleted rule was a 16rem flex basis under an ancestor class, which
   * could not be written here: 16rem is not on any scale. Saying it as a
   * breakpoint
   * instead is both expressible and better: below `sm` the button wraps under
   * a full-width field rather than being squeezed beside it.
   */
  inlineField: "w-full sm:w-auto sm:flex-1",
} as const;

/**
 * A row of buttons that wraps instead of stretching the column.
 *
 * Twenty sites across six components, and T021 named it the main source of
 * horizontal overflow — the device detail page renders three of these at once.
 * `rowActions` is the same arrangement inside a table cell; it is a separate
 * name because the buttons in it are `size="sm"` and because the seven tables
 * that have one need to be findable.
 */
export const BUTTON_ROW = {
  root: "flex flex-wrap items-center gap-s2",
  rowActions: "flex flex-wrap items-center gap-s2",
} as const;

/**
 * Verbatim output: a diagnostic's reading, a command's JSON, a journal payload.
 *
 * Scrolls inside its own box in both directions rather than stretching the
 * page — `/journal`'s payloads have no width limit and neither does an AT
 * transcript. `m-0` is load-bearing: preflight is off, so the browser's own
 * `pre { margin: 1em 0 }` is still live and the old `.output` had to override
 * it too.
 */
export const OUTPUT = {
  root: "m-0 mt-s2 max-h-panel overflow-auto rounded bg-bg p-s3 font-mono text-xs text-fg",
} as const;

/**
 * The command log: what was asked for, what came back, and when.
 *
 * An `<ol>`, because the order is the point, and every one of `list-none`,
 * `m-0` and `p-0` is load-bearing rather than tidiness — preflight is off, so
 * the browser's own decimal markers and 40px indent are still live and the old
 * `.command-log` had to turn all three off too.
 *
 * 🔴 **No border on `entry`, and the reason has changed.** The rule it replaces
 * was a 1px line, and when this was written a Tailwind border-width utility
 * here computed to zero: preflight is off and the reset standing in for it
 * carried no border style. **That is no longer true** — the reset in
 * `app/globals.css` carries it now and a line here would draw.
 *
 * The raised surface stays. A log is a stack of dozens of these, and a stack of
 * outlined boxes inside an outlined card is three nested rectangles deep; the
 * surface says the same thing with one less line. The old reason is recorded
 * because it is the reason the first version had no border, and a reader who
 * finds only the new one will think the choice was always aesthetic.
 */
export const LOG = {
  list: "m-0 flex list-none flex-col gap-s3 p-0",
  entry: "rounded bg-surface-raised p-s3",
  /** The command's name, its status pill and its timestamp on one line. */
  head: "flex flex-wrap items-center gap-s2",
} as const;

/**
 * Tabs, which no card owned.
 *
 * T010 is told to build a four-tab skeleton for the device page and T011 to
 * fill the other two, and neither card's file list contains a tabs component —
 * so both would have written one, in different files, and the second would
 * have had to redo the first. That is the parallelism this card exists to
 * protect, so the component lands here whether or not the eight-primitive list
 * mentioned it.
 *
 * One recipe for both elements. A tab that changes the URL is an `<a>`, which
 * keeps a server-rendered page a server component and keeps a tab
 * deep-linkable; a tab that switches a pane inside an already-client component
 * is a `<button>`. `border-x-0 border-t-0` was not decoration when it was
 * written: preflight was off and the stylesheet that has since been deleted
 * gave every bare `button` a 1px border on all four sides. It is belt over
 * braces now, for the same reason as the two below.
 *
 * 🔴 **`border-solid` and `border-0` here are history, and they are kept on
 * purpose.** They were the fix for a real defect and they are now belt over
 * braces: the reset in `app/globals.css` carries the style and the zero width
 * for every element, so this strip would draw without them. They stay because
 * removing them is a change to what the browser is told with nothing measured
 * gained, and because they are what the day this was found looked like.
 *
 * What was found, at 390px, in a browser: `getComputedStyle` on the strip and
 * on a tab both reported no border at all — **the rule under the tab strip and
 * the accent underline that says which tab is selected were not being drawn.**
 * The tab that renders as a `<button>` was fine and the one that renders as an
 * `<a>` was not, because the deleted stylesheet handed every bare `button` a
 * border shorthand and handed `a` nothing. One recipe, two elements, and the
 * defect was invisible in exactly the half that was tried first. Both halves
 * are drawn by the reset now, so there is no half left to be lucky in.
 *
 * And the second half of the fix, which the first version missed: saying only
 * that the border is solid turns all four sides on, and the initial per-side
 * width is `medium` — 3px. The measurement came back with a 3px rule along the
 * top of a strip that had asked for one along the bottom. A style and a zero
 * width are a pair; the reset now states both, once, for everything.
 */
export const TABS = {
  list: "flex flex-wrap items-center gap-x-s4 border-0 border-b border-solid border-line",
  tab: "inline-flex min-h-touch cursor-pointer items-center whitespace-nowrap rounded-none border-x-0 border-t-0 border-b-2 border-solid border-transparent bg-transparent px-s1 text-sm font-semibold text-fg-muted transition-colors hover:text-fg",
  /** The underline, not a fill: a filled tab competes with the primary button. */
  tabCurrent: "border-accent-edge text-fg",
  panel: "pt-s4",
} as const;

/**
 * The confirmation dialog, and the reason it is a component at all.
 *
 * Every confirmation in this console today is `window.confirm()`, which can
 * only show one string. That is why `device.confirmDisruptive` — one sentence,
 * shared by seven commands, naming none of them — is what stands between an
 * operator and `restart_modem`, which can strand a module in `+CFUN: 7` that
 * nobody can reach to power-cycle. A dialog with a *place* for the consequence
 * is what makes writing one down cheaper than not.
 *
 * `z-30` because the header is sticky at `z-20`.
 */
export const CONFIRM = {
  overlay: "fixed inset-0 z-30 flex items-center justify-center p-s4",
  /** Its own element rather than a tint on the overlay: `var()` takes no alpha. */
  scrim: "absolute inset-0 bg-bg opacity-90",
  panel:
    "relative flex w-full max-w-measure flex-col gap-s4 rounded-lg border border-line bg-surface p-s5 shadow-lg",
  title: "m-0 text-base font-semibold text-fg",
  /** The paragraph that says what will happen. Never empty — see `assertConsequence`. */
  consequence: "m-0 text-sm text-fg-muted",
  question: "m-0 text-sm font-semibold text-fg",
  actions: "flex flex-wrap justify-end gap-s2",
} as const;

/* ── The two PWA affordances ─────────────────────────────────────────────
 *
 * An install offer and a connection banner. They are deliberately at opposite
 * ends of the page and never share an edge, because they can be on screen at
 * the same time — a console being read offline is exactly a console somebody
 * would rather have installed — and two overlapping fixed bars is how one of
 * them becomes invisible.
 */

export const PWA = {
  /**
   * The install offer: in the normal flow, above the header, not floating.
   *
   * A fixed chip would cover content on the one screen size where content is
   * scarcest, and it would have to fight the banner below for the same corner.
   * In the flow it pushes the page down by one row and can never obscure
   * anything.
   *
   * It needs no top safe-area inset, and that is not an oversight: it renders
   * only when the console is *not* installed, and an uninstalled console is
   * being read inside browser chrome, where `env(safe-area-inset-top)` is zero
   * because the browser's own toolbar already occupies that strip.
   */
  install: {
    bar: "flex flex-wrap items-center gap-x-s3 gap-y-s2 border-0 border-b border-solid border-line bg-surface-raised px-s3 py-s2 text-sm sm:px-s5",
    text: "flex flex-wrap items-baseline gap-x-s2 gap-y-s1",
    title: "font-semibold text-fg",
    hint: "text-fg-muted",
    actions: "ml-auto flex items-center gap-s2",
  },
  /**
   * The connection banner: fixed to the bottom, in the status red.
   *
   * Bottom rather than top because the header is already sticky up there and
   * an alert that has to fight for the same strip loses. Red rather than amber
   * because it is not a warning about something that might happen — every
   * number above it is already out of date.
   *
   * ⚠️ It shares that bottom corner with the phone navigation bar, which is
   * why this recipe holds the 20 of `TAILWIND_Z_INDEX` while `BOTTOM_NAV.bar`
   * takes the 10. Lowering this one to meet it puts the alert back underneath
   * a navigation cell — measured, and written up on `BOTTOM_NAV.bar`.
   */
  connection: {
    bar: "fixed inset-x-0 bottom-0 z-20 border-0 border-t border-solid border-bad bg-bad-wash shadow-lg",
    inner:
      "mx-auto flex w-full max-w-page flex-wrap items-center gap-x-s3 gap-y-s1 px-s3 py-s3 text-sm sm:px-s5",
    mark: "size-s2 shrink-0 rounded-pill bg-bad",
    title: "font-semibold text-bad",
    detail: "text-fg-muted",
    /** Monospace so the clock does not reflow while the rest of the row does. */
    time: "font-mono font-semibold text-fg",
    actions: "ml-auto flex items-center gap-s2",
  },
} as const;

/**
 * The inbox, which is the one screen that is read on a phone.
 *
 * Two shapes live here. The thread list and the contact list are ordinary data
 * grids and use `TABLE`; what they need from this recipe is the one cell whose
 * content has no width at all — the body of the last message. The conversation
 * is the other shape, and it is not a table: messages alternate sides, so the
 * direction of a message is carried by where it sits as well as by its colour,
 * which is what a monochrome screen and colour-blind vision get.
 *
 * The legacy stylesheet drew a bubble at `min(42rem, 82%)`. That is an
 * arbitrary value twice over and this system rejects both halves, so the
 * bubble is capped at the readable measure instead — which is the same answer
 * the empty states and the confirmation panel already give, and it is the
 * answer that does not need a number chosen for it.
 */
export const INBOX = {
  /**
   * The widest cell in this console with nothing bounding it.
   *
   * A thread's last message is arbitrary text in a four-column table read at
   * 390px. Chinese wraps at any character, so the ordinary case is fine and
   * looks like it needs nothing; a URL or an ICCID has no break opportunity at
   * all and sets a min-content width the table has to honour.
   *
   * 🔴 The `overflow-wrap` utility is **not** enough and reads as though it is.
   * `overflow-wrap: break-word` breaks a line that would otherwise overflow; it
   * does not change the element's min-content size, and min-content is what a
   * table cell and a flex item are sized from. Measured at 390px with only that
   * one, a single activation URL made this table 737px inside a 343px wrapper.
   * `word-break: break-all` is what lowers min-content to one character — the
   * legacy stylesheet said `overflow-wrap: anywhere`, which is the same idea
   * and has no utility of its own in Tailwind 3.
   *
   * It is here rather than on `TABLE` because most cells should *not* break a
   * value an operator is comparing character by character.
   */
  lastBody: "break-all",
  /** Which way the last message went, which is what says who is waiting. */
  lastDirection: "text-fg-faint",
  /** Unread is emphasised where the reader is already looking: the body. */
  lastUnread: "font-semibold text-fg",
  lastRead: "text-fg-faint",
  /** The number under a named contact, and the number beside a named heading. */
  peerUnder: "font-mono text-xs tabular-nums text-fg-faint",
  /**
   * The message count and the two badges that qualify it, in one cell.
   *
   * The old markup put `margin-left: var(--s2)` on each badge as an inline
   * style, which is a gap that only exists on the second and third things in
   * the cell and disappears when the badges wrap.
   */
  countCell: "flex flex-wrap items-center gap-s2",
  backLink: "text-sm text-fg-muted no-underline hover:text-fg",
  /** A heading that is a phone number rather than a name. */
  titleMono: "font-mono",

  /* ── One conversation ───────────────────────────────────────────────── */

  /** The controls above the thread, then the thread. */
  stack: "flex flex-col gap-s4",
  list: "m-0 flex list-none flex-col gap-s3 p-0",
  message: "max-w-measure rounded-lg border border-solid border-line p-s3",
  /** Received: at the left, on the page's own surface. */
  messageIn: "self-start rounded-bl bg-surface",
  /** Sent: at the right, tinted with the accent. */
  messageOut: "self-end rounded-br bg-accent-wash",
  /**
   * Breaking the word is for the same reason as `lastBody`, and it was measured
   * here too: with only the `overflow-wrap` utility, the outbound bubble
   * carrying a long URL rendered 384px wide inside a 311px column and hung 41px
   * off the left edge of its own card. A flex item with `self-end` is sized
   * `fit-content`, whose floor is min-content, and a zero min-width does not
   * lower that floor — only a smaller min-content does.
   */
  body: "m-0 whitespace-pre-wrap break-all",
  /**
   * Hex is not text, and saying so is the point.
   *
   * Unexplained hex reads as a decoder that gave up, which is how four real
   * decoding faults stayed hidden for weeks.
   */
  binaryNote: "m-0 mt-s1 text-xs italic text-fg-faint",
  meta: "mt-s2 flex flex-wrap items-center gap-s2 text-xs",
  metaTime: "font-mono text-xs tabular-nums text-fg-faint",
  metaDetail: "text-fg-faint",

  /* ── Sending ────────────────────────────────────────────────────────── */

  /**
   * The refusal to send from a device that carries a module which must not
   * send. Loud on purpose: it is the difference between a message and a module.
   */
  blocked: "m-0 flex flex-col gap-s2 rounded border border-solid border-bad bg-bad-wash p-s3 text-sm text-bad",
  blockedTitle: "font-semibold",
  blockedBody: "m-0",
  /**
   * Sending is held because the module list could not be read.
   *
   * The warning colour rather than the bad one, and the difference is the
   * message: `blocked` above is "this device must not send", which is settled;
   * this is "nobody could find out", which is not. Same box, so it is plainly a
   * refusal and not a footnote — a hint under the field is what this used to be,
   * and it sat under a button that still worked.
   */
  hold: "m-0 flex flex-col gap-s2 rounded border border-solid border-warn bg-warn-wash p-s3 text-sm text-warn",
  /** A plain note where a control would have been. */
  note: "m-0 text-sm text-fg-muted",
} as const;

/**
 * `/journal`, which is the one read-only page with a control on it.
 *
 * Page-level rather than a primitive: two class lists used by one component,
 * and a `components/ui/journal-stack.tsx` would be a component nobody else can
 * ever call. They live here rather than in the `.tsx` for the same reason
 * everything else does — a `.tsx` cannot be read by a test in this app.
 */
export const JOURNAL = {
  /** The filter above the table, then the table. */
  stack: "flex flex-col gap-s4",
  /**
   * 🔴 **The envelope wraps here, and `Output` on its own does not make it.**
   *
   * `OUTPUT.root` scrolls in both axes, which is right for the two callers
   * that hold a diagnostic's reading in a card of its own. This one is inside
   * a table cell, and a scroll container's min-content size is *not* zero for
   * the purpose of sizing the cell around it: `pre` is `white-space: pre`, so
   * the cell demanded the width of the envelope's longest line and the table
   * grew to fit. Measured at 390px: the journal's table came out **1311px
   * wide inside a 311px card** with `Output` alone — against 1409px for the
   * hand-styled `.output` it replaced, which is not a fix.
   *
   * So the payload wraps instead. Long lines break rather than scroll
   * sideways, which on a phone is the difference between one horizontal
   * scroller and two nested ones, and the pretty-printed newlines survive
   * because the whitespace rule preserves them. `Output` keeps its vertical
   * scroll and its ceiling.
   *
   * Passed as the caller's class rather than changed in `OUTPUT`: the other
   * two call sites are an AT transcript and a command's reply in cards of
   * their own, they belong to another card, and they do not have a table
   * around them.
   */
  payload: "whitespace-pre-wrap break-all",
  /**
   * The row that is open, and the row holding what it opened to.
   *
   * The envelope is a row of its own spanning every column rather than the
   * last cell, because inside the cell it got what the other three columns
   * left over — 79px at 390px, measured. Two rows for one record then need to
   * read as one: the tint joins them and the dropped rule takes away the line
   * that would otherwise say they are separate records.
   */
  rowOpen: "border-b-0 bg-surface-hover",
  payloadRow: "bg-surface-hover",
  /**
   * "Nothing matched the filter", which is not the page's empty state.
   *
   * The page draws `CardEmpty` when the journal itself is empty. This line
   * only appears when rows exist and the chosen kind has none of them, so it
   * has to read as a consequence of the filter rather than as "no data".
   */
  filteredOut: "m-0 text-sm text-fg-faint",
} as const;

/**
 * A setting with two or three states, as one control rather than a row of
 * competing buttons. Only the selected option is filled.
 *
 * 🔴 **Full touch height, and the reason is consistency rather than a
 * standard.** This console defines its own token for anything a finger has to
 * hit — 44px, the AAA figure — and measured on the signed-out pages the two
 * language options came out 48×32 and 62.9×32. That clears the AA floor of
 * 24×24 and misses the console's own token by twelve pixels.
 *
 * Three recipes in this file sat below that token. The other two say in
 * writing why: both live in a dense table row and are sized to the cells
 * around them, and the compact select's note argues the case explicitly. This
 * one carried no such note, and it is not in a table — it sits alone in a page
 * header with room above and below it, which is the one place the argument for
 * shrinking a control does not apply. It was an opt-out nobody had made.
 *
 * Height only: nothing here changes width, so the header's wrapping and the
 * 390px column are untouched. Both consumers are outside a table row —
 * `components/locale-switch.tsx` in the header, and the journal's kind filter
 * above its table rather than inside it.
 */
export const SEGMENTED = {
  root: "inline-flex items-center gap-px rounded border border-line bg-surface-hover p-px",
  option:
    "inline-flex min-h-touch cursor-pointer items-center rounded border-0 bg-transparent px-s3 text-xs font-semibold text-fg-muted transition-colors hover:text-fg",
  optionSelected: "bg-surface text-fg shadow",
} as const;

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
   * The label the phone bar draws, which has 78px to draw it in.
   *
   * A second key rather than a shortened copy of the first: the two renderers
   * want different lengths of the same word, and a translator has to be able
   * to shorten one without the other moving. The reference console this board
   * is modelled on separates them the same way. Several are the same sentence
   * in both catalogues today, and that is fine — what matters is that there is
   * somewhere to put a shorter one when a language needs it, which is the
   * thing a single key does not have.
   */
  readonly shortKey: string;
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
  /**
   * Where the phone's bottom bar draws it, or `null` for the ones behind the
   * overflow trigger.
   *
   * 🔴 **This is the whole of "which four are on the bar", and it lives on the
   * item.** A separate array of four hrefs would be a second list, and the two
   * would be free to disagree the first time a destination was renamed — which
   * is the failure this card was written to make impossible. Both sets are
   * read off this field: the bar is the items that have a number, in that
   * order, and the overflow sheet is *everything else*, derived by
   * subtraction rather than typed out. A destination added to a group above
   * and given no number appears in the sheet without anybody editing a list.
   *
   * The order is the operator's, confirmed 2026-08-27, and it is not the order
   * the groups happen to be in: overview, devices, inbox, journal puts the two
   * most-read pages side by side, while the flattened groups would interleave
   * `/journal` between them. That is the only reason this is a number and not
   * a boolean.
   */
  readonly bottomSlot: number | null;
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
        shortKey: "nav.overviewShort",
        icon: "M4 4H10V10H4ZM14 4H20V10H14ZM4 14H10V20H4ZM14 14H20V20H14Z",
        bottomSlot: 1,
      },
      {
        href: "/devices",
        key: "nav.devices",
        shortKey: "nav.devicesShort",
        icon: "M7 3H17V21H7ZM10 18H14",
        bottomSlot: 2,
      },
      {
        href: "/journal",
        key: "nav.journal",
        shortKey: "nav.journalShort",
        icon: "M6 3H15L19 7V21H6ZM9 12H16M9 16H14",
        bottomSlot: 4,
      },
      {
        href: "/audit",
        key: "nav.audit",
        shortKey: "nav.auditShort",
        icon: "M12 3L20 6V12C20 17 16 20 12 21C8 20 4 17 4 12V6Z M9 12L11 14L15 10",
        bottomSlot: null,
      },
    ],
  },
  {
    label: "nav.group.comms",
    items: [
      {
        href: "/inbox",
        key: "nav.inbox",
        shortKey: "nav.inboxShort",
        icon: "M3 6H21V18H3Z M3 7L12 13L21 7",
        bottomSlot: 3,
      },
      {
        href: "/sessions",
        key: "nav.sessions",
        shortKey: "nav.sessionsShort",
        icon: "M21 12C21 16 17 19 12 19C11 19 10 19 9 18L4 20L5 16C4 15 3 14 3 12C3 8 7 5 12 5C17 5 21 8 21 12Z",
        bottomSlot: null,
      },
      {
        href: "/rules",
        key: "nav.rules",
        shortKey: "nav.rulesShort",
        icon: "M4 7H20M4 17H20 M9 4V10M15 14V20",
        bottomSlot: null,
      },
      {
        href: "/schedule",
        key: "nav.schedule",
        shortKey: "nav.scheduleShort",
        icon: "M4 6H20V20H4ZM4 10H20M9 3V7M15 3V7",
        bottomSlot: null,
      },
    ],
  },
  {
    label: "nav.group.network",
    items: [
      {
        href: "/proxy",
        key: "nav.proxy",
        shortKey: "nav.proxyShort",
        icon: "M4 4H10V10H4ZM14 14H20V20H14ZM10 7H17V14",
        bottomSlot: null,
      },
    ],
  },
  {
    label: "nav.group.settings",
    items: [
      {
        href: "/settings",
        key: "nav.settings",
        shortKey: "nav.settingsShort",
        icon: "M12 8A4 4 0 1 0 12 16A4 4 0 1 0 12 8Z M12 2V5M12 19V22M2 12H5M19 12H22",
        bottomSlot: null,
      },
    ],
  },
];

/**
 * The fifth cell, which is not a destination.
 *
 * It opens the sheet holding everything the bar has no room for. It carries
 * the same three fields a destination carries so that the bar draws five cells
 * from one shape rather than four of one shape and a special case — and so
 * that its label is checked by the same assertion that checks the other ten.
 *
 * It deliberately has no `href` and no `bottomSlot`: it is not somewhere to
 * go, and `NAV_GROUPS` is where somewhere-to-go is written down. Keeping it
 * out of that array is what keeps "ten destinations" countable.
 */
export const NAV_MORE = {
  key: "nav.more",
  shortKey: "nav.moreShort",
  icon: "M5 10A2 2 0 1 0 5 14A2 2 0 1 0 5 10Z M12 10A2 2 0 1 0 12 14A2 2 0 1 0 12 10Z M19 10A2 2 0 1 0 19 14A2 2 0 1 0 19 10Z",
} as const;

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

/**
 * The four the phone bar draws, in the operator's order.
 *
 * Derived, and the sort is what makes `bottomSlot` mean position rather than
 * merely membership.
 */
export function bottomNavItems(): readonly NavItem[] {
  return navItems()
    .filter((item) => item.bottomSlot !== null)
    .slice()
    .sort((a, b) => (a.bottomSlot as number) - (b.bottomSlot as number));
}

/**
 * Everything else — the six behind the overflow trigger.
 *
 * 🔴 **By subtraction, never by enumeration.** A hand-written list of six is a
 * list that silently loses an entry the day an eleventh destination is added,
 * and a destination that is on neither renderer is a page reachable only by
 * typing its URL. This cannot under-report: whatever is not on the bar is
 * here, by construction.
 */
export function overflowNavItems(): readonly NavItem[] {
  return navItems().filter((item) => item.bottomSlot === null);
}

/**
 * How many cells the phone bar draws: the destinations on it, plus the
 * overflow trigger.
 *
 * A count rather than a literal five, because the arithmetic below is the
 * reason the operator chose four destinations and not ten, and an arithmetic
 * check reading a literal is a check that agrees with itself.
 */
export function bottomNavCellCount(): number {
  return bottomNavItems().length + 1;
}

/**
 * What one cell gets, across a viewport of `width` CSS pixels.
 *
 * 🔴 **This is the constraint that settled the design, so it is computed and
 * not remembered.** At 390px — the narrowest phone this console is checked on
 * — ten destinations laid out at once give 39px a cell, and `SIZE_TOKENS.touch`
 * is 44px. Five cells give 78px. ⚠️ **This is a budget, not a rendered width**
 * — measured at 390 the row draws 79.59 / 79.61 / 79.59 / 79.61 / 71.59, and
 * `BOTTOM_NAV.cell` says why. The operator was shown both numbers and chose
 * five; `tokens.test.ts` recomputes them from this function rather than
 * quoting them, so a sixth cell fails the suite instead of shipping a target
 * nobody can hit.
 */
export function bottomNavCellWidth(width: number, cells = bottomNavCellCount()): number {
  return width / cells;
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

export type ButtonVariant = keyof typeof BUTTON.variant;
export type ButtonSize = keyof typeof BUTTON.size;
export type BadgeTone = keyof typeof BADGE.tone;
export type StatTone = keyof typeof STAT.tone;

export function buttonClass(options?: {
  variant?: ButtonVariant;
  size?: ButtonSize;
}): string {
  const variant = options?.variant ?? "primary";
  const size = options?.size ?? "md";
  return `${BUTTON.base} ${BUTTON.variant[variant]} ${BUTTON.size[size]}`;
}

export function badgeClass(tone: BadgeTone = "neutral"): string {
  return `${BADGE.base} ${BADGE.tone[tone]}`;
}

export function tableCellClass(options?: { mono?: boolean; faint?: boolean }): string {
  let out = TABLE.cell;
  if (options?.mono) out += ` ${TABLE.cellMono}`;
  if (options?.faint) out += ` ${TABLE.cellFaint}`;
  return out;
}

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
  | { readonly kind: "add" }
  | { readonly kind: "remove" };

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
} {
  switch (edit.kind) {
    case "cellular":
      return { cellularEnabled: edit.enabled };
    case "vertical":
      return { vertical: edit.to };
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
  "app/sessions/page.tsx",
  "app/settings/page.tsx",
  "app/unknown-tenant/page.tsx",
  "components/card-policies.tsx",
  "components/connection-status.tsx",
  "components/conversation.tsx",
  "components/device-admin.tsx",
  "components/device-console.tsx",
  "components/esim-panel.tsx",
  "components/journal.tsx",
  "components/live-reload.tsx",
  "components/locale-switch.tsx",
  "components/login-form.tsx",
  "components/mobile-nav.tsx",
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
 */
export const NON_UTILITY_CLASSES = ["group", "peer"] as const;

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
