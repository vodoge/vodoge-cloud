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
 * **Preflight is off.** Fourteen pages still render from the legacy stylesheet
 * in `@layer legacy`, and that stylesheet is styling bare `button`, `input`,
 * `table` and `label` elements. Preflight is unlayered, so switching it on
 * would outrank all of it and restyle fourteen pages this refactor has not
 * reached yet. `globals.css` carries the reset those pages actually depend on.
 * Turning preflight on belongs with the deletion of the legacy layer, not
 * before it.
 *
 * There is no `darkMode` either. Colours are custom properties that already
 * flip with `:root[data-theme="light"]`, so a `dark:` variant would be a
 * second, disagreeing switch. `lib/tokens.test.ts` rejects `dark:` in migrated
 * files for that reason.
 */
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
    colors: TAILWIND_COLORS,
    spacing: TAILWIND_SPACING,
    fontSize: TAILWIND_FONT_SIZE,
    borderRadius: TAILWIND_BORDER_RADIUS,
    boxShadow: TAILWIND_BOX_SHADOW,
    fontFamily: TAILWIND_FONT_FAMILY,
    maxWidth: TAILWIND_MAX_WIDTH,
    lineHeight: TAILWIND_LINE_HEIGHT,
    letterSpacing: TAILWIND_LETTER_SPACING,
    opacity: TAILWIND_OPACITY,
    zIndex: TAILWIND_Z_INDEX,
    width: TAILWIND_WIDTH,
    gridTemplateColumns: TAILWIND_GRID_TEMPLATE_COLUMNS,
    // The six the operator asked for on 2026-08-25. `flex` and `inset` are the
    // two with a trap in them: `flex` is `flex-1` and not the `flex` display
    // utility, and `inset` is read by `top-*` as well as by `inset-*`. Both are
    // in use — `STAT.root`, `SHELL.main`, `TABLE.headerCell`, `SHELL.header` —
    // so both tables keep the entry the recipes need. See lib/tokens.ts.
    minHeight: TAILWIND_MIN_HEIGHT,
    maxHeight: TAILWIND_MAX_HEIGHT,
    borderWidth: TAILWIND_BORDER_WIDTH,
    ringWidth: TAILWIND_RING_WIDTH,
    ringOffsetWidth: TAILWIND_RING_OFFSET_WIDTH,
    inset: TAILWIND_INSET,
    flex: TAILWIND_FLEX,
    extend: {
      // Tailwind's defaults for these point at palette entries that no longer
      // exist (`gray.200`, `blue.500`). They fall back to `currentColor`
      // rather than failing, which would make a bare `border` mean something
      // different from every `border-line` next to it.
      borderColor: { DEFAULT: "var(--line)" },
      ringColor: { DEFAULT: "var(--accent)" },
      ringOffsetColor: { DEFAULT: "var(--bg)" },
    },
  },
  plugins: [],
} satisfies Config;
