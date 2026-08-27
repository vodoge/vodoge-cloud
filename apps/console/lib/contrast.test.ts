import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as TOKENS from "./tokens.ts";

/**
 * Every colour this console paints as type, on every surface, in every theme.
 *
 * 🔴 **Why this file exists, stated as the failure it is meant to stop.**
 * Three separate contrast cards — T046, T049, T051 — each swept a *colour*:
 * the brand green as ink, the brand green as type, the four status tones over
 * their own washes. Between them they measured a great deal. None of them
 * swept the tier list that every ordinary word in this console is painted
 * with, and so `--fg-faint` shipped at 3.200:1 on a hovered row in the dark
 * theme and 2.688:1 on one in light, while being used as real type in 21
 * recipes — `TABLE.headerCell` (`lib/tokens.ts:695`) and `SPEC.specTerm`
 * (`:837`) among them, which is to say **every column heading in the
 * product**. A column heading is not incidental text, and incidental text is
 * the only thing WCAG 1.4.3 exempts.
 *
 * `lib/tokens.test.ts` does hold one row of this matrix — `--fg-muted` over
 * the four surfaces, written when T051 moved a segmented control up a tier.
 * The concept was there. What was missing was that it was a *row* and not a
 * *sweep*: the tier above it and the two below it were measured nowhere, and
 * a row cannot notice a gap in the ladder it is one rung of.
 *
 * So the three rules this file is built on, each a direct reading of how the
 * miss happened:
 *
 * ① **Nothing here is hand-written.** The tiers, the surfaces and even the
 *    theme names are read out of `COLOR_TOKENS` and out of the recipes.
 *    A hand-written list is exactly what the three earlier cards each had, and
 *    each was complete for the colour it was about and silent about
 *    everything else. A derived list covers a tier added next month without
 *    anyone remembering this file exists — and the three coverage checks below
 *    are what stop the derived list from being quietly narrowed back into a
 *    hand-written one.
 *
 * ② **The bar is `>= 4.5`, and no ratio is pinned to its digits.** A pinned
 *    ratio says "this palette may not change"; the requirement is "this
 *    palette may not get worse". The console is mid-retheme as this is
 *    written and every number here is about to move on purpose. The exact
 *    values are not lost: the sweep prints the whole matrix as test
 *    diagnostics on every run, so the current numbers are always on the record
 *    and always current — which a literal table in this file would stop being
 *    on the first day somebody edited a colour and could not edit this file.
 *
 * ③ **This file imports `./tokens.ts` and nothing else.** No stylesheet, no
 *    Tailwind, no filesystem. That is not minimalism: it lets a mutation
 *    harness copy these two files into a scratch directory, degrade a colour
 *    in the copy, and run the guard against it without ever writing inside the
 *    repository. A guard that cannot be cheaply falsified does not get
 *    falsified.
 *
 * **The washes are covered too, and that is what T011 added.** Type does not
 * only land on an opaque surface. It lands on a translucent wash over one —
 * `--ok-wash` behind a delivery badge, `--accent-wash` behind an outbound
 * message — and on a wash over a wash, because a badge goes inside a bubble.
 * T003 measured that layer and deliberately did not assert it, because the
 * palette it would have judged was already being replaced. The sweeps at the
 * bottom of this file are that assertion, and their backdrop sets are derived
 * the same way everything else here is.
 *
 * **How deep depends on the colour, and that too is derived rather than
 * chosen.** A colour a recipe paints *on a wash of its own* is chip text, and a
 * chip can be nested inside another chip, so chips are swept two washes deep.
 * Everything else only ever inherits a wash from an ancestor and is swept one
 * deep. The reasoning, and the single sentence that voids it, are written at
 * the sweep itself rather than here, because that is where somebody about to
 * trust the green will be looking.
 *
 * ⚠️ This file is deliberately outside `tailwind.config.ts`'s `content`, which
 * names `./app/**`, `./components/**` and reaches `lib/` only through the one
 * named `./lib/tokens.ts`. Class names written in the prose above therefore
 * cannot reach the shipped stylesheet — verified by building the sheet with
 * and without a marker utility added to this file and comparing bytes, against
 * a positive-control build in which this file *was* content and the marker
 * duly appeared.
 */

/* ── The arithmetic, and a control on it ─────────────────────────────── */

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(one: string, other: string): number {
  const a = relativeLuminance(one);
  const b = relativeLuminance(other);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The negative control for everything below it.
 *
 * A `contrastRatio` that returned a large constant would satisfy every
 * threshold in this file and the sweep would be decorative — which is not a
 * hypothetical failure mode, it is the one this repository's rule about
 * mutation testing exists to catch. All three of these are fixed by the
 * specification rather than by taste: black on white is exactly 21, any colour
 * against itself is exactly 1, and `#777777` on white is the published 4.478
 * that sits just above the body-text line. The helper is a copy of the one in
 * `lib/tokens.test.ts` rather than an import, because importing a test module
 * runs its tests; the control is copied along with it so that the copy is not
 * taken on faith.
 */
test("the contrast helper reproduces ratios the specification fixes", () => {
  assert.equal(Number(contrastRatio("#000000", "#ffffff").toFixed(3)), 21);
  assert.equal(Number(contrastRatio("#10b47a", "#10b47a").toFixed(3)), 1);
  assert.equal(Number(contrastRatio("#777777", "#ffffff").toFixed(3)), 4.478);
});

/* ── Roles, derived from the table rather than listed ────────────────── */

/**
 * Every colour token, sorted into the role it plays, by name.
 *
 * The order matters and is not alphabetical: `--accent-wash` is a wash before
 * it is an accent and `--bad-ink` is ink before it is a status tone, so the
 * two qualified roles are tried before the family they are qualified out of.
 *
 * The point of classifying *all* of them rather than picking out the ones this
 * file needs is the check under it. A token matching no role is a token
 * somebody added without deciding what it is, and no sweep would grow to cover
 * it. That is exactly how `--fg-faint` stayed unmeasured: not because anyone
 * excluded it, but because no list included it and nothing complained.
 */
const ROLES: readonly (readonly [string, RegExp])[] = [
  ["text", /^fg(-|$)/],
  ["surface", /^(bg|surface)(-|$)/],
  ["line", /^line(-|$)/],
  ["wash", /-wash$/],
  ["ink", /-ink$/],
  ["fill", /^(accent|ok|warn|bad|info)(-|$)/],
];

function roleOf(name: string): string | null {
  for (const [role, pattern] of ROLES) if (pattern.test(name)) return role;
  return null;
}

const COLOURS: Record<string, Record<string, string>> = TOKENS.COLOR_TOKENS;
const NAMES: readonly string[] = Object.keys(COLOURS);

/** Which colours the recipes actually paint with a `text-…` utility. */
const TEXT_UTILITY: RegExp = /(?:^|\s)(?:[a-z-]+:)*text-([a-z0-9-]+)(?=\s|$)/g;

function everyRecipeString(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) everyRecipeString(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) everyRecipeString(item, out);
  return out;
}

