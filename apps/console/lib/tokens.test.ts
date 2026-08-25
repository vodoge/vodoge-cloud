import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import tailwindConfig from "../tailwind.config.ts";
import { cn } from "./cn.ts";
import * as TOKENS from "./tokens.ts";
import {
  FORBIDDEN_IN_MIGRATED_SOURCES,
  FORM,
  LEGACY_UTILITY_COLLISIONS,
  MIGRATED_SOURCES,
  NAV_GROUPS,
  NON_UTILITY_CLASSES,
  SAFE_AREA,
  STAT,
  TABLE,
  TAILWIND_BORDER_RADIUS,
  TAILWIND_BOX_SHADOW,
  TAILWIND_COLORS,
  TAILWIND_FONT_FAMILY,
  TAILWIND_FONT_SIZE,
  TAILWIND_GRID_TEMPLATE_COLUMNS,
  TAILWIND_LETTER_SPACING,
  TAILWIND_LINE_HEIGHT,
  TAILWIND_MAX_WIDTH,
  TAILWIND_OPACITY,
  TAILWIND_SPACING,
  TAILWIND_WIDTH,
  TAILWIND_Z_INDEX,
  UNMIGRATED_SOURCES,
  badgeClass,
  buttonClass,
  navState,
  rootTokenValues,
  tableCellClass,
  themeOverrideValues,
  toneForState,
} from "./tokens.ts";

/**
 * The design system's tests.
 *
 * `apps/console` cannot render a component in a test — no jsdom, no
 * testing-library, no vitest, no jest — so the checks that matter are made
 * against the two things that *can* be read: the stylesheet on disk, and the
 * CSS the real Tailwind build produces. That is why the class strings live in
 * `tokens.ts` as data. A class written inside a `.tsx` is unreachable from
 * here, and a class this project cannot check is a class that silently stops
 * working.
 *
 * Note also that `package.json`'s test script is a hand-written list of files.
 * A new test file that is not added to it never runs, and the pass count does
 * not move — which reads exactly like "no new tests were needed".
 *
 * ## What T027 changed, and why any of this is here
 *
 * An adversarial review (`docs/goals/vodoge-ui-refactor/notes/T026-pattern-review.md`)
 * put mutations through this file and found the class guards were decorative.
 * The same string — `grid gap-4 nonsense-xyz` — failed two tests written as
 * `className="…"` and passed all twenty-five written as `className={"…"}`.
 * A whole new recipe object, or a new key on `STAT`, was checked by nothing.
 * The source footer could be put behind a role gate, and the header's
 * safe-area inset deleted, with the suite still green. Nothing forbade a bare
 * `<select>`, which the legacy stylesheet is painting and preflight will not.
 *
 * Nothing was leaking on the day that review was written. It was found by
 * mutation, not by reading, and that is the point: **an assertion that has
 * never been seen red is not evidence.** Every guard below has been shown to
 * fail against the specific defect it claims to catch, and the mutations are
 * listed in `notes/T027-cloud-guards.md` so the next card can re-run them.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const globalsCss = readFileSync(join(root, "app", "globals.css"), "utf8");

/* ── Reading CSS ─────────────────────────────────────────────────────── */

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Block and line comments both, for reading source rather than a stylesheet. */
function codeOnly(source: string): string {
  return scan(source).code;
}

/** The text between the braces of the first block whose head ends with `head`. */
function blockBody(css: string, head: string): string {
  const start = css.indexOf(head);
  assert.notEqual(start, -1, `globals.css has no \`${head}\``);
  let depth = 0;
  for (let i = start + head.length - 1; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
    }
  }
  assert.fail(`\`${head}\` is not closed`);
}

/** `--bg: #0b0e14;` → `{ bg: "#0b0e14" }`, whitespace in values normalised. */
function customProperties(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of body.split(";")) {
    const match = /^\s*--([a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(declaration);
    if (!match) continue;
    out[match[1]] = match[2].replace(/\s+/g, " ").trim();
  }
  return out;
}

/* ── Reading the Tailwind build ──────────────────────────────────────── */

/** Every class name in a selector, with Tailwind's escaping undone. */
function classNamesInSelector(selector: string): string[] {
  const names: string[] = [];
  let i = 0;
  while (i < selector.length) {
    if (selector[i] !== ".") {
      i += 1;
      continue;
    }
    let name = "";
    let j = i + 1;
    while (j < selector.length) {
      const ch = selector[j];
      if (ch === "\\") {
        name += selector[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (/[\s.,:>~+[\]()#*'"]/.test(ch)) break;
      name += ch;
      j += 1;
    }
    if (name) names.push(name);
    i = Math.max(j, i + 1);
  }
  return names;
}

/**
 * Ask the real build which of these produce CSS.
 *
 * Not a table of valid names kept alongside the config — that table would be a
 * second source of truth and would be the thing that rots. Tailwind is run
 * with the project's own config and the candidates as its content, so the
 * answer is the answer the browser gets.
 */
async function generatedClasses(candidates: readonly string[]): Promise<Set<string>> {
  const result = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: candidates.join(" "), extension: "html" }],
    }),
  ]).process("@tailwind utilities;", { from: undefined });

  const generated = new Set<string>();
  result.root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      for (const name of classNamesInSelector(selector)) generated.add(name);
    }
  });
  return generated;
}

/* ── Reading component and page source ───────────────────────────────── */

