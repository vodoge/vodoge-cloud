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
 * this system rejects — that is what `LEGACY_UTILITY_COLLISIONS` is about.
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
 * 22rem is what `.output` in the legacy stylesheet has always used, so the
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
 * `display` and `flexDirection`, which nothing here touches. The pattern this
 * design system settled on ("flex, never grid", see
 * `LEGACY_UTILITY_COLLISIONS`) is unaffected by anything in this table.
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
  actions: "ml-auto flex flex-wrap gap-s2",
  /** A load failure above the content it failed to load. */
  error: "m-0 mb-s4 text-sm text-bad",
  /**
   * The blocks of a page below its heading, one under the other.
   *
   * A gap rather than a margin on each block, so that a block which is
   * sometimes absent — an error line, a section with nothing in it — cannot
   * leave its spacing behind. Wider than the gap *inside* a row of cards: the
   * rhythm is what says "this is a different question".
   */
  stack: "flex flex-col gap-s5",
} as const;

export const CARD = {
  root: "overflow-hidden rounded-lg border border-line bg-surface shadow",
  header: "flex items-center gap-s2 border-b border-line px-s4 py-s3",
  title: "m-0 text-sm font-semibold text-fg",
  note: "text-xs font-normal text-fg-faint",
  actions: "ml-auto flex gap-s2",
  content: "p-s4",
  /**
   * `flex flex-col`, not `grid`. The old stylesheet has a `.grid` class of its
   * own that also sets `gap` and `grid-template-columns`, and those two
   * declarations leak into any element that carries Tailwind's `grid`
   * utility — cascade layers cannot help, because nothing in the utility
   * overrides them. See LEGACY_UTILITY_COLLISIONS.
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
   * `<details>`, so it works with JavaScript off and needs no state. The
   * stylesheet styles neither `details` nor `summary`, so nothing here is
   * fighting the legacy layer. `list-none` removes the disclosure triangle's
   * default marker; the caller supplies its own affordance in the summary.
   */
  disclosureSummary:
    "flex cursor-pointer list-none items-center gap-s2 border-b border-line px-s4 py-s3 text-sm font-semibold text-fg",
  disclosureMarker: "ml-auto text-xs font-normal text-fg-faint",
} as const;

/**
 * One number per card, in a row that becomes a column on a phone.
 *
 * `flex`, never `grid` — see LEGACY_UTILITY_COLLISIONS. The old stylesheet
 * asked for `repeat(auto-fill, minmax(min(100%, 260px), 1fr))`, which cannot be
 * written with the token spacing scale and would need an arbitrary value. Three
 * equal columns above `sm` and a stack below it says the same thing for the
 * counts this console actually shows, and it says it without a magic number.
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
     * been rendering in the ordinary colour the whole time —
     * `device-console.tsx:663`, the USB-net mode switch, sits in an
     * `<form className="inline-form">` and its warning colour has never once
     * appeared. A variant needs no ancestor, which is the point of moving it
     * here; `tokens.test.ts` derives the "only ever a descendant selector"
     * claim from the stylesheet rather than trusting this comment.
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
   * `flex flex-wrap`, never `grid` — see LEGACY_UTILITY_COLLISIONS.
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
 * Preflight is off and the legacy stylesheet still styles bare `form`, `label`,
 * `input`, `select` and `textarea` elements, so every property that has to
 * differ is spelled out rather than left to inherit. `focus` deliberately says
 * nothing about `outline`: the global `:focus-visible` ring comes back on its
 * own when the legacy layer goes.
 *
 * There is a recipe here for **every** element the legacy layer styles bare,
 * and `tokens.test.ts` checks that from the stylesheet rather than from memory.
 * A `select` or a `textarea` with no recipe is not a gap that shows up now — it
 * looks perfectly fine today, because `@layer legacy` is painting it. It shows
 * up on the day that layer is deleted, on whichever pages happened to use one.
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
   * which is the smallest thing the legacy stylesheet asks a finger to hit.
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
   * 🔴 The checkbox needs its *own* size, and this is not cosmetic. Today a
   * checkbox escapes `input { width: 100% }` (`globals.css:613-622`) only
   * because `.field-inline input` (`:920`) pins it to 1rem — and `.field-inline`
   * is itself in the layer that gets deleted. The day `@layer legacy` goes,
   * both of this console's checkboxes (`card-policies.tsx:89` inside a table
   * cell, `settings-form.tsx:153`) stretch to fill their container unless the
   * size is stated here.
   */
  inlineLabel: "flex items-center gap-s2 text-sm font-medium text-fg",
  /**
   * `min-h-s4` as well as `size-s4`, and it is not redundant.
   *
   * The legacy rule is `input, select, textarea { min-height: var(--touch) }`
   * (`globals.css:613-622`), and `min-height` beats `height` no matter which
   * layer either comes from. Measured at 390px with only `size-s4`, the
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
   * The legacy rule was `.inline-form .grow { flex: 1 1 16rem }`, which cannot
   * be written here — `grow` is one of the class names that collides with the
   * old stylesheet, and 16rem is not on any scale. Saying it as a breakpoint
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
 * is a `<button>`. `border-x-0 border-t-0` is not decoration: preflight is off
 * and the legacy layer gives every bare `button` a 1px border on all four
 * sides.
 */
