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
  bg: { dark: "#0b0e14", light: "#f7f8fa" },
  surface: { dark: "#12161f", light: "#ffffff" },
  "surface-raised": { dark: "#171c27", light: "#ffffff" },
  "surface-hover": { dark: "#1c2230", light: "#f1f3f7" },
  line: { dark: "#232a38", light: "#e3e7ee" },
  "line-strong": { dark: "#303950", light: "#cdd4e0" },

  // Text. Three weights is enough; more and the hierarchy stops reading.
  fg: { dark: "#e7ecf3", light: "#1a2030" },
  "fg-muted": { dark: "#93a1b5", light: "#5a6579" },
  "fg-faint": { dark: "#64708a", light: "#8b96a9" },

  // One accent. A second colour competing for attention is how dashboards
  // turn into noise.
  accent: { dark: "#4ade9b", light: "#10b47a" },
  "accent-strong": { dark: "#22c47f", light: "#0d9a68" },
  "accent-ink": { dark: "#06251a", light: "#ffffff" },
  "accent-wash": { dark: "rgba(74, 222, 155, 0.12)", light: "rgba(16, 180, 122, 0.1)" },

  // Status. These carry meaning, so they are never used decoratively.
  ok: { dark: "#4ade9b", light: "#10b47a" },
  warn: { dark: "#f0b429", light: "#b8860b" },
  bad: { dark: "#f2686d", light: "#d64550" },
  info: { dark: "#63a4ff", light: "#2b6fd4" },
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

