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
  emptyDescription: "max-w-sm text-sm",
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
     */
    danger: "bg-bad text-white hover:opacity-90",
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
  bar: "mx-auto flex w-full max-w-7xl flex-wrap items-center gap-s3 px-s3 py-s2 sm:px-s5",
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
  nav: "mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-s3 gap-y-s2 px-s3 pb-s2 sm:gap-x-s4 sm:px-s5",
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
  main: "mx-auto w-full max-w-7xl flex-1 px-s3 py-s4 sm:px-s5 sm:py-s5",
  footer:
    "mx-auto flex w-full max-w-7xl flex-wrap items-center gap-s3 px-s3 py-s4 text-sm text-fg-muted sm:px-s5",
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
} as const;

/* ── Auth, 404 and the apex page ─────────────────────────────────────────
 *
 * One card centred in the viewport. The login page and the two error pages
 * are the same shape, and all three render without the shell.
 */

export const CENTERED = {
  root: "flex min-h-dvh flex-col items-center justify-center p-s5",
  card: "flex w-full max-w-sm flex-col gap-s4 rounded-lg border border-line bg-surface p-s6 shadow-lg",
  brand: "flex items-center gap-s2 text-lg font-semibold text-fg",
  hint: "m-0 text-sm text-fg-muted",
} as const;

/**
 * Form parts.
 *
 * Preflight is off and the legacy stylesheet still styles bare `form`, `label`
 * and `input` elements, so every property that has to differ is spelled out
 * rather than left to inherit. `focus` deliberately says nothing about
 * `outline`: the global `:focus-visible` ring comes back on its own when the
 * legacy layer goes.
 */
export const FORM = {
  root: "flex flex-col gap-s3",
  label: "flex flex-col gap-s1 text-sm font-medium text-fg-muted",
  input:
    "min-h-touch w-full rounded border border-line-strong bg-bg px-s3 text-sm text-fg placeholder:text-fg-faint focus:border-accent disabled:opacity-50",
  error: "m-0 text-sm text-bad",
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
 */
export const MIGRATED_SOURCES = [
  "app/audit/page.tsx",
  "app/layout.tsx",
  "app/login/page.tsx",
  "app/not-found.tsx",
  "app/not-a-tenant/page.tsx",
  "components/live-reload.tsx",
  "components/locale-switch.tsx",
  "components/login-form.tsx",
  "components/pwa.tsx",
  "components/shell.tsx",
  "components/sign-out.tsx",
  "components/theme-toggle.tsx",
  "components/ui/badge.tsx",
  "components/ui/button.tsx",
  "components/ui/card.tsx",
  "components/ui/table.tsx",
] as const;

/**
 * Class names that exist in *both* the legacy stylesheet and Tailwind.
 *
 * These are the dangerous ones. A cascade layer decides who wins when both
 * declare the same property; it does nothing about the properties only the
 * legacy rule declares. `.grid` sets `gap` and `grid-template-columns` that
 * Tailwind's `grid` utility says nothing about, so those leak into any
 * migrated element carrying the utility. Use `flex`, or spell out
 * `grid-cols-*` and `gap-*` — and delete this list with the stylesheet.
 *
 * `tokens.test.ts` derives the real collision set from the stylesheet and the
 * Tailwind build, so a new one cannot appear unnoticed.
 */
export const LEGACY_UTILITY_COLLISIONS = ["grid", "grow", "sr-only"] as const;

/** Of those, the ones a migrated file may not use at all. */
export const FORBIDDEN_IN_MIGRATED_SOURCES = ["grid", "grow"] as const;

/**
 * Classes that legitimately generate no CSS.
 *
 * `group` and `peer` are markers Tailwind reads on other elements' variants.
 */
export const NON_UTILITY_CLASSES = ["group", "peer"] as const;