function readSource(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

type Literal = { readonly start: number; readonly text: string };

/**
 * One pass over a `.tsx`, producing the two views everything below reads.
 *
 * - `masked` — comments gone and every literal's *contents* blanked, with the
 *   indices left where they were. Counting braces on it is safe: a `{` inside
 *   a string or a comment cannot throw it off, which is what lets the footer
 *   check below ask "is this element inside a conditional" and get an answer.
 * - `code` — comments gone, literals intact. What a check that asks "is this
 *   really wired up" should read, so that naming the thing in a comment does
 *   not satisfy it.
 * - `literals` — every string and template literal, with its position.
 *
 * A regex is not enough here and the review proved it: the previous extractor
 * matched `className="…"` and nothing else, so putting the same class list in
 * braces walked past all four class guards. Template literals need their
 * `${…}` skipped as well, or every interpolation reads as a broken class name.
 */
function scan(source: string): { masked: string; code: string; literals: Literal[] } {
  const masked = [...source];
  const code = [...source];
  const literals: Literal[] = [];
  const blank = (target: string[], from: number, to: number) => {
    for (let i = from; i < to; i++) if (target[i] !== "\n") target[i] = " ";
  };

  let i = 0;
  while (i < source.length) {
    const pair = source.slice(i, i + 2);
    if (pair === "//" || pair === "/*") {
      const stop = pair === "//" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2);
      const end = stop === -1 ? source.length : pair === "//" ? stop : stop + 2;
      blank(masked, i, end);
      blank(code, i, end);
      i = end;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      let text = "";
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          text += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        if (quote === "`" && source.slice(j, j + 2) === "${") {
          // The interpolation is not a class name; the static text around it
          // is. Without this, `${tone} badge` reports `${tone}` as a class
          // that generates no CSS, and the check gets switched off.
          let depth = 0;
          let k = j + 1;
          for (; k < source.length; k++) {
            if (source[k] === "{") depth += 1;
            else if (source[k] === "}") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          text += " ";
          j = k + 1;
          continue;
        }
        text += source[j];
        j += 1;
      }
      blank(masked, i + 1, j);
      literals.push({ start: i, text });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return { masked: masked.join(""), code: code.join(""), literals };
}

/** The index of the bracket closing the one at `open`, or -1. */
function closingBracket(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if ("({[".includes(masked[i])) depth += 1;
    else if (")}]".includes(masked[i])) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Class lists written into a `.tsx`.
 *
 * A literal counts when it reaches `className` **directly** — `className="…"`,
 * `className={"…"}`, a template literal, either arm of a ternary — or when it
 * is handed to `cn(…)`, whose entire job is class lists.
 *
 * "Directly" is load-bearing. `className={buttonClass({ variant: "ghost" })}`
 * contains a string that is not a class list, and a guard that reported
 * `ghost` as a class generating no CSS would be deleted by the second person
 * who hit it. So literals nested inside a call or an object literal are left
 * alone, and `cn` is named explicitly because it is the one call whose
 * arguments are always classes.
 */
function classListsIn(source: string): string[] {
  const { masked, literals } = scan(source);
  const byStart = new Map(literals.map((literal) => [literal.start, literal.text]));
  const lists: string[] = [];

  for (const match of masked.matchAll(/className\s*=\s*/g)) {
    const at = match.index + match[0].length;
    const direct = byStart.get(at);
    if (direct !== undefined) {
      lists.push(direct);
      continue;
    }
    if (masked[at] !== "{") continue;
    const close = closingBracket(masked, at);
    let depth = 0;
    for (let i = at + 1; i < close; i++) {
      if ("({[".includes(masked[i])) depth += 1;
      else if (")}]".includes(masked[i])) depth -= 1;
      else if (depth === 0 && byStart.has(i)) lists.push(byStart.get(i) as string);
    }
  }

  for (const match of masked.matchAll(/\bcn\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closingBracket(masked, open);
    for (const literal of literals) {
      if (literal.start > open && literal.start < close) lists.push(literal.text);
    }
  }
  return lists;
}

type Tag = { readonly name: string; readonly text: string };

/**
 * JSX opening tags, each matched to *its own* `>`.
 *
 * Attribute expressions contain `=>` and `>` all the time, so the closing
 * angle is only the one found at bracket depth zero. Used to ask two
 * questions a substring search answers wrongly: does this element carry a
 * class, and does this particular element carry that inline style.
 */
function openingTags(source: string): Tag[] {
  const { masked, code } = scan(source);
  const tags: Tag[] = [];
  for (const match of masked.matchAll(/<([A-Za-z][A-Za-z0-9.]*)/g)) {
    const start = match.index;
    let depth = 0;
    let end = -1;
    for (let i = start + match[0].length; i < masked.length; i++) {
      const ch = masked[i];
      if ("({[".includes(ch)) depth += 1;
      else if (")}]".includes(ch)) depth -= 1;
      else if (ch === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    tags.push({ name: match[1], text: code.slice(start, end + 1) });
  }
  return tags;
}

function classesIn(lists: readonly string[]): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    for (const name of list.split(/\s+/)) {
      if (name) out.add(name);
    }
  }
  return [...out].sort();
}

/* ── Reading the recipes ─────────────────────────────────────────────── */

/**
 * Exports of `lib/tokens.ts` that are not class recipes.
 *
 * The important half of this list is what it leaves out. Recipes used to be
 * enumerated by hand in `allUsedClasses()`, which meant a whole new recipe
 * object — `export const DEVICE_TABLE = { root: "grid gap-4 p-[13px] …" }` —
 * and even a new key on `STAT`, `BUTTON` or `BADGE` were checked by nothing at
 * all. Now anything exported from that file is walked as a recipe **unless it
 * is named here**, so the default for something new is "checked", and opting
 * out is an edit a reviewer can see.
 */
const NOT_A_RECIPE = new Set([
  // Token tables: values, and checked against globals.css by their own tests.
  "COLOR_TOKENS",
  "SHADOW_TOKENS",
  "TEXT_TOKENS",
  "FONT_TOKENS",
  "SPACE_TOKENS",
  "RADIUS_TOKENS",
  "SIZE_TOKENS",
  "THEMED_TOKENS",
  "STATIC_TOKENS",
  // The same tables again, shaped for the Tailwind theme.
  "TAILWIND_COLORS",
  "TAILWIND_SPACING",
  "TAILWIND_FONT_SIZE",
  "TAILWIND_BORDER_RADIUS",
  "TAILWIND_BOX_SHADOW",
  "TAILWIND_FONT_FAMILY",
  "TAILWIND_MAX_WIDTH",
  "TAILWIND_LINE_HEIGHT",
  "TAILWIND_LETTER_SPACING",
  "TAILWIND_OPACITY",
  "TAILWIND_Z_INDEX",
  "TAILWIND_WIDTH",
  "TAILWIND_GRID_TEMPLATE_COLUMNS",
  // Not classes: an inline style, nav data, and the migration ledger.
  "SAFE_AREA",
  "NAV_GROUPS",
  "MIGRATED_SOURCES",
  "UNMIGRATED_SOURCES",
  "LEGACY_UTILITY_COLLISIONS",
  "FORBIDDEN_IN_MIGRATED_SOURCES",
  "NON_UTILITY_CLASSES",
]);

/** Every export of `tokens.ts` that is treated as a bag of class lists. */
function recipeNames(): string[] {
  return Object.entries(TOKENS)
    .filter(([name, value]) => typeof value !== "function" && !NOT_A_RECIPE.has(name))
    .map(([name]) => name)
    .sort();
}

/** Every string anywhere inside a recipe, however deeply nested. */
function classListsInRecipe(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") {
    for (const inner of Object.values(value)) classListsInRecipe(inner, out);
  }
}

/** Every class the recipes and the migrated files between them ask for. */
function allUsedClasses(): string[] {
  const lists: string[] = [];
  const table = TOKENS as unknown as Record<string, unknown>;
  for (const name of recipeNames()) classListsInRecipe(table[name], lists);
  for (const relative of MIGRATED_SOURCES) lists.push(...classListsIn(readSource(relative)));
  return classesIn(lists);
}

/* ── Reading the legacy layer ────────────────────────────────────────── */

/** The body of `@layer legacy { … }`, comments removed. */
function legacyLayer(): string {
  return blockBody(stripComments(globalsCss), "@layer legacy {");
}

/** Every class name the old stylesheet defines. */
function legacyClassNames(): Set<string> {
  const names = new Set<string>();
  for (const chunk of legacyLayer().matchAll(/([^{}]+)\{/g)) {
    for (const match of chunk[1].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(match[1]);
  }
  return names;
}

/**
 * Every element the old stylesheet styles by *name* rather than by class.
 *
 * This is the leak no class-based check can see, and it is the bigger half.
 * `table` gets a width and a font size, `th` a colour and a sticky position,
 * `input, select, textarea` an entire box. A migrated page that renders a bare
 * one of these looks finished and is being painted by the stylesheet it was
 * moved off — and Tailwind's preflight, which arrives when `@layer legacy` is
 * deleted, does not put any of it back. It zeroes cell padding and strips the
 * input border instead.
 *
 * Derived from the stylesheet rather than listed, so a new bare-element rule
 * is covered the moment it is written.
 */
function legacyBareElements(): Set<string> {
  const names = new Set<string>();
  for (const chunk of legacyLayer().matchAll(/([^{}]+)\{/g)) {
    const head = chunk[1];
    if (head.includes("@")) continue;
    for (const selector of head.split(",")) {
      const trimmed = selector.trim();
      if (!trimmed || /[.#[]/.test(trimmed)) continue;
      for (const part of trimmed.split(/[\s>+~]+/)) {
        const name = /^([a-z][a-z0-9]*)/.exec(part)?.[1];
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/* ── The stylesheet agrees with this file ────────────────────────────── */

test("globals.css :root declares exactly the dark tokens", () => {
  const declared = customProperties(blockBody(stripComments(globalsCss), ":root {"));
  assert.deepEqual(declared, rootTokenValues("dark"));
});

test("globals.css light theme re-declares exactly the themed tokens", () => {
  const declared = customProperties(
    blockBody(stripComments(globalsCss), ':root[data-theme="light"] {'),
  );
  assert.deepEqual(declared, themeOverrideValues("light"));
});

test("every var() the Tailwind theme references is a declared token", () => {
  const declared = new Set(Object.keys(rootTokenValues("dark")));
  const scales = {
    colors: TAILWIND_COLORS,
    spacing: TAILWIND_SPACING,
    fontSize: TAILWIND_FONT_SIZE,
    borderRadius: TAILWIND_BORDER_RADIUS,
    boxShadow: TAILWIND_BOX_SHADOW,
    fontFamily: TAILWIND_FONT_FAMILY,
  };
  const dangling: string[] = [];
  for (const [scale, table] of Object.entries(scales)) {
    for (const [key, value] of Object.entries(table as Record<string, string>)) {
      for (const match of value.matchAll(/var\(--([a-z0-9-]+)\)/gi)) {
        if (!declared.has(match[1])) dangling.push(`${scale}.${key} → --${match[1]}`);
      }
    }
  }
  assert.deepEqual(dangling, []);
});

/**
 * The arrangement the whole migration rests on.
 *
 * If `@tailwind utilities` ever ends up inside a layer, or the legacy
 * stylesheet ends up outside one, utilities stop outranking the old rules and
 * migrated pages start being painted by the stylesheet they were moved off —
 * in hover and focus states first, which is where nobody looks.
 */
test("the legacy stylesheet is layered and the utilities are not", () => {
  const css = stripComments(globalsCss);
  const legacyAt = css.indexOf("@layer legacy {");
  const utilitiesAt = css.indexOf("@tailwind utilities;");

  assert.notEqual(legacyAt, -1, "the legacy stylesheet must stay inside @layer legacy");
  assert.notEqual(utilitiesAt, -1);
  assert.ok(utilitiesAt > legacyAt, "@tailwind utilities has to come after the legacy layer");

  // Unlayered means: not inside any block. Every brace before it is closed.
  const before = css.slice(0, utilitiesAt);
  const depth = before.split("{").length - before.split("}").length;
  assert.equal(depth, 0, "@tailwind utilities is inside a block, so it is layered");

  assert.equal(
    tailwindConfig.corePlugins?.preflight,
    false,
    "preflight is unlayered and would outrank the whole legacy layer",
  );
});

/* ── The classes we ask for are classes that exist ───────────────────── */

test("every class the migrated files use produces CSS", async () => {
  const used = allUsedClasses();
  assert.ok(used.length > 50, `only ${used.length} classes found — the extractor is broken`);

  const generated = await generatedClasses(used);
  const allowed = new Set<string>(NON_UTILITY_CLASSES);
  const silent = used.filter((name) => !generated.has(name) && !allowed.has(name));

  assert.deepEqual(
    silent,
    [],
    `these produce no CSS at all, so they do nothing: ${silent.join(", ")}`,
  );
});

test("migrated files use no arbitrary values and no dark: variant", () => {
  const used = allUsedClasses();
  assert.deepEqual(
    used.filter((name) => name.includes("[")),
    [],
    "an arbitrary value is a token that was never added to lib/tokens.ts",
  );
  assert.deepEqual(
    used.filter((name) => name.split(":").slice(0, -1).includes("dark")),
    [],
    "colours already flip with :root[data-theme]; dark: would be a second switch",
  );
});

test("migrated files do not use the classes that collide with the old stylesheet", () => {
  const used = new Set(allUsedClasses());
  const offenders = FORBIDDEN_IN_MIGRATED_SOURCES.filter((name) => used.has(name));
  assert.deepEqual(offenders, [], `${offenders.join(", ")} — see LEGACY_UTILITY_COLLISIONS`);
});

/**
 * The collision list is derived, not remembered.
 *
 * A cascade layer settles which rule wins a property both rules declare. It
 * does nothing about the properties only the legacy rule declares: `.grid`
 * also sets `gap` and `grid-template-columns`, and Tailwind's `grid` utility
 * says nothing about either, so they leak into any migrated element carrying
 * it. Adding a class to the old stylesheet that happens to share a name with a
 * utility would open a new hole silently, so the set is recomputed here.
 */
test("the legacy stylesheet collides with Tailwind on exactly the known names", async () => {
  const names = legacyClassNames();
  assert.ok(names.size > 40, `only ${names.size} legacy classes found — the extractor is broken`);

  const generated = await generatedClasses([...names]);
  const collisions = [...names].filter((name) => generated.has(name)).sort();
  assert.deepEqual(collisions, [...LEGACY_UTILITY_COLLISIONS].sort());
});

test("migrated files carry no class from the old stylesheet", () => {
  const legacyNames = legacyClassNames();
  // The three names Tailwind also generates are utilities in a migrated file,
  // not legacy classes; the dangerous two are rejected by their own test.
  for (const shared of LEGACY_UTILITY_COLLISIONS) legacyNames.delete(shared);

  const offenders = allUsedClasses().filter((name) => legacyNames.has(name));
  assert.deepEqual(offenders, [], `still reading the old stylesheet: ${offenders.join(", ")}`);
});

/**
 * The collision is between class *names*, so the way out is a different name.
 *
 * This test exists because the codebase used to give two answers. `tokens.ts`
 * and the migration note both said "use `flex`, or spell out `grid-cols-*` and
 * `gap-*`", while `FORBIDDEN_IN_MIGRATED_SOURCES` rejected the second one
 * outright — so a card that followed the written advice got a red test and no
 * explanation. The escape hatch that actually works was written down nowhere:
 * `sm:grid` puts `sm:grid` in the class attribute, and `.grid` does not match
 * that, so none of the legacy declarations reach the element.
 *
 * "Spell out every property the legacy rule sets" was rejected as the answer
 * on purpose. It is true of the two declarations `.grid` happens to set today,
 * it has to be re-audited whenever the stylesheet changes, and no test can
 * check it. This can be checked in one line.
 */
test("a variant-prefixed grid is the way out, and a bare grid is not", async () => {
  const forbidden = new Set<string>(FORBIDDEN_IN_MIGRATED_SOURCES);
  assert.ok(forbidden.has("grid"), "the bare utility has to stay forbidden");
  assert.ok(!forbidden.has("sm:grid"), "whole class names, so a variant is a different name");

  const legacy = legacyClassNames();
  assert.ok(legacy.has("grid"), "the legacy .grid rule is what this is all about");
  assert.ok(!legacy.has("sm:grid"), "nothing in the old stylesheet matches sm:grid");

  // And the way out has to actually produce CSS, or it is not a way out.
  const generated = await generatedClasses(["sm:grid", "max-sm:grid", "grid-cols-3", "gap-s4"]);
  for (const name of ["sm:grid", "max-sm:grid", "grid-cols-3", "gap-s4"]) {
    assert.ok(generated.has(name), `${name} generates nothing, so the documented escape hatch is a lie`);
  }
});

/**
 * Class strings live in `lib/tokens.ts`. All of them.
 *
 * `.tsx` cannot be rendered in a test here, so a class written into markup is
 * a class nothing can put to the Tailwind build — which is the whole reason
 * the recipes are data. This used to be asserted for `components/ui/` only,
 * by a regex that matched `className="…"`; the review's mutation wrote the
 * same class list as `className={"…"}` and every guard stayed green.
 *
 * Conditional classes are not an exception and do not need one:
 * `cn(TABLE.cell, narrow ? TABLE.cellHidden : undefined)` puts both strings
 * where they can be checked. The seven page cards after this one all want that
 * shape, and getting it from the recipes costs a named key.
 */
test("a migrated file writes no class strings of its own", () => {
  const offenders: string[] = [];
  for (const relative of MIGRATED_SOURCES) {
    for (const list of classListsIn(readSource(relative))) {
      offenders.push(`${relative}: ${JSON.stringify(list)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a class written into markup cannot be checked against the build; it belongs in lib/tokens.ts",
  );
});

/**
 * A class list does not stop being one by going through a variable.
 *
 * The check above reads what reaches `className`. This one reads the whole
 * file, because `const row = "grid gap-4 nonsense-xyz"` beside
 * `className={row}` is the obvious next way round it. A multi-word literal
 * whose every word is class-shaped, and at least one of whose words the real
 * build generates or the old stylesheet defines, is a class list wherever it
 * was written down.
 *
 * Single words are deliberately not flagged, and that is not laziness:
 * `role="table"` and `display: "grid"` in a chart config are not class lists,
 * and `table` and `grid` are both utilities. A guard that fails on correct
 * ARIA is how the previous footer check taught the next card to delete correct
 * ARIA. Measured against the seventeen migrated files, this rule has six
 * candidates and flags none of them — they are all `"use client"`.
 */
test("a class list in a migrated file cannot hide in a variable", async () => {
  const shaped = /^[a-z0-9:!/.\-[\]]+$/;
  const found: { relative: string; list: string; words: string[] }[] = [];
  for (const relative of MIGRATED_SOURCES) {
    for (const literal of scan(readSource(relative)).literals) {
      const words = literal.text.split(/\s+/).filter(Boolean);
      if (words.length < 2 || !words.every((word) => shaped.test(word))) continue;
      found.push({ relative, list: literal.text, words });
    }
  }
  // `p-s4` is a sentinel: without one class it knows about, Tailwind warns on
  // stderr that it found no utilities, which reads like a broken test run.
  const generated = await generatedClasses([...found.flatMap((f) => f.words), "p-s4"]);
  const legacy = legacyClassNames();
  const offenders = found
    .filter((f) => f.words.some((word) => generated.has(word) || legacy.has(word)))
    .map((f) => `${f.relative}: ${JSON.stringify(f.list)}`);
  assert.deepEqual(offenders, [], "a class list belongs in lib/tokens.ts, not in a local");
});

test("the shared components read their classes from the recipes", () => {
  for (const relative of MIGRATED_SOURCES) {
    if (!relative.startsWith("components/ui/")) continue;
    assert.match(
      codeOnly(readSource(relative)),
      /from "@\/lib\/tokens"/,
      `${relative} does not read the recipes`,
    );
  }
});

/**
 * The scanner has to keep its place, or every check built on it is decorative.
 *
 * `masked` is the basis for "is this element inside a conditional" and "which
 * `>` closes this tag". If a file ever contains something the lexer mishandles
 * — a regex literal with a brace in it is the likely one — the counts stop
 * balancing, and that has to be a loud failure here rather than a quiet wrong
 * answer three tests down.
 */
test("the source scanner keeps its place in every file it reads", () => {
  const broken: string[] = [];
  for (const relative of [...MIGRATED_SOURCES, ...UNMIGRATED_SOURCES]) {
    const { masked } = scan(readSource(relative));
    for (const [open, close] of [
      ["{", "}"],
      ["(", ")"],
      ["[", "]"],
    ]) {
      const opened = masked.split(open).length - 1;
      const closed = masked.split(close).length - 1;
      if (opened !== closed) broken.push(`${relative}: ${opened} ${open} vs ${closed} ${close}`);
    }
  }
  assert.deepEqual(broken, [], "the scanner lost track; the guards built on it are unreliable");
});

/* ── Nothing escapes the guards ──────────────────────────────────────── */

/**
 * A new recipe is checked by default; opting out is a visible edit.
 *
 * The review's mutation was `export const DEVICE_TABLE = { root: "grid gap-4
 * p-[13px] dark:bg-bad badge" }` used from a migrated page: an arbitrary
 * value, a `dark:` variant, a colliding utility and a legacy class in one
 * string, and the suite stayed green, because `allUsedClasses()` listed the
 * recipes by hand. The same held for a new *key* on `STAT`, `BUTTON` or
 * `BADGE`, which were enumerated field by field while `PAGE` and `CARD` were
 * walked with `Object.values`.
 */
test("every export of lib/tokens.ts is either walked as a recipe or named as data", () => {
  const exported = Object.keys(TOKENS);
  const stale = [...NOT_A_RECIPE].filter((name) => !exported.includes(name));
  assert.deepEqual(stale, [], "NOT_A_RECIPE names something lib/tokens.ts no longer exports");

  const recipes = recipeNames();
  for (const expected of ["PAGE", "CARD", "STAT", "TABLE", "BUTTON", "BADGE", "SHELL", "FORM"]) {
    assert.ok(recipes.includes(expected), `${expected} stopped being walked as a recipe`);
  }

  // Nested keys included, or C3 comes straight back: STAT.tone.* and
  // BUTTON.size.* are two levels down and used to be listed one by one.
  const lists: string[] = [];
  const table = TOKENS as unknown as Record<string, unknown>;
  for (const name of recipes) classListsInRecipe(table[name], lists);
  for (const nested of [STAT.tone.warn, TABLE.cellMono, FORM.select, FORM.textarea]) {
    assert.ok(lists.includes(nested), `a nested recipe value is not being walked: ${nested}`);
  }
});

/**
 * A migrated file gives every legacy-styled element a class of its own.
 *
 * `@layer legacy` styles `table`, `th`, `td`, `form`, `label`, `input`,
 * `select`, `textarea` and `button` by element name. A migrated page that
 * renders a bare one of them looks correct today for the wrong reason, and
 * there was no assertion against it at all — a bare
 * `<form><label><select><textarea>` dropped into a migrated page passed
 * everything. It stops looking correct on the day `@layer legacy` is deleted,
 * because preflight replaces none of that: it zeroes the cell padding and
 * strips the input's border.
 */
test("a migrated file gives every legacy-styled element a class of its own", () => {
  const bare = legacyBareElements();
  for (const expected of ["table", "th", "td", "form", "label", "input", "select", "textarea"]) {
    assert.ok(bare.has(expected), `the element-rule extractor stopped finding ${expected}`);
  }

  const offenders: string[] = [];
  for (const relative of MIGRATED_SOURCES) {
    for (const tag of openingTags(readSource(relative))) {
      if (!bare.has(tag.name)) continue;
      if (/\bclassName\s*=/.test(tag.text)) continue;
      offenders.push(`${relative}: <${tag.name}>`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these are being painted by @layer legacy and go bare when it is deleted",
  );
});

/** And there has to be a recipe to give them. */
test("there is a form recipe for every form element the legacy layer styles bare", () => {
  const bare = legacyBareElements();
  const recipeFor: Record<string, string> = {
    form: "root",
    label: "label",
    input: "input",
    select: "select",
    textarea: "textarea",
  };
  const missing = Object.entries(recipeFor)
    .filter(([element]) => bare.has(element))
    .filter(([, key]) => typeof (FORM as Record<string, unknown>)[key] !== "string")
    .map(([element]) => element);
  assert.deepEqual(missing, [], "a page that needs one of these has nowhere to get it from");
});

/**
 * The migrated list is criterion ①, so it cannot be opt-in.
 *
 * Seventeen files were on it and there are thirty-eight `.tsx` under `app/`
 * and `components/`. A page migrated without being added was checked by
 * nothing, while the list it was missing from is the thing the goal's first
 * criterion is measured against. Both directions are asserted here: every file
 * is on exactly one list, and a file on the unmigrated side has to still be
 * using the old stylesheet.
 */
test("every .tsx is on exactly one side of the migration ledger", () => {
  const tsxUnder = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...tsxUnder(relative));
      else if (entry.name.endsWith(".tsx")) out.push(relative);
    }
    return out;
  };

  const found = [...tsxUnder("app"), ...tsxUnder("components")].sort();
  const listed = [...MIGRATED_SOURCES, ...UNMIGRATED_SOURCES].sort();
  assert.deepEqual(
    listed,
    found,
    "a .tsx is on both lists, on neither, or has been renamed — an unlisted file is unchecked",
  );

  // Twenty-one to go. This number only goes down; a card that adds a page
  // rendered by the old stylesheet has to say so here.
  assert.ok(
    UNMIGRATED_SOURCES.length <= 21,
    `the unmigrated list grew to ${UNMIGRATED_SOURCES.length}`,
  );
});

test("a file on the unmigrated list is really still unmigrated", () => {
  const legacyNames = legacyClassNames();
  const done: string[] = [];
  for (const relative of UNMIGRATED_SOURCES) {
    const source = readSource(relative);
    // A file that writes no class at all cannot be told apart this way, and
    // app/unknown-tenant/page.tsx is one: it calls notFound() and renders
    // nothing. Promoting a file with no markup would be migration progress
    // with no migration in it, so it stays here and is skipped.
    if (!/\bclassName\s*=/.test(scan(source).masked)) continue;
    const names = classesIn(classListsIn(source));
    if (!names.some((name) => legacyNames.has(name))) done.push(relative);
  }
  assert.deepEqual(
    done,
    [],
    "these carry no legacy class any more — migrated in fact, unchecked in law; move them to MIGRATED_SOURCES",
  );
});

/**
 * Replacing five scales left seven live, and they were the drifting ones.
 *
 * `max-w-md leading-7 opacity-75 z-50` used to produce perfectly good CSS from
 * Tailwind's defaults, so the design system's central claim — a class can only
 * come from a scale in `lib/tokens.ts` — held for colour, spacing, type,
 * radius and shadow and for nothing else. Seven page cards each picking their
 * own `max-w-*` is exactly the drift this was built to stop.
 *
 * Note `extend`: a scale moved under it keeps the entire default alive again,
 * which is a one-word change that undoes this quietly.
 */
test("the drift-prone Tailwind scales are replaced rather than extended", () => {
  const theme = tailwindConfig.theme as Record<string, unknown>;
  const extend = (theme.extend ?? {}) as Record<string, unknown>;
  const replaced: Record<string, unknown> = {
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
  };
  for (const [scale, table] of Object.entries(replaced)) {
    assert.equal(theme[scale], table, `theme.${scale} is not the table from lib/tokens.ts`);
    assert.ok(!(scale in extend), `theme.extend.${scale} restores Tailwind's whole default scale`);
  }
});

test("a class from a scale this repo does not control produces no CSS", async () => {
  const gone = ["max-w-md", "leading-7", "opacity-75", "z-50", "w-1/2", "grid-cols-12", "tracking-widest"];
  const kept = ["max-w-page", "max-w-measure", "leading-none", "opacity-50", "z-20", "w-full", "w-touch", "tracking-wider"];
  const generated = await generatedClasses([...gone, ...kept]);
  assert.deepEqual(
    gone.filter((name) => generated.has(name)),
    [],
    "an off-scale utility still generates CSS, so nothing stops the next page inventing a value",
  );
  for (const name of kept) {
    assert.ok(generated.has(name), `${name} stopped generating — a recipe just lost a declaration`);
  }
});

/* ── The shell ───────────────────────────────────────────────────────── */

/**
 * The navigation is four groups because that is what the operator agreed to.
 *
 * A `.tsx` cannot be rendered in a test here, so the check that the shell
 * really offers those destinations has to be made against the data the shell
 * renders from — which is why the groups are data.
 */
test("the nav is four groups covering every destination exactly once", () => {
  assert.equal(NAV_GROUPS.length, 4);

  const hrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));
  assert.deepEqual(
    hrefs,
    ["/", "/devices", "/journal", "/audit", "/inbox", "/rules", "/schedule", "/proxy", "/settings"],
    "the confirmed grouping is fleet / comms / network / settings",
  );
  assert.equal(new Set(hrefs).size, hrefs.length, "a destination appears in one group only");

  for (const group of NAV_GROUPS) {
    assert.ok(group.items.length > 0, "an empty group is a divider pretending to be a section");
    // A label is dropped only when it would repeat its single link's own name.
    if (group.label === null) assert.equal(group.items.length, 1);
  }
});

test("every nav string exists in both catalogues", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));
  const keys = NAV_GROUPS.flatMap((group) => [
    ...(group.label ? [group.label] : []),
    ...group.items.map((item) => item.key),
  ]);

  // A missing key renders as ⟦key⟧ in the header of every page, so this is the
  // one place a typo is worth catching before it ships.
  const missing = keys.filter((key) => typeof zh[key] !== "string" || typeof en[key] !== "string");
  assert.deepEqual(missing, []);
});

test("nav highlighting distinguishes the page from the section it is in", () => {
  assert.equal(navState("/devices", "/devices"), "page");
  assert.equal(navState("/devices/abc", "/devices"), "section");
  assert.equal(navState("/inbox/%2B8613800138000", "/inbox"), "section");
  // The overview's href is "/", and every path starts with it. A prefix test
  // would light it up on every page — the bug the previous exact-match-only
  // rule was written to avoid.
  assert.equal(navState("/", "/"), "page");
  assert.equal(navState("/devices", "/"), null);
  assert.equal(navState("/devices/abc", "/"), null);
  // A shared prefix is not a section: /rules must not claim /rules-archive.
  assert.equal(navState("/rules-archive", "/rules"), null);
  assert.equal(navState("/proxy", "/settings"), null);
});

/**
 * The source footer, added by T094, and the reason it is not gated.
 *
 * It says where the source of the thing you are looking at is. A read-only
 * account is not a lesser reader, so the footer is shown to everyone.
 *
 * The check is structural because the previous one was not, and the review
 * proved it: wrapping the whole `<footer>` in `{canEdit ? … : null}` left all
 * twenty-five tests green. Seven message keys were still named, `<footer` was
 * still in the file and there were still three `target="_blank"` — the gate
 * was the one thing none of that could see, and the keyword blacklist that was
 * supposed to catch it (`/role|readonly|session|permission/`) is satisfied by
 * any other identifier.
 *
 * That blacklist is gone, and not only because it was weak: it produced a
 * false failure for `role="contentinfo"`, which is the correct landmark for a
 * page footer. A test that fails when someone adds correct ARIA is a test that
 * teaches the next card to remove it.
 */
test("the shell still carries the source footer, for every account", () => {
  const source = readSource("components/shell.tsx");
  const { masked, code } = scan(source);

  for (const key of [
    "source.label",
    "source.console",
    "source.consoleUrl",
    "source.edge",
    "source.edgeUrl",
    "source.edgeLicense",
    "source.edgeLicenseUrl",
  ]) {
    assert.ok(code.includes(`"${key}"`), `the footer no longer renders ${key}`);
  }
  assert.equal(
    (code.match(/target="_blank"/g) ?? []).length,
    3,
    "three source links: console, edge, edge licensing",
  );

  const footerAt = masked.indexOf("<footer");
  assert.notEqual(footerAt, -1, "the footer element is gone");
  const returnAt = masked.indexOf("return (");
  assert.ok(returnAt !== -1 && returnAt < footerAt, "the shell no longer returns a single tree");

  // Every brace opened after the `return (` is closed again before the footer,
  // so the footer is not the consequent of a `? :`, not the right-hand side of
  // an `&&`, and not inside a `.map`. It is rendered unconditionally or this
  // count is off by one.
  const before = masked.slice(returnAt, footerAt);
  assert.equal(
    (before.match(/\{/g) ?? []).length,
    (before.match(/\}/g) ?? []).length,
    "the footer sits inside an expression container: something is gating it",
  );

  // And no link inside it is gated one at a time.
  const inside = masked.slice(footerAt, masked.indexOf("</footer>", footerAt));
  assert.ok(
    !/\?|&&|\|\|/.test(inside),
    "a conditional inside the footer: one of the source links is being withheld",
  );
});

test("the header keeps its safe-area inset, which no class can express", () => {
  // Without this the bar renders under the notch on an installed iOS console,
  // because app/layout.tsx asks for viewportFit: "cover".
  assert.match(SAFE_AREA.headerTop.paddingTop, /env\(safe-area-inset-top\)/);
  assert.match(SAFE_AREA.headerTop.paddingTop, /var\(--s\d\)/);

  // On the element, not merely somewhere in the file. This was
  // `source.includes("SAFE_AREA.headerTop")`, which the review satisfied by
  // deleting the style and leaving the name in the comment above it — the
  // header then renders under the notch with the suite green, and this is one
  // of the items on the goal's PWA checklist.
  const bar = openingTags(readSource("components/shell.tsx")).find((tag) =>
    tag.text.includes("className={SHELL.bar}"),
  );
  assert.ok(bar, "the header bar element is gone");
  assert.match(
    bar.text,
    /style=\{SAFE_AREA\.headerTop\}/,
    "the inset is not applied to the header bar",
  );
});

test("the password field is a password field and cannot be revealed", () => {
  const code = codeOnly(readSource("components/login-form.tsx"));
  assert.match(code, /name="password"[\s\S]{0,120}type="password"/);
  assert.ok(!/type=\{/.test(code), "a computed input type is how a reveal toggle gets in");
  assert.ok(!/type="text"/.test(code));
});

/* ── The overview ────────────────────────────────────────────────────── */

/**
 * The badge on the landing page, which used to be hand-written.
 *
 * `class="badge badge-info"` next to a `StateBadge` component that four pages
 * already import is how two badge implementations end up disagreeing about
 * what "warn" looks like. The survey found twelve of these across six pages;
 * this is the one on the first page an operator sees. The check is on the
 * class lists rather than on the word "badge", because the file legitimately
 * names the module it imports the component from.
 */
test("the overview's bearer pill is the shared badge, not a hand-written one", () => {
  // Comments stripped, and the assertion is on the *call site*. `<Badge` named
  // in prose, or an import left behind after the element it imported was
  // deleted, are both things that keep a "is it wired up" check green while
  // the wiring is gone.
  const code = codeOnly(readSource("app/page.tsx"));
  const rendered = code.match(/<Badge\b[^>]*/g) ?? [];
  assert.equal(rendered.length, 1, "exactly one bearer pill should be rendered");
  assert.match(rendered[0], /tone="info"/, "the tone the hand-written pill had, kept");
  assert.match(rendered[0], /dot=\{false\}/, "a bearer is a category, not a state");

  const handWritten = classListsIn(code).filter((list) => /(^|\s)badge(-|\s|$)/.test(list));
  assert.deepEqual(handWritten, [], "a badge is still being drawn from the old stylesheet");
});

/**
 * Every part of the page comes from the shared components, at the point of use.
 *
 * Counting call sites rather than imports. An import is wiring that survives
 * the deletion of the thing it was wired to, and hand-written markup beside a
 * component that does the same job is how this console got two badges, two
 * cards and two tables that disagree.
 */
test("the overview is drawn by the shared components, at the point of use", () => {
  const code = codeOnly(readSource("app/page.tsx"));
  const uses = (pattern: RegExp) => (code.match(pattern) ?? []).length;

  assert.equal(uses(/<StatCard\b/g), 3, "three fleet numbers");
  assert.equal(uses(/<StatRow\b/g), 1);
  assert.equal(uses(/<Table\b/g), 1);
  assert.equal(uses(/<CardEmpty\b/g), 1, "the empty case still says what would be here");
  // A bare `<table>` is not only a second implementation: preflight is off, so
  // the legacy stylesheet's bare-element rules would style it, which is the
  // exact mechanism by which the two drift apart.
  assert.equal(uses(/<(table|thead|tbody|tr|th|td)\b/g), 0, "hand-written table markup is back");
  // Counting call sites is not enough on its own, and this line exists because
  // an injected defect proved it: a fourth stat written as a bare `<section>`
  // beside the three components leaves all the counts above correct. Every
  // section on this page has to come out of a shared component.
  assert.equal(uses(/<section\b/g), 0, "a card was written by hand beside the components");
});

/**
 * It is the page every signed-in operator lands on, and it is read-only.
 *
 * Nothing here fetches on the client, submits, or dispatches a command — the
 * survey measured zero controls and zero writes — and that is what makes it
 * safe to render on the server, which is in turn what keeps its language
 * correct in the HTML rather than only after hydration.
 */
test("the overview stays a read-only server component", () => {
  const code = codeOnly(readSource("app/page.tsx"));
  for (const forbidden of [/"use client"/, /<form\b/, /<button\b/, /<Button\b/, /\bonClick\b/]) {
    assert.ok(!forbidden.test(code), `the overview gained ${forbidden} — it writes nothing`);
  }
  // And the locale is handed to every string, from the server's own read. A
  // `t(key)` with the locale left off renders the default language into the
  // HTML and is then corrected by hydration, so it looks right in a browser
  // and is wrong for everything that does not run scripts.
  assert.match(code, /await getRequestLocale\(\)/, "the locale is no longer resolved server-side");
  assert.equal(
    (code.match(/\bt\(/g) ?? []).length,
    (code.match(/\bt\("[^"]+",\s*locale\b/g) ?? []).length,
    "a t() call on this page is missing its locale argument",
  );
});

/* ── The helpers ─────────────────────────────────────────────────────── */

test("cn lets the caller's class win over the component's", () => {
  // Without the token scales fed to tailwind-merge this returns both, and the
  // stylesheet's order decides — so the override silently does nothing.
  assert.equal(cn("p-s4", "p-s2"), "p-s2");
  assert.equal(cn("bg-surface", "bg-surface-raised"), "bg-surface-raised");
  assert.equal(cn("rounded", "rounded-pill"), "rounded-pill");
  assert.equal(cn("gap-s2", "gap-s4"), "gap-s4");
  assert.equal(cn("text-fg-muted", "text-fg"), "text-fg");
  // Different properties are both kept.
  assert.equal(cn("p-s4", "text-sm"), "p-s4 text-sm");
  // A falsy override leaves the base alone.
  assert.equal(cn("p-s4", undefined), "p-s4");
});

test("buttonClass defaults to the primary action at touch size", () => {
  const fallback = buttonClass();
  assert.equal(fallback, buttonClass({ variant: "primary", size: "md" }));
  assert.ok(fallback.includes("min-h-touch"), "a control a finger has to hit");
  assert.ok(buttonClass({ variant: "danger" }).includes("bg-bad"));
  assert.ok(buttonClass({ size: "sm" }).includes("text-xs"));
});

test("badgeClass falls back to neutral", () => {
  assert.equal(badgeClass(), badgeClass("neutral"));
  assert.ok(badgeClass("bad").includes("text-bad"));
});

test("tableCellClass adds only what it is asked for", () => {
  assert.equal(tableCellClass(), TABLE.cell);
  assert.ok(tableCellClass({ mono: true }).includes("font-mono"));
  assert.ok(!tableCellClass({ mono: true }).includes(TABLE.cellFaint));
  assert.ok(tableCellClass({ mono: true, faint: true }).includes(TABLE.cellFaint));
});

/**
 * A tone on a stat has to replace the colour and leave the size alone.
 *
 * `cn` resolves conflicts by property, and it only knows which classes set a
 * colour because it was handed the token scales. Misconfigure that and
 * `text-fg text-ok` both survive, the stylesheet's order decides, and the one
 * number on this page that carries a judgement quietly stops being green —
 * which looks exactly like working code.
 */
test("a stat's tone recolours the number without resizing it", () => {
  const warned = cn(STAT.value, STAT.tone.warn);
  assert.ok(warned.includes("text-warn"), "the tone lost to the base colour");
  assert.ok(!warned.includes("text-fg"), "both colours survived; the stylesheet decides");
  assert.ok(warned.includes("text-2xl"), "the tone ate the type scale");
  assert.ok(warned.includes("tabular-nums"), "a changing count would shift its own label");
  // No tone at all is the common case, and it must not be styled as one.
  assert.equal(cn(STAT.value, undefined), STAT.value);
});

test("an unknown state gets no colour rather than a guessed one", () => {
  assert.equal(toneForState("registered"), "ok");
  assert.equal(toneForState("REGISTERED"), "ok");
  assert.equal(toneForState("denied"), "bad");
  assert.equal(toneForState("searching"), "warn");
  // Green reads as "fine". Guessing it for a state we do not know is worse
  // than saying nothing.
  assert.equal(toneForState("cfun-7"), "neutral");
  assert.equal(toneForState(""), "neutral");
});