function paintedAsType(): string[] {
  const found = new Set<string>();
  for (const recipe of everyRecipeString(TOKENS)) {
    for (const match of recipe.matchAll(TEXT_UTILITY)) {
      if (Object.hasOwn(COLOURS, match[1])) found.add(match[1]);
    }
  }
  return [...found].sort();
}

/**
 * The tiers this file sweeps: a union of two derivations, neither sufficient
 * alone.
 *
 * **By name** — the `--fg-*` family — because a tier can be declared before
 * any recipe uses it, and the retheme in progress adds one. Usage alone would
 * leave it unmeasured until somebody happened to paint with it.
 *
 * **By use** — anything a recipe paints with a `text-…` utility — because the
 * family prefix is a convention and the status tones are the standing proof it
 * does not hold: `--ok`, `--warn`, `--bad` and `--info` are read as words in
 * fourteen recipes and are not named `fg-` anything. Sorting them out of this
 * sweep on the strength of their names, on the argument that some other file
 * covers them, is the precise move that lost `--fg-faint`.
 *
 * The inks are the one deduction, and it is by role rather than by name: an
 * ink is painted *on its own fill* and never on a surface, so measuring it
 * against `--bg` would be measuring it somewhere it never appears — the
 * mistake T049 caught T046 making, which reads optimistically and is worse
 * than not measuring. `lib/tokens.test.ts` sweeps each ink over the fills it
 * really lands on.
 */
const TEXT: readonly string[] = [
  ...new Set([
    ...NAMES.filter((name) => roleOf(name) === "text"),
    ...paintedAsType().filter((name) => roleOf(name) !== "ink"),
  ]),
].sort();

/**
 * 🔴 **Not de-duplicated by value, on purpose.** When this was written the
 * light theme ran `--surface` and `--surface-raised` at the same `#ffffff`, so
 * two of these columns carried identical numbers — a four-step ladder
 * flattened to three distinct values, which is a defect in its own right.
 * T001 has since given all four distinct values in both themes, so the
 * duplication is gone; the rule stays because collapsing equal columns is what
 * would have hidden it, and the next flattening is the one nobody has seen yet.
 */
const SURFACES: readonly string[] = NAMES.filter((name) => roleOf(name) === "surface");

/**
 * Even the theme names are read out of the table, so a third theme is swept
 * the day it is added rather than the day somebody notices it was not.
 */
const THEMES: readonly string[] = [
  ...new Set(Object.values(COLOURS).flatMap((value) => Object.keys(value))),
].sort();

/* ── Coverage: three independent ways for a gap to go red ────────────── */

/**
 * ① Nothing in the table is unclassified.
 *
 * Add a colour token — any colour token — whose name fits none of the six
 * families above and this fails, naming it. That is the tripwire for the
 * failure this whole file is about: a new token arriving and no sweep growing
 * to include it.
 */
test("every colour token has a role, so a new one cannot arrive unnoticed", () => {
  const unclassified = NAMES.filter((name) => roleOf(name) === null);
  assert.deepEqual(
    unclassified,
    [],
    `colour tokens with no role — decide what they are and the sweeps follow: ${unclassified.join(", ")}`,
  );
  // Non-vacuity: a `roleOf` that answered "text" to everything would satisfy
  // the assertion above and wreck the sweep. Every family must have members.
  const populated = [...new Set(NAMES.map((name) => roleOf(name)))].sort();
  assert.deepEqual(populated, ROLES.map(([role]) => role).sort());
});

/**
 * ② The swept list is as large as the two derivations that feed it.
 *
 * The realistic regression is not somebody deleting this file. It is somebody
 * narrowing one of the patterns above, for a reason that looks perfectly good
 * in a diff, and taking a tier out of the sweep without the sweep getting
 * visibly smaller. Restating each derivation a second way makes that edit
 * disagree with itself.
 */
test("the sweep covers every colour used as type, not a hand-written subset", () => {
  const familyByPrefix = NAMES.filter((name) => name === "fg" || name.startsWith("fg-"));
  const usedByRole = paintedAsType().filter((name) => !name.endsWith("-ink"));
  const expected = [...new Set([...familyByPrefix, ...usedByRole])].sort();

  assert.deepEqual(TEXT, expected);
  assert.equal(TEXT.length, expected.length);
  assert.equal(TEXT.length, new Set(TEXT).size);

  const surfacesByPrefix = NAMES.filter(
    (name) => name === "bg" || name === "surface" || name.startsWith("surface-"),
  );
  assert.deepEqual(SURFACES, surfacesByPrefix);

  assert.ok(TEXT.length >= 6, `only ${TEXT.length} colours swept as type; the derivation collapsed`);
  assert.ok(SURFACES.length >= 4, `only ${SURFACES.length} surfaces found`);
  assert.deepEqual(THEMES, ["dark", "light"]);
});

