import type { Config } from "tailwindcss";
import {
  TAILWIND_BORDER_RADIUS,
  TAILWIND_BOX_SHADOW,
  TAILWIND_COLORS,
  TAILWIND_FONT_FAMILY,
  TAILWIND_FONT_SIZE,
  TAILWIND_SPACING,
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
    // The class recipes live here, so this file is content, not config.
    "./lib/**/*.{ts,tsx}",
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