export const TABS = {
  list: "flex flex-wrap items-center gap-x-s4 border-b border-line",
  tab: "inline-flex min-h-touch cursor-pointer items-center whitespace-nowrap rounded-none border-x-0 border-t-0 border-b-2 border-transparent bg-transparent px-s1 text-sm font-semibold text-fg-muted transition-colors hover:text-fg",
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
    bar: "flex flex-wrap items-center gap-x-s3 gap-y-s2 border-b border-line bg-surface-raised px-s3 py-s2 text-sm sm:px-s5",
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
    bar: "fixed inset-x-0 bottom-0 z-20 border-t border-bad bg-bad-wash shadow-lg",
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
 * `/sessions` is deliberately absent — see the note in
 * `docs/goals/vodoge-ui-refactor/notes/T007-shell-and-nav.md`. The page still
 * exists and still renders; it has no nav entry under the confirmed grouping.
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
      { href: "/rules", key: "nav.rules" },
      { href: "/schedule", key: "nav.schedule" },
    ],
  },
  {
    label: "nav.group.network",
    items: [{ href: "/proxy", key: "nav.proxy" }],
  },
  {
    // "Settings / Settings" would be the label repeating its only link.
    label: null,
    items: [{ href: "/settings", key: "nav.settings" }],
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
 */
export const CONFIRM_CONSEQUENCE_KEYS = ["device.usbnetWarning"] as const;

/** The dialog's own chrome, so every confirmation asks in the same words. */
export const CONFIRM_LABEL_KEYS = [
  "confirm.question",
  "confirm.proceed",
  "confirm.cancel",
] as const;

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
 * `app/globals.css` still carries the hand-written stylesheet the other
 * fourteen pages render with. It is wrapped in `@layer legacy` so that every
 * Tailwind utility outranks it whatever the selector specificity, and it gets
 * deleted once every page is migrated. Until then these two lists say what a
 * migrated file is not allowed to do.
 */

/**
 * Files that must be free of the old stylesheet. Each page card appends to it.
 *
 * A file that is not on this list is not checked, so adding the file is part
 * of migrating it. Two of the entries below — `pwa.tsx` and `live-reload.tsx`
 * — render `null` and never carried a class; they are listed so that the
 * guard, not a reader's memory, is what keeps them that way.
 *
 * This list *is* criterion ①, so it cannot be opt-in. `tokens.test.ts` asserts
 * that it and `UNMIGRATED_SOURCES` together account for every `.tsx` under
 * `app/` and `components/`, and that every file still on the unmigrated list
 * really does still carry a legacy class. A page migrated without being moved
 * across is therefore a failing test rather than a page nothing checks.
 */
export const MIGRATED_SOURCES = [
  "app/audit/page.tsx",
  "app/layout.tsx",
  "app/login/page.tsx",
  "app/not-found.tsx",
  "app/not-a-tenant/page.tsx",
  "app/page.tsx",
  "components/connection-status.tsx",
  "components/live-reload.tsx",
  "components/locale-switch.tsx",
  "components/login-form.tsx",
  "components/pwa.tsx",
  "components/shell.tsx",
  "components/sign-out.tsx",
  "components/theme-toggle.tsx",
  "components/ui.tsx",
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
 * Class names a `.tsx` asks for that nothing anywhere defines.
 *
 * Not the legacy stylesheet, not the Tailwind build — nothing. They render as
 * plain unstyled markup and always have.
 *
 * The list is frozen and `tokens.test.ts` asserts the *computed* set equals it,
 * which cuts both ways: a card that fixes one has to shorten the list, and a
 * card that invents a new dead class fails immediately rather than shipping
 * markup that reviews perfectly and renders as nothing.
 *
 * - **`card-grid`** — `app/devices/[deviceId]/page.tsx:69`,
 *   `app/proxy/page.tsx:63`, `app/settings/page.tsx:129`. The stylesheet has
 *   `.grid` and `.grid-wide`; it has never had `.card-grid`. All three of
 *   those pages are stacking their cards in ordinary block flow while their
 *   markup says they are laying them out in a grid. **This one was not on any
 *   survey** — it was found by running the check rather than by reading, which
 *   is the only way any of these have ever been found.
 * - **`panel`, `primary`** — `components/send-sms.tsx:34` and `:53`. The one
 *   form in this console that sends a text message has been an unstyled block
 *   with an unstyled button since it was written.
 *
 * All five sites are outside this card's file list: `card-grid` belongs to
 * T010, T012 and T013, and `send-sms.tsx` to T014.
 */
export const CLASSES_WITH_NO_STYLESHEET = ["card-grid", "panel", "primary"] as const;

/**
 * Legacy class names that only ever appear under an ancestor.
 *
 * A subtler version of the list above, and the one that has actually cost
 * something. `.risk` looks like a class. It is not: the stylesheet declares it
 * only as `.button-row button.risk` (`globals.css:851`) and
 * `.row-actions button.risk` (`:946`), so it colours a button in those two
 * containers and does nothing at all anywhere else. `device-console.tsx:663`
 * puts a `.risk` button inside `<form className="inline-form">` — a warning
 * colour that has never once been drawn, on the control that takes a module
 * off the device list.
 *
 * `tokens.test.ts` derives the claim from the stylesheet, so it is checked
 * rather than remembered, and asserts the replacement — `BUTTON.variant.risk`
 * — generates CSS standing on its own.
 */
export const CLASSES_NEEDING_AN_ANCESTOR = ["risk"] as const;

/**
 * The other side of the same ledger: files still rendered by the old stylesheet.
 *
 * Every `.tsx` under `app/` and `components/` is on exactly one of these two
 * lists — `tokens.test.ts` walks the directories and checks it, so a new file
 * has to be classified rather than quietly escaping both. Migrating a page
 * means moving its name up, and the test that every file down here still uses a
 * legacy class is what makes forgetting to move it fail.
 *
 * `app/unknown-tenant/page.tsx` calls `notFound()` and renders nothing at all.
 * It is left here rather than promoted, because promoting a file that has no
 * markup would count as migration progress without any having happened.
 */
export const UNMIGRATED_SOURCES = [
  "app/devices/[deviceId]/page.tsx",
  "app/devices/page.tsx",
  "app/inbox/[peer]/page.tsx",
  "app/inbox/page.tsx",
  "app/journal/page.tsx",
  "app/proxy/page.tsx",
  "app/rules/page.tsx",
  "app/schedule/page.tsx",
  "app/sessions/page.tsx",
  "app/settings/page.tsx",
  "app/unknown-tenant/page.tsx",
  "components/card-policies.tsx",
  "components/conversation.tsx",
  "components/device-admin.tsx",
  "components/device-console.tsx",
  "components/esim-panel.tsx",
  "components/journal.tsx",
  "components/proxy-manager.tsx",
  "components/send-sms.tsx",
  "components/settings-form.tsx",
] as const;

/**
 * Class names that exist in *both* the legacy stylesheet and Tailwind.
 *
 * These are the dangerous ones. A cascade layer decides who wins when both
 * declare the same property; it does nothing about the properties only the
 * legacy rule declares. `.grid` sets `gap` and `grid-template-columns` that
 * Tailwind's `grid` utility says nothing about, so those leak into any
 * migrated element carrying the utility.
 *
 * **How to lay something out in a grid before the legacy layer is deleted.**
 * The collision is between *class names*, not between display modes, so the
 * escape hatch is any name the legacy selector does not match:
 *
 * - `flex` / `flex-col`, which is what almost every case here wants; or
 * - a variant-prefixed grid — `sm:grid`, `max-sm:grid` — because the class
 *   attribute then reads `sm:grid` and `.grid` does not match it. Pair it with
 *   `grid-cols-*` and `gap-*` from the token scales as usual.
 *
 * Earlier advice in this comment said a bare `grid` was fine as long as
 * `grid-cols-*` and `gap-*` were spelled out. That is true of the two
 * declarations `.grid` happens to set *today*, and `FORBIDDEN_IN_MIGRATED_SOURCES`
 * rejected it anyway, so the file argued with itself and the tests won. It is
 * gone for a better reason than the argument: "override every property the
 * legacy rule sets" is an audit that has to be redone every time the legacy
 * rule changes, and nothing can check it. "Do not use the colliding name" is
 * one line of test.
 *
 * `tokens.test.ts` derives the real collision set from the stylesheet and the
 * Tailwind build, so a new one cannot appear unnoticed. Delete this list with
 * the stylesheet.
 */
export const LEGACY_UTILITY_COLLISIONS = ["grid", "grow", "sr-only"] as const;

/**
 * Of those, the ones a migrated file may not use at all.
 *
 * Matched as whole class names, which is what makes `sm:grid` a way out and
 * `grid` not one. `sr-only` is absent because the legacy rule and the utility
 * say the same thing.
 */
export const FORBIDDEN_IN_MIGRATED_SOURCES = ["grid", "grow"] as const;

/**
 * Classes that legitimately generate no CSS.
 *
 * `group` and `peer` are markers Tailwind reads on other elements' variants.
 */
export const NON_UTILITY_CLASSES = ["group", "peer"] as const;