/**
 * ③ Anything a recipe paints as type is swept by somebody.
 *
 * The two checks above are about names and counts. This one is about use,
 * which is the only signal that would have caught `--fg-faint` on the day it
 * was written whatever it had been called: it was painted with `text-` in 21
 * recipes and nothing anywhere looked at that fact.
 *
 * A colour painted as type is allowed to be one of exactly two things: swept
 * over the surfaces below, or ink — swept in `lib/tokens.test.ts` over the fill
 * it is actually painted on. A surface used as type, a line colour used as
 * type, a token with no role: each of those is a colour being read that no
 * sweep is measuring, and each goes red here.
 */
test("every colour a recipe paints as type is swept by some sweep", () => {
  const painted = paintedAsType();
  // Non-vacuity: if the walk or the pattern breaks, this finds nothing and
  // every assertion under it passes for the wrong reason.
  assert.ok(
    painted.length >= 6,
    `only ${painted.length} colours found painted as type; the recipe walk is broken, not the palette`,
  );
  const unswept = painted.filter((name) => !TEXT.includes(name) && roleOf(name) !== "ink");
  assert.deepEqual(
    unswept,
    [],
    `painted with a text- utility but in no sweep's remit: ${unswept.join(", ")}`,
  );
});

/* ── The sweep ───────────────────────────────────────────────────────── */

/**
 * Every colour used as type, on every surface, in every theme, against 4.5:1.
 *
 * 4.5 and not 3.0 because these are painted at `text-xs` and `text-sm`, which
 * is body text under WCAG 1.4.3 whatever it labels; the 3:1 relaxation is for
 * 18pt, or 14pt bold, and nothing in this console's type scale reaches either.
 *
 * Failing cells are collected and compared as a list rather than asserted one
 * at a time on purpose: a failing run should print *every* cell that is short,
 * so a palette is repaired once instead of once per run.
 */
test("every colour used as type clears 4.5:1 on every surface, in both themes", (t) => {
  const failures: string[] = [];
  let compared = 0;

  for (const theme of THEMES) {
    for (const token of TEXT) {
      const ink = COLOURS[token][theme];
      const cells: string[] = [];
      for (const surface of SURFACES) {
        const backdrop = COLOURS[surface][theme];
        const ratio = contrastRatio(ink, backdrop);
        compared += 1;
        cells.push(`--${surface} ${ratio.toFixed(3)}`);
        if (ratio < 4.5) {
          failures.push(`${theme}: --${token} ${ink} on --${surface} ${backdrop} = ${ratio.toFixed(3)}:1`);
        }
      }
      // The exact values, on the record every run and never stale. This is
      // what rule ② at the top replaces a pinned table with.
      t.diagnostic(`${theme} --${token} ${ink} | ${cells.join(" | ")}`);
    }
  }

  // The sweep performed the number of comparisons the derived lists imply, so
  // a list that emptied itself cannot pass by measuring nothing.
  assert.equal(compared, TEXT.length * SURFACES.length * THEMES.length);
  assert.ok(compared >= 48, `only ${compared} comparisons; the sweep collapsed`);
  assert.deepEqual(failures, []);
});

/* ── The wash layer ──────────────────────────────────────────────────── */

/**
 * Compositing a translucent wash over an opaque backdrop, the way a browser
 * does: `alpha * front + (1 - alpha) * back`, per channel, in sRGB.
 *
 * This is a second copy of the helper in `lib/tokens.test.ts` for the same
 * reason `contrastRatio` above is: importing a test module runs its tests. A
 * copy that is not checked is a fork waiting to disagree, so the control under
 * it is not decoration — and the two identities it pins are fixed by the
 * arithmetic rather than by any palette, so they cannot go stale when a colour
 * moves.
 */
