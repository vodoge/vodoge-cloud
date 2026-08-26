import assert from "node:assert/strict";
import { test } from "node:test";
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
 * palette it would have judged was already being replaced. The sweep at the
 * bottom of this file is that assertion, and its backdrop set is derived the
 * same way everything else here is.
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
 * 🔴 **Two layers deep, because the console renders two layers deep.**
 *
 * `components/conversation.tsx:377` puts a `Badge` — `bg-ok-wash` or
 * `bg-bad-wash` — inside `INBOX.messageOut`, which is `bg-accent-wash`, and the
 * whole bubble can sit on a hovered row. That is a wash on a wash on a surface,
 * and it is the backdrop that binds: `lib/tokens.test.ts` records `--bad`'s
 * worst as `--ok-wash over --ok-wash over --surface-hover` and not as anything
 * one layer up. **A single-layer sweep cannot see that cell**, which is the
 * specific reason this goes to depth two rather than one.
 *
 * The set is the full cross product rather than the pairs that nest today,
 * which is the same choice `everyBackdrop` in `lib/tokens.test.ts` makes and
 * for the same stated reason: which wash ends up inside which is a fact about
 * JSX, and no test in this app can read a `.tsx`. A superset can only ever
 * measure a colour somewhere darker than it really lands, so it errs toward
 * refusing a palette rather than passing one — the opposite of the optimistic
 * reading T049 caught T046 making, which is the error that actually ships.
 *
 * The bare surfaces are not repeated here; the sweep above owns them.
 */
function washedBackdrops(theme: string): { name: string; hex: string }[] {
  const opaque = SURFACES.map((surface) => ({
    name: `--${surface}`,
    hex: COLOURS[surface][theme],
  }));
  const once = opaque.flatMap((base) =>
    WASHES.map((wash) => ({
      name: `--${wash} over ${base.name}`,
      hex: over(COLOURS[wash][theme], base.hex),
    })),
  );
  const twice = once.flatMap((base) =>
    WASHES.map((wash) => ({
      name: `--${wash} over ${base.name}`,
      hex: over(COLOURS[wash][theme], base.hex),
    })),
  );
  return [...once, ...twice];
}

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
 * Every colour used as type, on every washed backdrop, in both themes, at the
 * same 4.5:1 the opaque sweep uses and for the same reason: a timestamp inside
 * a message bubble is `text-xs`, and `text-xs` is body text under WCAG 1.4.3
 * whatever the element is called.
 *
 * 🔴 **This is the assertion T003 measured and left unmade.** It measured the
 * four neutral tiers over a *single* wash — 41 red cells of 160 on the old
 * palette — and projected T001's dark recipe to clear it at 0 of 80. That
 * projection was right about the layer it covered and is not the whole layer:
 * at depth two the console still has cells below the bar. They are named in the
 * failure list rather than pinned here, because a pinned digit is what wedged
 * the first step of this retheme.
 */
test("every colour used as type clears 4.5:1 on every washed backdrop, in both themes", (t) => {
  const failures: string[] = [];
  let compared = 0;

  for (const theme of THEMES) {
    const backdrops = washedBackdrops(theme);
    for (const token of TEXT) {
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
      // The worst cell per token per theme, on the record every run. The full
      // matrix is 120 backdrops wide; printing the binding one for each token
      // is what a reader can actually use, and it never goes stale.
      t.diagnostic(
        `${theme} --${token} ${ink} worst ${worst.ratio.toFixed(3)} on ${worst.name} ${worst.hex}`,
      );
    }
  }

  const expected = WASHES.length * SURFACES.length * (1 + WASHES.length);
  assert.equal(compared, TEXT.length * expected * THEMES.length);
  assert.ok(compared >= 480, `only ${compared} comparisons; the wash layer collapsed`);
  assert.deepEqual(failures, []);
});
