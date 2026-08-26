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
 * **What this file does not cover, said out loud rather than left implied.**
 * The backdrops swept here are the four opaque surfaces. Type also lands on a
 * translucent wash over one of those — `--ok-wash` behind a delivery badge,
 * `--bad-wash` behind a failed row — and `lib/tokens.test.ts` composites those
 * for the greens and the status tones. The neutral tiers are not swept over
 * washes here. On the palette current as this is written that would be 41
 * failing cells out of 160 (forty of them `--fg-faint`, one `--fg-muted` at
 * 4.482, worst 2.366). Promoting it into an assertion is a scope decision
 * rather than a gap nobody noticed, and it is written up in
 * `docs/goals/vodoge-theme-black/notes/T003-contrast-sweep.md`.
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
 * 🔴 **Not de-duplicated by value, on purpose.** In the light theme `--surface`
 * and `--surface-raised` are both `#ffffff` today, so two of these columns
 * carry identical numbers. Collapsing them would tidy the output and destroy
 * the signal: a four-step surface ladder that has flattened to three distinct
 * values is itself a defect, and a sweep that silently merged the duplicates
 * would be the last place it could ever be seen.
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