function over(wash: string, backdrop: string): string {
  const parsed = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(wash);
  assert.notEqual(parsed, null, `not an rgba() wash: ${wash}`);
  const alpha = Number(parsed![4]);
  const front = [1, 2, 3].map((at) => Number(parsed![at]));
  const base = [1, 3, 5].map((at) => parseInt(backdrop.slice(at, at + 2), 16));
  return `#${front
    .map((c, i) => Math.round(alpha * c + (1 - alpha) * base[i]))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * The negative control on the compositor, in the same shape as the one on
 * `contrastRatio`. A version of `over` that ignored its alpha and returned the
 * backdrop would make every cell below identical to a cell already swept, and
 * the wash layer would silently measure nothing at all — the vacuous pass this
 * repository has shipped twice under a different mechanism.
 *
 * All three are fixed by the definition of alpha compositing and by nothing
 * else: at alpha 0 the wash is absent, at alpha 1 it is opaque and replaces the
 * backdrop entirely, and a half-strength white over black is the midpoint.
 */
test("the compositor is alpha compositing and not a passthrough", () => {
  assert.equal(over("rgba(255, 255, 255, 0)", "#123456"), "#123456");
  assert.equal(over("rgba(18, 52, 86, 1)", "#ffffff"), "#123456");
  assert.equal(over("rgba(255, 255, 255, 0.5)", "#000000"), "#808080");
});

/**
 * The washes, derived twice over, exactly as the tiers above are.
 *
 * **By name** — the `-wash` role — because a wash can be declared before any
 * recipe paints it, which is the case the retheme keeps producing.
 *
 * **By use** — anything a recipe paints with a `bg-…-wash` utility — because a
 * role pattern is a convention and narrowing one is the realistic regression.
 *
 * Hand-writing this list is the move the whole file is against, and it is not
 * hypothetical here: `lib/tokens.test.ts` hand-writes `["accent-wash",
 * "ok-wash"]` as the pair a *green* sits on, which was right for the card that
 * wrote it and is not a list of every wash in the console. There are five.
 */
const WASH_BACKGROUND: RegExp = /(?:^|\s)(?:[a-z-]+:)*bg-([a-z0-9-]+-wash)(?=\s|$)/g;

function paintedAsWash(): string[] {
  const found = new Set<string>();
  for (const recipe of everyRecipeString(TOKENS)) {
    for (const match of recipe.matchAll(WASH_BACKGROUND)) {
      if (Object.hasOwn(COLOURS, match[1])) found.add(match[1]);
    }
  }
  return [...found].sort();
}

const WASHES: readonly string[] = [
  ...new Set([...NAMES.filter((name) => roleOf(name) === "wash"), ...paintedAsWash()]),
].sort();

/**
 * Backdrops washed `depth` times over each opaque surface.
 *
 * The set at each layer is the full cross product rather than the pairs that
 * nest today, which is the same choice `everyBackdrop` in `lib/tokens.test.ts`
 * makes and for the same stated reason: which wash ends up inside which is a
 * fact about JSX, and no test in this app can read a `.tsx`. A superset can
 * only ever measure a colour somewhere *darker* than it really lands, so it
 * errs toward refusing a palette rather than passing one — the opposite
 * polarity to the optimistic reading T049 caught T046 making, which is the
 * error that actually ships.
 *
 * The bare surfaces are not repeated here; the sweep above owns them.
 */
function washedBackdrops(theme: string, depth: number): { name: string; hex: string }[] {
  let layer = SURFACES.map((surface) => ({
    name: `--${surface}`,
    hex: COLOURS[surface][theme],
  }));
  const all: { name: string; hex: string }[] = [];
  for (let at = 0; at < depth; at += 1) {
    layer = layer.flatMap((base) =>
      WASHES.map((wash) => ({
        name: `--${wash} over ${base.name}`,
        hex: over(COLOURS[wash][theme], base.hex),
      })),
    );
    all.push(...layer);
  }
  return all;
}

/**
 * 🔴 **How deep a token can be washed, derived from the recipes.**
 *
 * A **chip** is a colour a recipe paints as text *in the same recipe that
 * paints a wash behind it* — `BADGE.tone.ok` is `bg-ok-wash text-ok`,
 * `SHELL.navLinkCurrent` is `bg-accent-wash … text-fg-accent`. A chip is a
 * self-contained tinted thing, and a chip can be put inside another tinted
 * thing: `components/conversation.tsx:377` renders a `Badge` inside
 * `INBOX.messageOut`, which is `bg-accent-wash`. **Two layers is a real
 * constraint for a chip**, and `lib/tokens.test.ts` sweeps it as such.
 *
 * ⚠️ **Where the second layer stops being observed and starts being
 * combinatorial — T010 had to correct this passage to say so.** It used to end
 * "on a row that can be hovered", and to call the two-deep worst cell #284f3e
 * "the backdrop that binds `--bad`". Neither survives a look at the source.
 * The conversation is an `ol`/`li` carrying no background and no hover variant
 * — the only `hover:bg-surface-hover` is `TABLE.row`, which is not in that
 * subtree — and #284f3e is `--ok-wash` doubled, while the app's only
 * `bg-ok-wash` is `BADGE.tone.ok`, so **no rendered stack produces it**. The
 * deepest stack that really is painted is a `--bad-wash` badge inside that
 * neutral bubble, #413030.
 *
 * 🔴 **The cross product below is kept anyway, and that is a decision rather
 * than an oversight.** `washedBackdrops` gives the reason in its own words:
 * which wash ends up inside which is a fact about JSX, no test in this app can
 * read a `.tsx`, and a superset can only ever measure a colour somewhere
 * darker than it really lands. It is not a claim about what renders — it is a
 * refusal to let what happens to render this month decide what gets measured.
 *
 * Everything else painted as type is **ladder** text: ordinary words and
 * metadata that never carry a wash of their own and only ever *inherit* one
 * from an ancestor.
 *
 * The split is by **use and never by name**, which is the whole point of
 * deriving it. `--fg-accent` is an `fg-*` token and lands in `CHIP` anyway,
 * because `SHELL.navLinkCurrent` paints it on `bg-accent-wash`; `--ok`,
 * `--warn`, `--bad` and `--info` land there for the same reason and not
 * because of what they are called. Sorting colours by the family in their name
 * is the move that lost `--fg-faint`, and nothing here does it.
 */
const WASH_AND_TEXT: RegExp = /(?:^|\s)(?:[a-z-]+:)*bg-[a-z0-9-]+-wash(?=\s|$)/;

function paintedOnItsOwnWash(): string[] {
  const found = new Set<string>();
  for (const recipe of everyRecipeString(TOKENS)) {
    if (!WASH_AND_TEXT.test(recipe)) continue;
    for (const match of recipe.matchAll(TEXT_UTILITY)) {
      if (Object.hasOwn(COLOURS, match[1])) found.add(match[1]);
    }
  }
  return [...found].sort();
}

const CHIP: readonly string[] = TEXT.filter((token) => paintedOnItsOwnWash().includes(token));
const LADDER: readonly string[] = TEXT.filter((token) => !CHIP.includes(token));

/**
 * ④ The wash list is as large as the two derivations that feed it, restated
 * the same way the tier list is, so narrowing either pattern makes the file
 * disagree with itself instead of quietly sweeping fewer backdrops.
 */
test("the wash list is derived from both the roles and the recipes", () => {
  const byName = NAMES.filter((name) => name.endsWith("-wash"));
  const byUse = paintedAsWash();
  assert.deepEqual(WASHES, [...new Set([...byName, ...byUse])].sort());

  /**
   * 🔴 The by-name half must agree with the **role table**, not merely with
   * itself. Found by mutation, and it was a genuine hole: narrowing the `wash`
   * role to one literal lets `--accent-wash` and the rest fall through to
   * `fill` rather than becoming unclassified, so the role test stays green —
   * and the by-use half of the union above quietly puts them back, so the
   * sweep stays the same size and every other assertion here is satisfied.
   * Without this line that edit is an equivalent mutant and the role table can
   * be narrowed for free. With it, the two derivations disagree and it fails.
   */
  assert.deepEqual(NAMES.filter((name) => roleOf(name) === "wash"), byName);

  // Non-vacuity on each half separately: either one silently returning nothing
  // would leave the union looking healthy while half the derivation was dead.
  assert.ok(byName.length >= 4, `only ${byName.length} washes by name`);
  assert.ok(byUse.length >= 4, `only ${byUse.length} washes painted as a background`);
  assert.deepEqual(byUse.filter((name) => !byName.includes(name)), []);

  // Every wash is an rgba() with an alpha strictly between 0 and 1. A wash that
  // had become an opaque hex would composite to itself on every surface and
  // collapse the whole layer to one column per theme.
  for (const wash of WASHES) {
    for (const theme of THEMES) {
      const alpha = /^rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)$/.exec(COLOURS[wash][theme]);
      assert.notEqual(alpha, null, `--${wash} ${theme} is not an rgba() wash`);
      assert.ok(Number(alpha![1]) > 0 && Number(alpha![1]) < 1, `--${wash} ${theme} alpha`);
    }
  }
});

/**
 * ⑤ Every colour painted as type is a chip or it is ladder, and the two are
 * told apart by use rather than by name.
 *
 * 🔴 This is also the **mechanical half of the exception below**. The ladder is
 * swept one wash deep on the argument that ladder text never carries a wash of
 * its own. The moment somebody writes a recipe that paints a ladder colour on a
 * wash, that argument is false — and this fails, here, naming the token,
 * instead of the sweep quietly measuring one layer too few.
 */
test("every colour painted as type is either a chip or ladder text", () => {
  assert.deepEqual([...CHIP, ...LADDER].sort(), [...TEXT].sort());
  assert.equal(CHIP.filter((token) => LADDER.includes(token)).length, 0);

  // Non-vacuity on both halves: an empty CHIP would make the exception below
  // vacuous, and an empty LADDER would make the sweep below measure nothing.
  assert.ok(CHIP.length >= 4, `only ${CHIP.length} chip colours; the derivation collapsed`);
  assert.ok(LADDER.length >= 3, `only ${LADDER.length} ladder colours; the derivation collapsed`);

  /**
   * 🔴 **The tripwire, and it has to read the recipes to be worth anything.**
   *
   * `LADDER` is *defined* as `TEXT` minus `CHIP`, so asserting that no ladder
   * token is painted on a wash is true by construction and tests nothing —
   * a vacuous green of exactly the kind the negative control at the top of this
   * file exists to prevent. The question worth asking is about the **tier
   * family**, which is derived from names and so cannot absorb the change:
   * *which type tiers do the recipes paint on a wash?*
   *
   * Exactly one may, and it is `--fg-accent`, because `--accent-wash` exists
   * precisely to carry it — `SHELL.navLinkCurrent` is the current navigation
   * item. Any *second* tier appearing here means a tier has become chip text,
   * which is the recipe-visible half of the falsification condition written out
   * below: that tier can now reach two wash layers, and the one-layer exception
   * no longer covers it.
   */
  const tiersOnAWash = NAMES.filter(
    (name) => roleOf(name) === "text" && paintedOnItsOwnWash().includes(name),
  );
  assert.deepEqual(
    tiersOnAWash,
    ["fg-accent"],
    `a type tier other than the accent is painted on a wash, so it is chip text ` +
      `now and can reach two wash layers — the one-layer ladder exception below ` +
      `no longer covers it: ${tiersOnAWash.join(", ")}`,
  );
});

/**
 * The ladder, one wash deep, in both themes, at the same 4.5:1 the opaque
 * sweep uses and for the same reason: a timestamp inside a message bubble is
 * `text-xs`, and `text-xs` is body text under WCAG 1.4.3 whatever it labels.
 *
 * 🔴 **This is the assertion T003 measured and left unmade** — the same 160
 * cells it measured (four tiers × four surfaces × five washes × two themes),
 * promoted now that T001's palette has landed.
 *
 * ── 🔴 WHY ONE LAYER FOR THE LADDER, AND WHEN THAT STOPS BEING TRUE ────────
 *
 * The chips above are swept two washes deep because a chip can be put inside
 * another chip. **Ladder text cannot.** It is body copy and metadata —
 * timestamps, column headings, hints — and the thing that creates a second
 * wash is a *badge*, which contains a status word and never contains metadata.
 * In `components/conversation.tsx` this is visible directly: `INBOX.metaTime`
 * and `INBOX.binaryNote` are **siblings of the `Badge`, not children of it**,
 * so they sit on the one `accent-wash` of the bubble and no deeper. Two layers
 * is a real constraint for a chip and an **unreachable** superset for ladder
 * text.
 *
 * 🔴 **WHAT VOIDS THIS EXCEPTION — read this before trusting the green.**
 * **If ladder text is ever placed inside a badge, or inside any other element
 * that carries a wash of its own, this exception is immediately invalid and
 * the ladder must go to two layers like the chips.** The test above catches the
 * half of that which is visible to a test — a recipe painting a ladder colour
 * on a wash. It **cannot** catch the other half: a `.tsx` nesting a
 * `text-fg-faint` span *inside* a `<Badge>`. No test in this app can read a
 * `.tsx`. That case is yours to notice, and this paragraph is the only warning
 * you will get.
 *
 * 🔴 **WHAT IT COSTS IF THE EXCEPTION IS WRONG.** Not hypothetical — measured,
 * and emitted as a diagnostic on every run so it can never go stale. On the
 * palette current as this is written the ladder's worst cell at two layers is
 * `--fg-faint` at **3.831** on `--ok-wash over --ok-wash over --surface-hover`
 * (`#284f3e`), and the next one down is **3.893** on `--ok-wash over
 * --accent-wash over --surface-hover` (`#364b42`). Both are short. So this
 * exception is load-bearing: it is the only reason the ladder is green, and
 * the number it is holding back is printed beside it every time the suite
 * runs.
 *
 * ⚠️ **`#364b42` used to be described here as "the *real* nesting rather than
 * the superset" — an `ok-wash` badge inside the `accent-wash` bubble on a
 * hovered row. It is not.** Its third layer is `--surface-hover`, so it needs
 * a row that can be hovered, and §456-465 above has already struck exactly
 * that claim: the conversation is an `ol`/`li` with no hover variant, and the
 * only `hover:bg-surface-hover` is `TABLE.row`, which is not in that subtree.
 * The correction was made there and never carried down to here. **Both
 * numbers are combinatorial supersets; neither is a stack anyone has seen.**
 *
 * The conclusion is unchanged, and that is worth saying plainly rather than
 * quietly deleting a sentence. Take only stacks that really are painted — no
 * hover — and the same cell is `--ok-wash over --accent-wash over --surface`
 * at 4.757, which passes, but `… over --surface-raised` at **4.341**, which
 * still does not. The exception is holding something real either way; it was
 * only the label that was wrong.
 *
 * `--fg-faint` at one layer is 5.201, which is the margin actually being
 * relied on.
 */
test("the neutral ladder clears 4.5:1 one wash deep, in both themes", (t) => {
  const failures: string[] = [];
  let compared = 0;

  for (const theme of THEMES) {
    const backdrops = washedBackdrops(theme, 1);
    for (const token of LADDER) {
      const ink = COLOURS[token][theme];
      let worst = { ratio: Infinity, name: "", hex: "" };
      for (const backdrop of backdrops) {
        const ratio = contrastRatio(ink, backdrop.hex);
        compared += 1;
        if (ratio < worst.ratio) worst = { ratio, name: backdrop.name, hex: backdrop.hex };
        if (ratio < 4.5) {
          failures.push(
            `${theme}: --${token} ${ink} on ${backdrop.name} ${backdrop.hex} = ${ratio.toFixed(3)}:1`,
          );
        }
      }
      t.diagnostic(
        `${theme} --${token} ${ink} worst ${worst.ratio.toFixed(3)} on ${worst.name} ${worst.hex}`,
      );
    }

    // 🔴 The price of the exception, current every run. If this number is at or
    // above 4.5 the exception has stopped costing anything and the ladder
    // should simply be swept two deep; if it drops further, the exception is
    // carrying more weight than it was when it was argued for. Either way the
    // next reader sees it without re-deriving it.
    const deeper = washedBackdrops(theme, 2);
    let sunk = { ratio: Infinity, token: "", name: "" };
    for (const token of LADDER) {
      for (const backdrop of deeper) {
        const ratio = contrastRatio(COLOURS[token][theme], backdrop.hex);
        if (ratio < sunk.ratio) sunk = { ratio, token, name: backdrop.name };
      }
    }
    t.diagnostic(
      `${theme} NOT ASSERTED — ladder at two washes would be worst ` +
        `${sunk.ratio.toFixed(3)} (--${sunk.token} on ${sunk.name})`,
    );
  }

  assert.equal(compared, LADDER.length * WASHES.length * SURFACES.length * THEMES.length);
  assert.ok(compared >= 120, `only ${compared} comparisons; the wash layer collapsed`);
  assert.deepEqual(failures, []);
});

/**
 * The chips, two washes deep.
 *
 * 🔴 **The dark half is deferred to `lib/tokens.test.ts`, which now asserts
 * it.** T010 raised `--bad` to `#ffa9ac` and `--info` to `#97c3ff`, and the pin
 * there is no longer three recorded numbers: it sweeps all three dark status
 * colours over all 52 of their backdrops and asserts the bar. This file
 * reproduces its worst cells — 5.058 and 5.077 on `--ok-wash over --ok-wash
 * over --surface-hover` — to the digit from an independent derivation, so the
 * claim that they are covered there is checked rather than believed, which is
 * the difference between this and excluding a colour because some other file
 * is *assumed* to handle it, the move that lost `--fg-faint`.
 *
 * ⚠️ **This passage used to describe the dark half as "a known, recorded
 * shortfall that predates this card"**, citing 3.062 and 3.637 under the
 * heading "measured, not fixed, and the next card's baseline". T010 is the card
 * that moved it. The heading and both numbers are gone, and leaving the
 * citation would have aimed the next reader at a file that no longer says any
 * of it.
 *
 * So: the light half is asserted here, the dark half is emitted as diagnostics
 * with its owner named, and no digit is pinned here. Asserting the dark half
 * would not add coverage — it would duplicate an assertion the owning file now
 * makes, from a file that could not fix a failure in it.
 */
test("the chips clear 4.5:1 two washes deep in light, and dark is on the record", (t) => {
  const failures: string[] = [];

  for (const theme of THEMES) {
    const backdrops = washedBackdrops(theme, 2);
    assert.ok(
      backdrops.length > WASHES.length * SURFACES.length,
      "the chip backdrop set is not actually two washes deep",
    );
    for (const token of CHIP) {
      const ink = COLOURS[token][theme];
      let worst = { ratio: Infinity, name: "", hex: "" };
      for (const backdrop of backdrops) {
        const ratio = contrastRatio(ink, backdrop.hex);
        if (ratio < worst.ratio) worst = { ratio, name: backdrop.name, hex: backdrop.hex };
      }
      if (theme === "light" && worst.ratio < 4.5) {
        failures.push(
          `light: --${token} ${ink} on ${worst.name} ${worst.hex} = ${worst.ratio.toFixed(3)}:1`,
        );
      }
      t.diagnostic(
        `${theme} --${token} ${ink} worst ${worst.ratio.toFixed(3)} on ${worst.name} ${worst.hex}` +
          (theme === "dark" && worst.ratio < 4.5 ? "  [SHORT — recorded in lib/tokens.test.ts]" : ""),
      );
    }
  }

  assert.deepEqual(failures, []);
});

/* ── Shape: a radius is applied by name, never as a number ───────────── */

/**
 * 🔴 **A 4px focus ring around an 8px control, past 345 tests and two
 * adversarial reviewers.**
 *
 * `app/globals.css` said `border-radius: 4px` under `:focus-visible`. 4px was
 * the middle step of the *old* hand-written scale — 3px, 4px, 6px — and when
 * T001 replaced those three literals with one base and three ratios, every
 * token moved and this number did not, because it is not a token. It is a
 * number written into a rule body, and the parity tests compare token
 * *declarations* against `lib/tokens.ts`, agree perfectly, and cannot see it.
 * That is the shape of the miss and it is what this guard is about: **a scale
 * only protects the values that are read from it.**
 *
 * ⚠️ **It had decayed twice, and the second decay is the quieter one.** At
 * `8cb8302`, where the declaration was written, this file contained no
 * `@layer` at all, so the rule was unlayered and the 4px really did reshape
 * every focused control. `10b81c0` wrapped the file in `@layer tokens` so the
 * reset could be outranked by the utilities — and unlayered CSS beats layered
 * CSS whatever the specificity, so the same wrapper quietly took the
 * declaration away from every control that carries a corner utility, leaving
 * it live only on the ones that carry none. Measured in Chrome against this
 * build, injecting a 4px rule into `@layer tokens`: beside the unlayered
 * control utility it computes **8px**, beside the unlayered pill utility
 * **999px**, and with nothing competing **4px** — the last being the positive
 * control that proves the first two are a cascade result and not a dead probe.
 *
 * So this guard is deliberately **not** "the focus ring must be 8px". Pinning
 * the number would recreate the defect one scale change from now. It is: *a
 * radius is applied by name.* A number cannot follow a base, and neither way
 * this one failed — going stale, then going inert — is visible to a check that
 * compares token declarations to each other.
 *
 * ⚠️ **Two files, derived rather than listed.** `public/offline.html` hand-
 * writes its own stylesheet and ships to users as the PWA offline page. It is
 * read by `lib/pwa.test.ts`, but that file's subject is the palette — a list
 * of hexes — so a radius in it is not checked loosely there, it is
 * structurally invisible. The set below is walked out of `app/`, `public/` and
 * `components/` instead of typed out, because a hand-typed set of "the
 * stylesheets we shipped" is exactly the thing that is complete on the day it
 * is written and silent about the one added afterwards.
 */

const consoleRoot: string = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every stylesheet this console ships and hand-writes, found rather than listed. */
function shippedStylesheets(): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(join(consoleRoot, relative));
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const next = `${relative}/${entry}`;
      if (statSync(join(consoleRoot, next)).isDirectory()) {
        walk(next);
      } else if (entry.endsWith(".css")) {
        found.push(next);
      } else if (entry.endsWith(".html") && readFileSync(join(consoleRoot, next), "utf8").includes("<style")) {
        found.push(next);
      }
    }
  };
  for (const top of ["app", "public", "components"]) walk(top);
  return found;
}