export const RADIUS_TOKENS = {
  radius: "10px",
  "radius-lg": "14px",
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

/** Tight for large type, wider for small caps. Nothing else earns a step. */
export const TAILWIND_LETTER_SPACING = {
  normal: "0em",
  tight: "-0.025em",
  wider: "0.05em",
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
  link: "font-semibold text-accent underline",
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
  sectionTitle: "m-0 text-sm font-semibold uppercase tracking-wider text-fg-muted",
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
  label: "text-xs font-semibold uppercase tracking-wider text-fg-muted",
  /**
   * `tabular-nums` so a count that changes on refresh does not shift the label
   * under it, and `leading-none` because a 2rem number carries its own space.
   */
  value: "text-2xl font-semibold leading-none tracking-tight tabular-nums text-fg",
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
    "sticky top-0 border-b border-line bg-surface-raised px-s4 py-s3 text-left text-xs font-semibold uppercase tracking-wider text-fg-faint",
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
  cellLink: "font-medium text-accent hover:underline",
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
    "whitespace-nowrap px-s4 py-s2 text-left align-top text-xs font-semibold uppercase tracking-wider text-fg-faint",
  specDetail: "w-full px-s4 py-s2 align-top text-sm text-fg",
} as const;

export const BUTTON = {
  base: "inline-flex cursor-pointer items-center justify-center gap-s2 whitespace-nowrap rounded border border-transparent font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50",
  variant: {
    primary: "bg-accent text-accent-ink hover:bg-accent-strong",
    ghost:
      "border-line-strong bg-transparent text-fg-muted hover:border-accent hover:bg-surface-hover hover:text-fg",
    subtle: "bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg",
    /**
     * Colour is a hint, never the safeguard. The confirmation is. This fleet
     * has commands that strand a module operators cannot reach physically.
     *
     * Filled, and therefore for the one button that carries out the destructive
     * act — the confirm button in the dialog. A row of eight filled red buttons
     * is a row in which nothing stands out.
     */
    danger: "bg-bad text-white hover:opacity-90",
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
  tone: {
    ok: "bg-ok-wash text-ok",
    warn: "bg-warn-wash text-warn",
    bad: "bg-bad-wash text-bad",
    info: "bg-info-wash text-info",
    neutral: "bg-surface-hover text-fg-faint",
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
   * Sticky from `sm` up, not below it.
   *
   * The four groups show all nine destinations without a horizontal scroller,
   * which costs about three wrapped rows on a phone. Pinning that to the top
   * would hand a quarter of a 390px screen to navigation permanently. Above
   * `sm` the same nav is one or two rows, so it stays pinned there. The
   * alternative — keeping it sticky and hiding destinations behind a scroller
   * — is the arrangement this card was written to replace.
   */
  header: "z-20 border-b border-line bg-surface sm:sticky sm:top-0",
  bar: "mx-auto flex w-full max-w-page flex-wrap items-center gap-s3 px-s3 py-s2 sm:px-s5",
  brand: "flex items-center gap-s2 text-base font-semibold tracking-tight text-fg",
  brandMark:
    "flex size-s5 shrink-0 items-center justify-center rounded bg-gradient-to-br from-accent to-accent-strong text-xs font-bold text-accent-ink",
  side: "ml-auto flex flex-wrap items-center gap-s2",
  tenant:
    "inline-flex items-center gap-s2 rounded-pill border border-line bg-surface-hover px-s3 py-s1 text-xs text-fg-muted",
  tenantSlug: "font-semibold text-fg",
  tenantRegion: "text-fg-faint",
  /**
   * Laid out with flex, wrapping.
   *
   * The gaps are split: groups need horizontal room to read as groups, but a
   * matching vertical gap only makes a wrapped nav taller. On a 390px phone in
   * English this is the difference between a 304px and a 320px header.
   */
  nav: "mx-auto flex w-full max-w-page flex-wrap items-center gap-x-s3 gap-y-s2 px-s3 pb-s2 sm:gap-x-s4 sm:px-s5",
  /**
   * A rule between groups, not only a caption.
   *
   * `uppercase` does the work in English and nothing at all in Chinese, where
   * a dimmer label sitting next to links of the same size still reads as a
   * twelfth link. The divider is what makes the four groups four groups in
   * both languages.
   */
  navGroup:
    "flex flex-wrap items-center gap-s1 border-l border-line-strong pl-s3 first:border-l-0 first:pl-0",
  navGroupLabel: "px-s1 text-xs font-semibold uppercase tracking-wider text-fg-faint",
  /**
   * Full touch height at every width. The horizontal padding and the type
   * shrink on a phone instead, because a 32px-tall target is the wrong thing
   * to save space on.
   */
  navLink:
    "inline-flex min-h-touch items-center rounded px-s2 text-xs text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg sm:px-s3 sm:text-sm",
  navLinkCurrent: "bg-accent-wash font-semibold text-accent",
  main: "mx-auto w-full max-w-page flex-1 px-s3 py-s4 sm:px-s5 sm:py-s5",
  footer:
    "mx-auto flex w-full max-w-page flex-wrap items-center gap-s3 px-s3 py-s4 text-sm text-fg-muted sm:px-s5",
  footerLabel: "text-fg-faint",
  /** Anchors are `text-decoration: none` globally, so a bare link has to say so. */
  footerLink: "underline transition-colors hover:text-fg",
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
  root: "flex min-h-dvh flex-col items-center justify-center p-s5",
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
    "min-h-touch w-full rounded border border-line-strong bg-bg px-s3 text-sm text-fg placeholder:text-fg-faint focus:border-accent disabled:opacity-50",
  /**
   * The same box as `input`, minus the placeholder a `select` cannot have.
   * The native arrow is left alone: removing it means drawing and positioning
   * a replacement, and a picker that does not look like the platform's picker
   * is the kind of polish that costs an operator a tap.
   */
  select:
    "min-h-touch w-full cursor-pointer rounded border border-line-strong bg-bg px-s3 text-sm text-fg focus:border-accent disabled:opacity-50",
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
    "w-full resize-y rounded border border-line-strong bg-bg p-s3 text-sm text-fg placeholder:text-fg-faint focus:border-accent disabled:opacity-50",
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
  tabCurrent: "border-accent text-fg",
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
 */
export const SEGMENTED = {
  root: "inline-flex items-center gap-px rounded border border-line bg-surface-hover p-px",
  option:
    "inline-flex min-h-s6 cursor-pointer items-center rounded border-0 bg-transparent px-s3 text-xs font-semibold text-fg-faint transition-colors hover:text-fg",
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

export type NavItem = { readonly href: string; readonly key: string };
export type NavGroup = {
  /** `null` when the group is a single link whose own label names it. */
  readonly label: string | null;
  readonly items: readonly NavItem[];
};

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "nav.group.fleet",
    items: [
      { href: "/", key: "nav.overview" },
      { href: "/devices", key: "nav.devices" },
      { href: "/journal", key: "nav.journal" },
      { href: "/audit", key: "nav.audit" },
    ],
  },
  {
    label: "nav.group.comms",
    items: [
      { href: "/inbox", key: "nav.inbox" },
      { href: "/sessions", key: "nav.sessions" },
      { href: "/rules", key: "nav.rules" },
      { href: "/schedule", key: "nav.schedule" },
    ],
  },
  {
    label: "nav.group.network",
    items: [{ href: "/proxy", key: "nav.proxy" }],
  },
  {
    label: "nav.group.settings",
    items: [
      { href: "/settings", key: "nav.settings" },
    ],
  },
];

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
  "components/proxy-manager.tsx",
  "components/pwa.tsx",
  "components/send-sms.tsx",
  "components/settings-form.tsx",
  "components/shell.tsx",
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