type RadiusExemption = {
  readonly file: string;
  readonly declaration: string;
  readonly reason: string;
};

/**
 * 🔴 **An exemption is one exact declaration and one stated reason.**
 *
 * Not a file, not a pattern. The next stray radius in an exempted file still
 * fails, because it will not be this string. And an exemption that no longer
 * matches anything fails too — a reason for a defect that has been fixed is a
 * note aimed at the wrong reader, and the check below makes it impossible to
 * leave one behind.
 */
const RADIUS_EXEMPTIONS: readonly RadiusExemption[] = [
  {
    file: "public/offline.html",
    declaration: "border-radius:12px",
    reason:
      "The offline page's mark. 12px is off the 8/10/14 scale and belongs to a token, " +
      "but public/offline.html is not in T008's allowed_files and this card may not edit " +
      "it. Recorded rather than skipped: the file is scanned, so the next stray radius in " +
      "it still fails. Needs its own card — the fix also has to bump the service worker " +
      "cache version, which lib/pwa.test.ts asserts and this card cannot reach.",
  },
];

/** A number with a length unit: what a radius must not be written as. */
const BARE_LENGTH: RegExp = /(?:^|[\s(,*/+-])\d*\.?\d+\s*(?:px|rem|em|ch|vh|vw|%)/i;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/<!--[\s\S]*?-->/g, " ");
}

/**
 * Every declaration whose property names a radius.
 *
 * `defining` separates the two kinds. A custom property — `--radius-base` and
 * the steps derived from it — is where the scale is *written*, and has to hold
 * a number somewhere or there would be no scale; those values are pinned
 * against `lib/tokens.ts` by `lib/tokens.test.ts`, and re-asserting them here
 * would point a second comparator at one oracle. Everything else *applies* a
 * radius, and that is what may not be a number.
 */
function radiusDeclarations(source: string): { property: string; value: string; text: string; defining: boolean }[] {
  const out: { property: string; value: string; text: string; defining: boolean }[] = [];
  // A declaration ends at `;` or `}` — and, inside an HTML `style="…"`, at the
  // quote that closes the attribute. Leaving the quotes out of this class let
  // the probe's inline attribute swallow the markup after it and the next
  // selector with it, which is the whole reason the probe is a probe.
  for (const match of withoutComments(source).matchAll(/([-a-z]*radius[-a-z]*)\s*:\s*([^;{}"'<>]+)/gi)) {
    const property = match[1];
    const value = match[2].trim();
    out.push({
      property,
      value,
      text: `${property}:${value}`.replace(/\s+/g, ""),
      defining: property.startsWith("--"),
    });
  }
  return out;
}

/** The applying declarations that write a number instead of reading one. */
function bareRadii(source: string): string[] {
  return radiusDeclarations(source)
    .filter((one) => !one.defining && BARE_LENGTH.test(one.value))
    .map((one) => one.text);
}

/**
 * A sheet shaped like the two real ones, with the answer known in advance.
 *
 * Finding nothing and being broken look identical from here, which is the
 * failure this repo has recorded twice. Every line below is one thing the
 * scanner has to get right: the defect as it actually appeared, the same
 * defect written long-hand and spaced out, an inline attribute, a shape that
 * is legitimately its own length, the scale's own definitions, and the two
 * forms of a radius correctly read from the scale.
 */
const RADIUS_PROBE: string = [
  ":focus-visible { outline: 2px solid red; outline-offset: 2px; border-radius: 4px; }",
  ".mark { width:40px; height:40px; border-radius:12px; }",
  ".corner { border-bottom-left-radius : 0.5rem ; }",
  '<span style="border-radius:50%"></span>',
  ":root { --radius-base: 10px; --radius: calc(var(--radius-base) * 0.8); --radius-pill: 999px; }",
  ".card { border-radius: var(--radius-lg); }",
  ".chip { border-radius: var(--radius-pill); }",
  ".flat { border-radius: 0; }",
  "/* border-radius: 77px in a comment is not a declaration */",
].join("\n");

test("the radius scanner sees a number and lets a name through", () => {
  assert.deepEqual(bareRadii(RADIUS_PROBE), [
    "border-radius:4px",
    "border-radius:12px",
    "border-bottom-left-radius:0.5rem",
    "border-radius:50%",
  ]);

  // The other half, stated as its own assertion so a scanner that flagged
  // everything would not pass the line above by accident.
  const declarations = radiusDeclarations(RADIUS_PROBE);
  assert.deepEqual(
    declarations.filter((one) => one.defining).map((one) => one.property),
    ["--radius-base", "--radius", "--radius-pill"],
    "the scanner has stopped telling the scale's definition from its use",
  );
  assert.equal(
    declarations.filter((one) => !one.defining && !BARE_LENGTH.test(one.value)).length,
    3,
    "a radius read from the scale, or set to zero, is being called a bare number",
  );
});

test("every shipped stylesheet applies a radius by name, never as a number", () => {
  const sheets = shippedStylesheets();
  assert.ok(
    sheets.includes("app/globals.css"),
    `the stylesheet walk found ${sheets.length ? sheets.join(", ") : "nothing"} and missed app/globals.css`,
  );

  const exempt = new Set(RADIUS_EXEMPTIONS.map((one) => `${one.file}  ${one.declaration}`));
  const offenders: string[] = [];
  let scanned = 0;

  for (const sheet of sheets) {
    const source = readFileSync(join(consoleRoot, sheet), "utf8");
    scanned += radiusDeclarations(source).length;
    for (const declaration of bareRadii(source)) {
      const key = `${sheet}  ${declaration}`;
      if (!exempt.has(key)) offenders.push(key);
    }
  }

  assert.ok(scanned > 0, "no radius declaration was read at all, so this check is vacuous");
  assert.deepEqual(
    offenders,
    [],
    "a radius is written as a number instead of read from the scale; move it to a token, " +
      "or add it to RADIUS_EXEMPTIONS with a reason",
  );
});

test("every radius exemption carries a reason, and none outlives its defect", () => {
  for (const exemption of RADIUS_EXEMPTIONS) {
    assert.ok(
      exemption.reason.trim().length >= 40,
      `the exemption for ${exemption.declaration} in ${exemption.file} has no reason worth reading; ` +
        "an exception without one is the next defect",
    );

    // Stale exemptions are the other direction of the same fault: a reason
    // that outlives its defect aims the next reader at nothing.
    const source = readFileSync(join(consoleRoot, exemption.file), "utf8");
    assert.ok(
      bareRadii(source).includes(exemption.declaration),
      `${exemption.file} no longer contains \`${exemption.declaration}\` — the defect is fixed, ` +
        "so delete this exemption rather than leaving a reason pointing at nothing",
    );
  }

  // The reason requirement, proved on entries that break it. An empty list and
  // a rule that never fires are the same output.
  const missing = [
    { file: "x.css", declaration: "border-radius:1px", reason: "" },
    { file: "x.css", declaration: "border-radius:2px", reason: "legacy" },
  ].filter((one) => one.reason.trim().length < 40);
  assert.equal(missing.length, 2, "the reason requirement has stopped rejecting a bare excuse");
});
