import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import defaultTheme from "tailwindcss/defaultTheme.js";
import tailwindcss from "tailwindcss";
import tailwindConfig from "../tailwind.config.ts";
import { cn } from "./cn.ts";
import * as TOKENS from "./tokens.ts";
import { CONFIRMED_WRITES, SMS_BLOCKED_MODULES, blockedSendModules , WRITES_WITHOUT_A_DIALOG } from "./sms-safety.ts";
import {
  AT_COMMAND_GUARDS,
  BUTTON,
  CARD_POLICY_CONFIRMATIONS,
  CARD,
  CLASSES_NEEDING_AN_ANCESTOR,
  CLASSES_WITH_NO_STYLESHEET,
  CONFIRM_CONSEQUENCE_KEYS,
  CONFIRM_LABEL_KEYS,
  DEVICE_COMMAND_GUARDS,
  DEVICE_TABS,
  FORBIDDEN_IN_MIGRATED_SOURCES,
  FORM,
  LEGACY_UTILITY_COLLISIONS,
  LOG,
  MIGRATED_SOURCES,
  NAV_GROUPS,
  NON_UTILITY_CLASSES,
  NOTIFICATION_FIELDS,
  REDACTED_SECRET,
  SAFE_AREA,
  SECURITY_FIELDS,
  SETTINGS_FIELD_KINDS,
  SMS_FIELDS,
  STAT,
  TABLE,
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
  UI_PRIMITIVES,
  UNMIGRATED_SOURCES,
  assertConsequence,
  atCommandGuard,
  badgeClass,
  buttonClass,
  cardPolicyGuardFor,
  cardPolicyPatch,
  consequenceProblem,
  deviceCommandGuard,
  deviceTab,
  deviceTabHref,
  displaySettingValue,
  groupSettingsFields,
  esimSwitchVerdict,
  navState,
  notificationChannels,
  rootTokenValues,
  secretInputProps,
  settingsDocument,
  settingsFormValues,
  settingsGroupIsOn,
  settingsSaveConsequence,
  tableCellClass,
  themeOverrideValues,
  toneForCommandStatus,
  toneForProfileState,
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
  // 🔴 `split("")`, never `[...source]`. The spread iterates code *points*, so
  // one astral character — a 🔴 in a comment, and this file is full of them —
  // makes the array one element shorter than the string from that point on,
  // while every offset used below comes from `indexOf`, `slice` and `.length`,
  // which count code *units*. Everything after the first emoji is then blanked
  // one character to the left: the `/` of a `{/* … */}` survives and the `}`
  // that closes it does not. It cost this card two failing guards with symptoms
  // — an empty class list, unbalanced braces — that pointed nowhere near it.
  const masked = source.split("");
  const code = source.split("");
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
 *
 * The one other thing at depth zero that is not a class is the *condition* of
 * a ternary: `className={d === "inbound" ? "msg msg-in" : "msg msg-out"}`
 * (`conversation.tsx:90`) puts `"inbound"` right beside two real class lists.
 * It was reported as a class that generates no CSS the first time a check
 * asked about an unmigrated file, which is the same false alarm as `ghost` and
 * would have been switched off the same way. A comparison operand is never a
 * class list, so skipping it costs nothing and both arms are still read.
 */

/** `x === "inbound"` — the literal is an operand, not a class list. */
function isComparisonOperand(masked: string, start: number): boolean {
  const before = masked.slice(0, start).trimEnd();
  return before.endsWith("==") || before.endsWith("!=");
}

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
      else if (depth === 0 && byStart.has(i) && !isComparisonOperand(masked, i)) {
        lists.push(byStart.get(i) as string);
      }
    }
  }

  for (const match of masked.matchAll(/\bcn\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closingBracket(masked, open);
    for (const literal of literals) {
      if (literal.start > open && literal.start < close && !isComparisonOperand(masked, literal.start)) {
        lists.push(literal.text);
      }
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
  "TAILWIND_MIN_HEIGHT",
  "TAILWIND_MAX_HEIGHT",
  "TAILWIND_BORDER_WIDTH",
  "TAILWIND_RING_WIDTH",
  "TAILWIND_RING_OFFSET_WIDTH",
  "TAILWIND_INSET",
  "TAILWIND_FLEX",
  // Not classes: an inline style, nav data, and the migration ledger.
  "SAFE_AREA",
  "NAV_GROUPS",
  "DEVICE_TABS",
  // The guard tables: command kinds, AT command shapes, regexes and the
  // message keys that say what each one costs. Every string in them is a
  // sentence or an identifier, and walking them as class lists would report
  // `AT+CFUN=N,1` as a class that generates no CSS.
  "AT_COMMAND_GUARDS",
  "DEVICE_COMMAND_GUARDS",
  "MIGRATED_SOURCES",
  "UNMIGRATED_SOURCES",
  "LEGACY_UTILITY_COLLISIONS",
  "FORBIDDEN_IN_MIGRATED_SOURCES",
  "NON_UTILITY_CLASSES",
  // The primitive registry: file names, export names and recipe names.
  "UI_PRIMITIVES",
  // Dead-class ledgers, and the copy rules for a confirmation.
  "CLASSES_WITH_NO_STYLESHEET",
  "CLASSES_NEEDING_AN_ANCESTOR",
  "CONFIRM_CONSEQUENCE_KEYS",
  "CONFIRM_LABEL_KEYS",
  "CONFIRM_MIN_CONSEQUENCE",
  "REDACTED_SECRET",
  // Message keys and function names: which dialog an edit needs, and which
  // writes are only allowed to happen after somebody answered one.
  "CARD_POLICY_CONFIRMATIONS",
  // The settings form's field tables: dotted paths and the type of each, which
  // the page used to hold where no test could read them.
  "SETTINGS_FIELD_KINDS",
  "NOTIFICATION_FIELDS",
  "SMS_FIELDS",
  "SECURITY_FIELDS",
  // IMEIs and message keys, not classes. See the note above it in tokens.ts:
  // it is in that file because the card that wrote it could edit one file
  // under lib/, and it should move out the moment a card owns another.
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

/**
 * And it keeps its place past an emoji, which it did not.
 *
 * The check above only sees this if some file in the ledger happens to contain
 * an astral character, and "happens to" is not coverage — the file that caught
 * it could have its comment reworded tomorrow. `scan` built its arrays with a
 * spread, which iterates code points, while its offsets all come from
 * `indexOf`/`slice`, which count code units. One 🔴 in a comment and everything
 * after it is blanked a character to the left: below, the `/` of the JSX
 * comment survives and the `}` closing it is eaten, so a real file reports
 * unbalanced braces and a class list that is not there.
 */
test("the scanner counts an emoji the way the offsets around it do", () => {
  const source = [
    "/** A doc comment with a 🔴 in it. */",
    "export function Thing() {",
    "  return (",
    "    <div>",
    "      {/* A JSX comment after the emoji. */}",
    "      <span>{value}</span>",
    "    </div>",
    "  );",
    "}",
  ].join("\n");

  const { masked } = scan(source);
  assert.equal(
    masked.split("{").length - masked.split("}").length,
    0,
    "the scanner is a character out after the emoji, and every guard built on it is guessing",
  );
  // And the mask really did its job rather than balancing by accident.
  assert.ok(!masked.includes("JSX comment"), "the comment was not masked");
  assert.ok(masked.includes("{value}"), "the mask ate code it should have kept");
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

/* ── The primitives are sealed ───────────────────────────────────────────
 *
 * This card's job was to make `components/ui/*` something the seven page
 * migrations consume rather than edit. The tests above make a new `.tsx` be
 * *classified*; none of them make a new primitive be *covered*. A component
 * added to the migrated list that reads its classes from a recipe passes every
 * one of them and is still a component no test knows the name of — so deleting
 * its export, or leaving the recipe it was built for unreferenced, is silent.
 * That is C2/C3 from the pattern review, one level up.
 */

test("every file under components/ui is registered as a primitive", () => {
  const found = readdirSync(join(root, "components", "ui"))
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => `components/ui/${name}`)
    .sort();
  assert.deepEqual(
    Object.keys(UI_PRIMITIVES).sort(),
    found,
    "a primitive was added or removed without UI_PRIMITIVES being told: it is unchecked",
  );

  for (const relative of found) {
    assert.ok(
      (MIGRATED_SOURCES as readonly string[]).includes(relative),
      `${relative} is a shared component drawn by the old stylesheet`,
    );
  }
});

test("every primitive still exports what it says, drawn by the recipes it names", () => {
  const recipes = new Set(recipeNames());
  const table = TOKENS as unknown as Record<string, unknown>;
  const missingExports: string[] = [];
  const notRecipes: string[] = [];
  const notHelpers: string[] = [];
  const unused: string[] = [];
  const uncovered: string[] = [];

  for (const [relative, entry] of Object.entries(UI_PRIMITIVES)) {
    const code = codeOnly(readSource(relative));

    for (const name of entry.exports) {
      // Declared here, not merely mentioned. `export function X`, or the
      // `export const X =` a re-export uses.
      const declared = new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${name}\\b`);
      if (!declared.test(code)) missingExports.push(`${relative}: ${name}`);
    }

    for (const name of entry.recipes) {
      if (!recipes.has(name)) notRecipes.push(`${relative}: ${name}`);
      // A member access, so naming the recipe in a comment is not enough —
      // and comments are already stripped, which is the belt to that brace.
      if (!new RegExp(`\\b${name}\\.`).test(code)) unused.push(`${relative}: ${name}`);
    }
    for (const name of entry.helpers) {
      if (typeof table[name] !== "function") notHelpers.push(`${relative}: ${name}`);
      // A call, for the same reason: an import outlives everything it was for.
      if (!new RegExp(`\\b${name}\\s*\\(`).test(code)) unused.push(`${relative}: ${name}`);
    }

    // Neither list may be empty. A primitive that reads nothing from the
    // design system is a primitive drawing with something else.
    if (entry.recipes.length === 0 && entry.helpers.length === 0) uncovered.push(relative);
  }

  assert.deepEqual(missingExports, [], "a primitive stopped exporting something a page imports");
  assert.deepEqual(notRecipes, [], "a primitive names a recipe lib/tokens.ts does not walk");
  assert.deepEqual(notHelpers, [], "a primitive names a helper lib/tokens.ts does not export");
  assert.deepEqual(unused, [], "registered to a component that never reads it");
  assert.deepEqual(uncovered, [], "a primitive that takes nothing from lib/tokens.ts");
});

/**
 * The pages that import the old barrel keep compiling untouched.
 *
 * `components/ui.tsx` is now a compatibility layer over `components/ui/*`, and
 * the thing that must not change is its surface: ten pages, spread across six
 * of the seven remaining migration cards, imported from it when it was written,
 * and only one of those cards is allowed to edit it. `tsc --noEmit` is the real
 * proof that the prop signatures still fit — this is the cheaper one that says
 * the *names* are still there, and it fails with the name of the page that
 * would break.
 *
 * 🔴 **A list of files rather than a count, and that is not a style choice.**
 * Seven page cards are in flight in seven worktrees, each of them migrating a
 * different page off this barrel, and each of them therefore has to say the
 * remaining set is smaller. As a *number*, two cards that both write `9` merge
 * without a conflict into `9` when the truth after both is `8` — a wrong value
 * arrived at by a clean automatic merge, which is the worst kind. As a *list*,
 * two cards delete different lines and git merges both deletions correctly.
 * The list reaching empty is what makes the barrel deletable.
 */
// PM merge note: this is empty, and that is the milestone T029 wrote it for.
// Every page has moved off the compatibility layer, so `components/ui.tsx`
// and this test can both be deleted — assigned to T018, which is the card that
// deletes the legacy stylesheet. Until then the list stays empty and the
// assertion below turns any page that goes back to the barrel red.
const BARREL_IMPORTERS: string[] = [];

test("the old ui barrel still exports every name its remaining importers ask for", () => {
  const barrel = codeOnly(readSource("components/ui.tsx"));
  const importers: string[] = [];
  const missing: string[] = [];

  for (const relative of [...MIGRATED_SOURCES, ...UNMIGRATED_SOURCES]) {
    if (relative === "components/ui.tsx") continue;
    const code = codeOnly(readSource(relative));
    const imported = /import\s*\{([^}]*)\}\s*from\s*"@\/components\/ui"/.exec(code);
    if (!imported) continue;
    importers.push(relative);
    for (const name of imported[1].split(",").map((part) => part.trim()).filter(Boolean)) {
      const declared = new RegExp(`export\\s+(function|const)\\s+${name}\\b`);
      if (!declared.test(barrel)) missing.push(`${relative} imports ${name}`);
    }
  }

  assert.deepEqual(missing, [], "a page imports a name the compatibility layer no longer exports");
  assert.deepEqual(
    importers.sort(),
    [...BARREL_IMPORTERS].sort(),
    "a page started or stopped importing the barrel without this list being told",
  );
});


/**
 * One empty state, one badge, one stat card. Not three.
 *
 * `CardEmpty` lives in `components/ui/card.tsx` and `EmptyState` used to be a
 * second implementation in the barrel; opening a third file for it — which was
 * the plan — would have turned two that disagree into three. The rule is that
 * the barrel may *delegate* but may not *draw*, and a component that draws is
 * one that writes markup. Checked structurally rather than by counting names,
 * because "no `<span>` of its own in this file" is what a second implementation
 * would need and cannot avoid.
 */
test("the compatibility layer delegates and never draws", () => {
  const { code } = scan(readSource("components/ui.tsx"));
  const drawn = (code.match(/<[a-z][a-z0-9]*[\s/>]/g) ?? []).filter(
    (tag) => !tag.startsWith("</"),
  );
  assert.deepEqual(
    drawn,
    [],
    "the barrel is drawing its own markup again: that is a second implementation",
  );
  for (const source of ["@/components/ui/card", "@/components/ui/badge"]) {
    assert.ok(code.includes(source), `the barrel no longer delegates to ${source}`);
  }
});

/**
 * 🔴 One empty state. The reconciliation this card was given, stated as a test.
 *
 * `T001` renamed `EmptyState` to `CardEmpty` in `components/ui/card.tsx` and
 * left eight pages importing the old name, which is how two implementations of
 * the same thing start. The barrel's is a wrapper over the real one rather
 * than a copy, and the plan to open a third file for it was dropped — but
 * "there is one of these" was a thing somebody had to remember, and the guard
 * next door only says the barrel does not *draw*. It says nothing about a
 * ninth page quietly growing its own.
 *
 * Three claims, each of which a second implementation has to break:
 *
 * 1. **One file draws it.** Exactly one `.tsx` reads `CARD.empty*`. A copy has
 *    to get its classes from somewhere, and the recipes are the only place
 *    classes are allowed to come from.
 * 2. **Two files name it**, and the second delegates. The barrel's `EmptyState`
 *    has `CardEmpty` in its body; renaming a prop is all it is allowed to do.
 * 3. **Nobody hand-draws one from the stylesheet.** `.empty`, `.empty-title`
 *    and `.empty-desc` are still in `@layer legacy` and still work, so a page
 *    could write the markup itself and look perfectly right.
 */
test("there is one empty state in this console, and one file draws it", () => {
  const drawing: string[] = [];
  const naming: string[] = [];
  const handDrawn: string[] = [];

  for (const relative of [...MIGRATED_SOURCES, ...UNMIGRATED_SOURCES]) {
    const source = readSource(relative);
    const code = codeOnly(source);
    if (/\bCARD\.empty[A-Za-z]*\b/.test(code)) drawing.push(relative);
    if (/export\s+(?:function|const)\s+\w*Empty\w*\b/.test(code)) naming.push(relative);
    const names = classesIn(classListsIn(source));
    if (names.some((name) => name === "empty" || name.startsWith("empty-"))) {
      handDrawn.push(relative);
    }
  }

  assert.deepEqual(
    drawing.sort(),
    ["components/ui/card.tsx"],
    "a second file is drawing an empty state of its own out of the recipe",
  );
  assert.deepEqual(
    naming.sort(),
    ["components/ui.tsx", "components/ui/card.tsx"],
    "an empty state was declared somewhere new: there are meant to be two names for one of them",
  );
  assert.match(
    codeOnly(readSource("components/ui.tsx")),
    /function EmptyState[\s\S]{0,200}?<CardEmpty\b/,
    "the barrel's EmptyState stopped delegating to CardEmpty, which makes it the second one",
  );
  assert.deepEqual(
    handDrawn,
    [],
    "a page is drawing an empty state with the old stylesheet's classes",
  );
});

/**
 * The two width props exist because a table cell is sized from min-content,
 * and both directions of that turned out to be needed.
 *
 * `wrap` lowers min-content so an unbounded column can be squeezed; `nowrap`
 * raises it so a Chinese label is not squeezed to one character a line — CJK
 * has a break opportunity between any two characters, which is why the second
 * one is not the absence of the first. Both were measured at 390px rather than
 * reasoned about, and both are props, so both can be silently dropped from a
 * page by a merge. A prop that nothing passes is a prop that has stopped
 * working, and nothing else here would notice.
 */
test("the two table width props are wired to the recipes and to a page", () => {
  const table = codeOnly(readSource("components/ui/table.tsx"));
  assert.ok(table.includes("TABLE.cellWrap"), "the wrap prop no longer reaches its recipe");
  assert.ok(table.includes("TABLE.cellNowrap"), "the nowrap prop no longer reaches its recipe");
  assert.equal(TABLE.cellWrap, "break-all", "overflow-wrap does not lower min-content; this must");
  assert.equal(TABLE.cellNowrap, "whitespace-nowrap");

  const passes = (prop: string, relative: string) =>
    new RegExp(`<Table(?:Header)?Cell\\b[^>]*\\b${prop}\\b`).test(codeOnly(readSource(relative)));

  // The unbounded columns: an SMS body and the envelope's payload row.
  assert.ok(passes("wrap", "app/sessions/page.tsx"), "the message body stopped asking to wrap");
  assert.ok(passes("wrap", "components/journal.tsx"), "the payload row stopped asking to wrap");
  // The eight-column grid, which is the one that produced a vertical strip.
  assert.ok(passes("nowrap", "app/schedule/page.tsx"), "the schedule's readings can be squeezed");
});

/**
 * The envelope gets a row of its own, spanning the whole table.
 *
 * In the last cell it got whatever the other three columns left over, which at
 * 390px measured 79px — a JSON block the width of a thumbnail. The span has to
 * match the number of columns, and nothing about a wrong number is visible in
 * review: too small leaves a gap on the right and looks like a styling bug.
 */
test("the journal's payload row spans every column the table has", () => {
  const code = codeOnly(readSource("components/journal.tsx"));
  const headers = (code.match(/<TableHeaderCell\b/g) ?? []).length;
  const declared = Number(/const PAYLOAD_COLUMNS = (\d+)/.exec(code)?.[1]);
  assert.ok(headers > 0, "the journal stopped rendering a header row: this test is measuring air");
  assert.equal(declared, headers, "the payload row and the table disagree about how wide it is");
  assert.match(code, /colSpan=\{PAYLOAD_COLUMNS\}/, "the payload is back inside one column");
  assert.match(
    code,
    /<Output\s+className=\{JOURNAL\.payload\}/,
    "the payload lost the class that lets the table fit the card; measured, it went 311px -> 1112px",
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
    minHeight: TAILWIND_MIN_HEIGHT,
    maxHeight: TAILWIND_MAX_HEIGHT,
    borderWidth: TAILWIND_BORDER_WIDTH,
    ringWidth: TAILWIND_RING_WIDTH,
    ringOffsetWidth: TAILWIND_RING_OFFSET_WIDTH,
    inset: TAILWIND_INSET,
    flex: TAILWIND_FLEX,
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

/**
 * The six the operator asked for on 2026-08-25, and the two traps in them.
 *
 * `min-h-96 border-4 ring-8 inset-3 flex-1` all produced CSS before this, from
 * numbers nobody here had chosen — the same hole `max-w-md` came through,
 * reopened on five more axes.
 *
 * The `kept` half is the half that matters. `flex` and `inset` were both
 * measured as unused before this card and both measurements were wrong:
 * `flex-1` is in `STAT.root` and `SHELL.main`, and `top-0` reads the `inset`
 * scale and holds up two sticky headers. Replacing either with an empty table
 * would have collapsed a layout with every test still green, because nothing
 * asserts that a class which vanishes used to exist. This does.
 */
test("the five scales the operator named, and maxHeight, are closed", async () => {
  const gone = [
    "min-h-96",
    "border-4",
    "border-8",
    "ring-8",
    "ring-offset-8",
    "inset-3",
    "top-3",
    "flex-initial",
    "max-h-96",
  ];
  const kept = [
    // The exact classes the recipes carry today. Each one is a layout that
    // breaks silently if the scale it comes from loses its entry.
    "min-h-touch",
    "min-h-s6",
    "min-h-dvh",
    "border-0",
    "border-b-2",
    "ring-2",
    "ring-offset-2",
    "top-0",
    "inset-0",
    "flex-1",
    "max-h-panel",
    // And the display utilities, which are a different scale entirely and are
    // what "use flex, never grid" is built on. Tightening `flex` must not
    // touch them.
    "flex",
    "flex-col",
    "flex-wrap",
    "sm:flex-row",
  ];
  const generated = await generatedClasses([...gone, ...kept]);
  assert.deepEqual(
    gone.filter((name) => generated.has(name)),
    [],
    "an off-scale utility still generates CSS on an axis the operator asked to close",
  );
  for (const name of kept) {
    assert.ok(generated.has(name), `${name} stopped generating — a live layout just lost a rule`);
  }
});

/**
 * Tailwind scales still on their defaults, and therefore still open.
 *
 * 🔴 This lives here, and not in `lib/tokens.ts`, on purpose. That file is
 * Tailwind *content* — the build scans it for class names — and four of these
 * names are also bare utilities: `blur`, `grayscale`, `invert` and `sepia`.
 * Put there, they produced four real filter rules in the stylesheet the console
 * ships, from a list of identifiers. That was found by diffing the built CSS,
 * not by reading, and `tailwind.config.ts` records the same accident happening
 * to this file when the content glob was `./lib/**`. Test files are not
 * content.
 *
 * Nothing below is used by any recipe. Replacing them would be closing doors
 * nobody has walked through, and each closed door is another table to keep.
 */
const STILL_DEFAULT_SCALES = [
  "animation",
  "aria",
  "aspectRatio",
  "backgroundImage",
  "backgroundPosition",
  "backgroundSize",
  "blur",
  "brightness",
  "columns",
  "container",
  "content",
  "contrast",
  "cursor",
  "data",
  "dropShadow",
  "flexGrow",
  "flexShrink",
  // `font-semibold` and `font-medium` come from here. The default is nine
  // named weights rather than a number line, so there is no value to invent.
  "fontWeight",
  "gradientColorStopPositions",
  "grayscale",
  "gridAutoColumns",
  "gridAutoRows",
  "gridColumn",
  "gridColumnEnd",
  "gridColumnStart",
  "gridRow",
  "gridRowEnd",
  "gridRowStart",
  "gridTemplateRows",
  "hueRotate",
  "invert",
  "keyframes",
  "lineClamp",
  "listStyleImage",
  "listStyleType",
  "objectPosition",
  "order",
  "outlineOffset",
  "outlineWidth",
  "rotate",
  "saturate",
  "scale",
  // `sm:` is the one breakpoint this console uses, and it is Tailwind's.
  "screens",
  "sepia",
  "skew",
  "strokeWidth",
  "supports",
  "textDecorationThickness",
  "textUnderlineOffset",
  "transformOrigin",
  "transitionDelay",
  "transitionDuration",
  "transitionProperty",
  "transitionTimingFunction",
  "willChange",
];

/**
 * Which axes can still drift, as a list rather than as a memory.
 *
 * Seven scales were replaced, then six more, and both times the question "what
 * is left?" was answered by reading Tailwind's source by hand. This asks
 * Tailwind. Every scale in its default theme has to be either replaced in
 * `tailwind.config.ts` or named above, so a scale cannot be quietly overlooked
 * a third time and the remaining holes are countable.
 *
 * Only scales whose default is a literal are considered. Half of Tailwind's
 * theme is written as `theme => theme.colors` or `theme => theme.spacing` —
 * `padding`, `gap`, `height`, `size`, `backgroundColor` and forty others — and
 * those were closed the moment `colors` and `spacing` were replaced. Listing
 * them as open holes would be the opposite of true.
 */
test("every independent Tailwind scale is either replaced or listed as still open", () => {
  const theme = tailwindConfig.theme as Record<string, unknown>;
  const independent = Object.entries(defaultTheme as Record<string, unknown>)
    .filter(([, value]) => typeof value !== "function")
    .map(([name]) => name);
  assert.ok(independent.length > 50, "the default theme could not be read");

  const listed = new Set<string>(STILL_DEFAULT_SCALES);
  const unaccounted = independent.filter((name) => !(name in theme) && !listed.has(name));
  assert.deepEqual(
    unaccounted,
    [],
    "a Tailwind scale is on its defaults and nobody has said so: a page can invent a value on it",
  );

  const stale = [...listed].filter((name) => name in theme);
  assert.deepEqual(stale, [], "STILL_DEFAULT_SCALES names a scale that is in fact replaced");
});

/* ── Classes that were never going to render ─────────────────────────────
 *
 * A class name in a `.tsx` looks like styling whether or not anything defines
 * it, and in this console two of them never have. This is the only check in
 * the file that reads *unmigrated* sources as well, because that is where they
 * are — and finding them is not the point. Freezing the list is: a page card
 * that fixes one has to shorten it, and a page card that invents a new one
 * fails immediately instead of shipping markup that reviews perfectly and
 * renders as nothing.
 */

test("a class in any .tsx is defined by the build or by the old stylesheet", async () => {
  const asked = new Set<string>();
  for (const relative of [...MIGRATED_SOURCES, ...UNMIGRATED_SOURCES]) {
    for (const name of classesIn(classListsIn(readSource(relative)))) asked.add(name);
  }
  // Low, and correctly so: the migrated files hold no class literals at all —
  // a guard above enforces that — so everything counted here comes from the
  // pages still on the old stylesheet.
  // PM merge note: this is zero now, and that is the milestone. Every page is
  // off the legacy stylesheet; the one file left on UNMIGRATED_SOURCES is
  // `app/unknown-tenant/page.tsx`, which calls notFound() and renders no markup
  // at all. A floor cannot tell "genuinely zero" from "the extractor broke", so
  // the count is pinned exactly and the extractor is proved separately below.
  assert.equal(asked.size, 0, `a migrated file has a class literal again: ${[...asked].join(", ")}`);

  // The extractor still works — the assertion above would also pass if it had
  // stopped finding anything at all.
  const probe = classesIn(classListsIn(`<div className="probe-a probe-b" />`));
  assert.deepEqual([...probe].sort(), ["probe-a", "probe-b"], "the class extractor has broken");

  const generated = await generatedClasses([...asked, "p-s4"]);
  const legacy = legacyClassNames();
  const allowed = new Set<string>(NON_UTILITY_CLASSES);
  const dead = [...asked]
    .filter((name) => !generated.has(name) && !legacy.has(name) && !allowed.has(name))
    .sort();

  assert.deepEqual(
    dead,
    [...CLASSES_WITH_NO_STYLESHEET].sort(),
    "a class nothing defines: it has never rendered, and nobody would see that in review",
  );
});

/**
 * `.risk` is not a rule, and the button that needed it most never got it.
 *
 * The stylesheet declares it only as `.button-row button.risk` and
 * `.row-actions button.risk`, so it colours a button in those two containers
 * and does nothing anywhere else. `device-console.tsx:663` — the USB-net mode
 * switch, which takes a module out of the device list — sits in an
 * `<form className="inline-form">`, and its warning colour has never once been
 * drawn. A written guard that does not render is worse than none: it is on the
 * checklist.
 *
 * Both halves are derived rather than remembered. The stylesheet is read for
 * the claim, and the replacement is put to the real Tailwind build standing on
 * its own, with no ancestor at all.
 */
test("a class that needs an ancestor has a variant that does not", async () => {
  const layer = legacyLayer();
  for (const name of CLASSES_NEEDING_AN_ANCESTOR) {
    const heads = [...layer.matchAll(/([^{}]+)\{/g)].map((match) => match[1]);
    const selectors = heads
      .flatMap((head) => head.split(","))
      .map((selector) => selector.trim())
      .filter((selector) => new RegExp(`\\.${name}\\b`).test(selector));
    assert.ok(selectors.length > 0, `.${name} is not in the stylesheet at all any more`);
    for (const selector of selectors) {
      assert.notEqual(
        selector,
        `.${name}`,
        `.${name} is a rule of its own now — take it off CLASSES_NEEDING_AN_ANCESTOR`,
      );
    }
  }

  // And the way out has to render. `buttonClass` takes no ancestor and no
  // container; this is the whole difference between the variant and the class.
  const classes = buttonClass({ variant: "risk" }).split(/\s+/).filter(Boolean);
  const generated = await generatedClasses(classes);
  const silent = classes.filter((name) => !generated.has(name));
  assert.deepEqual(silent, [], "the risk variant produces no CSS, so it is the same defect again");
  assert.ok(BUTTON.variant.risk.includes("text-bad"), "a risk button has to read as one");
  assert.notEqual(
    BUTTON.variant.risk,
    BUTTON.variant.danger,
    "outlined in a row of eight, filled for the one button that carries it out",
  );
});

/* ── A confirmation says what will happen ────────────────────────────────
 *
 * Seven commands share `device.confirmDisruptive` — one sentence that names
 * none of them — and one of the seven can leave a module in `+CFUN: 7` that
 * nobody can reach to power-cycle. The card that splits it into seven is not
 * this one, so what this one owes is a dialog that cannot be handed an empty
 * consequence.
 */

/**
 * The rule bites on the real catalogue, and is not merely strict.
 *
 * A rule that rejected everything would pass an "it rejects the bad ones"
 * test. Both directions are checked against strings from `messages/*.json`:
 * the two confirmations that state a consequence have to be accepted, and the
 * two that ask a bare question have to be refused, in both languages.
 */
test("the consequence rule accepts the two that work and refuses the two that do not", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));


  // And the other one that used to be live, kept verbatim as a counter-example
  // now that it is not. `proxy.confirmRemove` was the whole of the guard on
  // both "remove an upstream" and "remove a listener"; the proxy page replaced
  // it with five consequences that name the object, so the key is gone from
  // the catalogues and the string stays here as the shape being rejected.
  for (const gone of ["确定永久删除？", "Remove this permanently?"]) {
    assert.ok(consequenceProblem(gone), `${gone} would pass as a consequence, and it states none`);
  }
  // 🔴 `device.confirmDisruptive` is *not* read from the catalogue any more,
  // because T011 deleted it: one sentence shared by seven commands, naming
  // none of them, in front of one that can strand a module at `+CFUN: 7`. Its
  // two strings are kept here verbatim as the counterexample they always were.
  // Reading a deleted key would have thrown on `undefined` rather than made a
  // point, and dropping the case would have left the rule with nothing real to
  // refuse — which is how a rule that rejects everything passes its own test.
  for (const retired of [
    "这会让模组脱网，确定继续？",
    "This takes the module off the network. Continue?",
  ]) {
    assert.ok(
      consequenceProblem(retired),
      `the sentence T011 retired would pass as a consequence now: ${retired}`,
    );
  }
  const live = { ...zh, ...en } as Record<string, unknown>;
  assert.equal(
    live["device.confirmDisruptive"],
    undefined,
    "device.confirmDisruptive is back in a catalogue; seven commands are sharing one sentence again",
  );

  // Accepted: the two that do the job, with the question they had to smuggle
  // in taken off the end — which is what having a dialog with a place for the
  // consequence means.
  const worked = [
    ["device.confirmUsbnet", /(确定继续？|Continue\?)$/],
    ["esim.dlWarn", /(继续\?|Continue\?)$/],
  ] as const;
  for (const [key, question] of worked) {
    for (const [language, catalogue] of [["zh", zh], ["en", en]] as const) {
      const statement = String(catalogue[key]).replace(question, "").trim();
      assert.equal(
        consequenceProblem(statement),
        null,
        `${language} ${key} is one of the two that work and the rule turned it down`,
      );
    }
  }

  // Empty is the one it exists for.
  assert.ok(consequenceProblem(""));
  assert.ok(consequenceProblem("   "));
  assert.throws(() => assertConsequence(""), /consequence/);
  assert.throws(() => assertConsequence("Remove this permanently?"), /question/);
  assert.equal(assertConsequence("  This deletes the profile from the eUICC.  "), "This deletes the profile from the eUICC.");
});

test("every consequence key resolves, in both languages, and states a consequence", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));

  assert.ok(CONFIRM_CONSEQUENCE_KEYS.length > 0, "an empty list checks nothing");
  const problems: string[] = [];
  for (const key of [...CONFIRM_CONSEQUENCE_KEYS]) {
    for (const [language, catalogue] of [["zh", zh], ["en", en]] as const) {
      const text = catalogue[key];
      if (typeof text !== "string") {
        problems.push(`${language} ${key} is missing`);
        continue;
      }
      const problem = consequenceProblem(text);
      if (problem) problems.push(`${language} ${key}: ${problem}`);
    }
  }
  assert.deepEqual(problems, [], "a confirmation is about to ask a question with nothing behind it");

  const missingLabels = CONFIRM_LABEL_KEYS.filter(
    (key) => typeof zh[key] !== "string" || typeof en[key] !== "string",
  );
  assert.deepEqual(missingLabels, [], "the dialog's own chrome is not in both catalogues");
});

/**
 * The prop cannot be left off, and the check cannot be skipped.
 *
 * A type is the first half — an optional `consequence` is a `consequence` that
 * gets omitted, and the card writing the seven confirmations is not this one.
 * The call to `assertConsequence` is the second, and it has to be on the path
 * that renders: putting it in an effect, or behind a flag, would make it a
 * check that runs everywhere except where being wrong matters.
 */
test("the confirmation dialog cannot be given a consequence it does not have", () => {
  const source = readSource("components/ui/confirm-dialog.tsx");
  const code = codeOnly(source);

  assert.match(code, /\n\s*consequence:\s*string;/, "consequence is no longer a required string");
  assert.ok(
    !/consequence\?\s*:/.test(code),
    "consequence became optional, which is the same as not having it",
  );
  assert.match(code, /assertConsequence\(consequence\)/, "the consequence is no longer checked");

  // On the render path. Every brace opened after `return (` closes before the
  // element that shows the consequence, so the check cannot have been moved
  // into a `useEffect` or behind a development-only branch.
  const { masked } = scan(source);
  const assertAt = masked.indexOf("assertConsequence(consequence)");
  const returnAt = masked.lastIndexOf("return (");
  assert.ok(assertAt !== -1 && returnAt > assertAt, "the check no longer runs before the render");
  for (const effect of masked.matchAll(/useEffect\s*\(/g)) {
    const close = closingBracket(masked, masked.indexOf("(", effect.index));
    assert.ok(assertAt < effect.index || assertAt > close, "the check was moved into an effect");
  }
});

/* ── And the confirmation is in front of the write ───────────────────────
 *
 * The dialog existing is not the same as the dialog being in the way. Every
 * guard above stays green if somebody later wires the control straight back to
 * the request: the component is still imported, the copy is still in both
 * catalogues, the consequence still passes its own rule. This board has been
 * here before — T004's three assertions were false greens because
 * `page.contains("guardFor(command)")` also matches `function guardFor(command)`.
 *
 * So the rule is about the call site: the function that performs the write has
 * to be reachable from an `onConfirm` and unreachable from an `onClick` or an
 * `onSubmit`. Comments are stripped before any of it is read, so naming the
 * function in a comment satisfies nothing.
 */

/** Every `attribute={…}` expression in a file, with where it starts. */
function attributeSites(source: string, attribute: string): { at: number; text: string }[] {
  const { masked, code } = scan(source);
  const out: { at: number; text: string }[] = [];
  for (const match of masked.matchAll(new RegExp(`\\b${attribute}\\s*=\\s*`, "g"))) {
    const at = match.index + match[0].length;
    if (masked[at] !== "{") continue;
    const close = closingBracket(masked, at);
    if (close === -1) continue;
    out.push({ at, text: code.slice(at, close + 1) });
  }
  return out;
}

/** Every `attribute={…}` expression in a file, comments already gone. */
function attributeExpressions(source: string, attribute: string): string[] {
  return attributeSites(source, attribute).map((site) => site.text);
}

/** Every `{` in a file matched to its own `}`. Literals are already blanked. */
function braceMap(masked: string): Map<number, number> {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") stack.push(i);
    else if (masked[i] === "}") {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  return pairs;
}

/**
 * The `?` (or `&&`) and the `:` of the conditional a `{` opens, at its own
 * depth. `null` when the braces hold something that is not a conditional — an
 * object literal, a handler, an interpolation.
 */
function conditionalArms(
  masked: string,
  open: number,
  close: number,
): { split: number; end: number } | null {
  let depth = 0;
  let split = -1;
  let end = -1;
  for (let i = open + 1; i < close; i++) {
    const ch = masked[i];
    if ("([{".includes(ch)) {
      depth += 1;
      continue;
    }
    if (")]}".includes(ch)) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    // `?.` and `??` are not conditionals, and both appear in this codebase.
    if (split === -1 && ch === "?" && masked[i + 1] !== "." && masked[i + 1] !== "?") split = i;
    else if (split === -1 && ch === "&" && masked[i + 1] === "&") split = i;
    else if (split !== -1 && end === -1 && ch === ":") end = i;
  }
  return split === -1 ? null : { split, end: end === -1 ? close : end };
}

/**
 * Whether whatever is at `at` is rendered **only** when `gate` is true.
 *
 * Walks outwards through every JSX expression container that encloses the
 * position and asks whether one of them is `{gate ? … : …}` or `{gate && …}`
 * with the position in the true arm. Written this way rather than as "does the
 * file mention `writable` near this element", because that question is answered
 * yes by a file where the gate was moved, inverted or widened — and this board
 * has already shipped one assertion that matched a definition rather than a use
 * (T004), plus one that stayed green when the footer it checked was put behind
 * a role gate (T027's review).
 *
 * The condition has to be the gate and nothing else. `{writable || preview ? …}`
 * is not a gate, and the day someone needs one it should be a visible edit
 * here rather than a silent widening there.
 *
 * ⚠️ These four helpers and the three tests that use them came in with T032 and
 * were **lost in the merge that brought T032 to main** — `git show f8cdece`
 * has them, `af2fe6a` does not, and nothing failed, because a deleted guard is
 * indistinguishable from a guard that was never written. T034 put them back and
 * extended them; see `notes/T034-devices-role-gating.md` §2.
 */
function drawnOnlyWhen(masked: string, at: number, gate: string): boolean {
  const braces = braceMap(masked);
  for (const [open, close] of braces) {
    if (open >= at || close <= at) continue;
    const arms = conditionalArms(masked, open, close);
    if (!arms) continue;
    if (masked.slice(open + 1, arms.split).trim() !== gate) continue;
    if (at > arms.split && at < arms.end) return true;
  }
  return false;
}

/**
 * The other arm: whether whatever is at `at` is rendered **only** when `gate`
 * is false.
 *
 * The read-only badge and the sentence that stands where a form was are drawn
 * *because* the account may not write, and asserting them with `drawnOnlyWhen`
 * would pass on a file where they are drawn for everybody — `{writable ? … : …}`
 * encloses both arms.
 */
function drawnOnlyUnless(masked: string, at: number, gate: string): boolean {
  const braces = braceMap(masked);
  for (const [open, close] of braces) {
    if (open >= at || close <= at) continue;
    const arms = conditionalArms(masked, open, close);
    if (!arms) continue;
    if (masked.slice(open + 1, arms.split).trim() !== gate) continue;
    if (at > arms.end && at < close) return true;
  }
  return false;
}

/** The body of `function name(…) { … }`, comments already gone. */
function functionBody(source: string, name: string): string | null {
  const { masked, code } = scan(source);
  const declared = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
  const at = masked.search(declared);
  if (at === -1) return null;
  const open = masked.indexOf("{", masked.indexOf(")", at));
  if (open === -1) return null;
  const close = closingBracket(masked, open);
  return close === -1 ? null : code.slice(open, close + 1);
}

test("a dangerous write is reachable only from a confirmation", () => {
  const notDeclared: string[] = [];
  const notAWrite: string[] = [];
  const notConfirmed: string[] = [];
  const alsoDirect: string[] = [];

  for (const [relative, actions] of Object.entries(CONFIRMED_WRITES)) {
    const source = readSource(relative);
    assert.ok(
      scan(source).code.includes("<ConfirmDialog"),
      `${relative} renders no confirmation dialog at all`,
    );

    const confirmed = attributeExpressions(source, "onConfirm");
    assert.ok(confirmed.length > 0, `${relative}: nothing is wired to onConfirm`);
    const direct = [
      ...attributeExpressions(source, "onClick"),
      ...attributeExpressions(source, "onSubmit"),
      // The defect this file actually had: a tick and a picker that wrote to
      // the whole fleet from their own `onChange`, with nothing asked.
      ...attributeExpressions(source, "onChange"),
    ];

    for (const name of actions) {
      const body = functionBody(source, name);
      if (body === null) {
        notDeclared.push(`${relative}: ${name}`);
        continue;
      }
      // It has to be the thing that talks to the gateway, or naming it here
      // proves nothing about the request.
      if (!/fetch\s*\(/.test(body) || !/method:\s*"(POST|PUT|DELETE)"/.test(body)) {
        notAWrite.push(`${relative}: ${name}`);
      }

      const mentions = new RegExp(`\\b${name}\\b`);
      if (!confirmed.some((expression) => mentions.test(expression))) {
        notConfirmed.push(`${relative}: ${name}`);
      }
      if (direct.some((expression) => mentions.test(expression))) {
        alsoDirect.push(`${relative}: ${name}`);
      }
    }

    // And nothing *else* in the file writes either. Without this the rule only
    // covers the functions somebody remembered to list, and a second mutating
    // `fetch` written straight into a handler passes every line above.
    const mutations = /method:\s*"(POST|PUT|DELETE)"/g;
    const inFile = (scan(source).code.match(mutations) ?? []).length;
    const allowed = WRITES_WITHOUT_A_DIALOG[relative]?.count ?? 0;
    const inConfirmed = actions.reduce(
      (total, name) => total + ((functionBody(source, name) ?? "").match(mutations) ?? []).length,
      0,
    );
    assert.equal(
      inConfirmed + allowed,
      inFile,
      `${relative} sends ${inFile} mutating requests; ${inConfirmed} are behind the dialog and ` +
        `${allowed} are written down in WRITES_WITHOUT_A_DIALOG`,
    );
  }

  assert.deepEqual(notDeclared, [], "a write named in CONFIRMED_WRITES no longer exists");
  assert.deepEqual(notAWrite, [], "this function no longer performs the request it is listed for");
  assert.deepEqual(notConfirmed, [], "a write nothing asks about before it happens");
  assert.deepEqual(
    alsoDirect,
    [],
    "a control calls the write directly, so the dialog is decoration",
  );
});

/* ── And the write controls are not drawn for an account that may not write ──
 *
 * ⚠️ **This is courtesy, not a permission model, and the two must not be
 * confused.** `lib/session.ts` says so already and it is worth repeating here:
 * the gateway refuses every state-changing request from a read-only session at
 * one chokepoint around its whole route table, and `/v1` is reachable with curl
 * and a token whatever these pages draw. **Nothing below closes a hole.** The
 * inbox offered `viewer@vodoge.com` a send form, three delete controls and a
 * rename box, and `/devices` offered it five card policy edits; every one of
 * them was answered 403. What is removed is the offer.
 *
 * `app/settings/page.tsx` is in the list because it is where the pattern comes
 * from. Holding all five to the same two returns is what stops a sixth page
 * from inventing a third idea of what "the gateway did not answer" means.
 *
 * 🔴 **This block, and the four scanner helpers above it, were lost.** They
 * arrived with T032 (`f8cdece`) and are not in the commit that merged T032 to
 * main (`af2fe6a`); nothing went red, because a guard that has been deleted
 * looks exactly like a guard nobody wrote. The source they guard survived the
 * merge intact, so the inbox was never actually ungated — but for two merges
 * nothing would have said so. T034 restored them and added `/devices`.
 */

/** Pages that decide what to draw from `GET /v1/auth/session`. */
const ROLE_GATED_PAGES = [
  "app/settings/page.tsx",
  "app/inbox/page.tsx",
  "app/inbox/[peer]/page.tsx",
  "app/proxy/page.tsx",
  "app/devices/page.tsx",
];

/**
 * The two ways of not getting an answer, and both of them are read-only.
 *
 * Either one returning anything else draws the write controls for an account
 * whose role nobody established.
 */
function assertFailsClosed(body: string, where: string) {
  assert.match(body, /SESSION_ENDPOINT/, `${where} asks something other than the session`);
  assert.match(body, /roleFromSessionBody\(/, `${where} reads the role its own way`);
  assert.match(
    body,
    /if \(!response\.ok\) return "readonly";/,
    `${where} treats a refused session lookup as permission to write`,
  );
  assert.match(
    body,
    /catch \{\s*return "readonly";\s*\}/,
    `${where} fails open when the gateway cannot be reached`,
  );
}

test("every page that gates a write reads the role from the gateway and fails closed", () => {
  // The extracted one. `/proxy` and `/devices` call it rather than keeping a
  // copy; the other three still have their own, and the home for all of them is
  // `lib/session.ts` beside `mayWrite`, which no card has owned yet. Both
  // shapes are held to the same two returns here, which is the whole point of
  // the test — a page that calls the shared function and a page that pasted it
  // must not be able to disagree about what "cannot ask" means.
  const shared = functionBody(readSource("lib/catalog.ts"), "fetchConsoleRole");
  assert.ok(shared, "lib/catalog.ts no longer has the shared role lookup");
  assertFailsClosed(shared, "fetchConsoleRole");

  for (const relative of ROLE_GATED_PAGES) {
    const source = readSource(relative);
    const code = codeOnly(source);
    assert.match(code, /\bmayWrite\(/, `${relative} never asks what the account may do`);

    const own = functionBody(source, "currentRole");
    if (own === null) {
      assert.match(
        code,
        /\bfetchConsoleRole\(host, token\)/,
        `${relative} has neither a currentRole of its own nor a call to the shared one`,
      );
      continue;
    }
    assertFailsClosed(own, relative);
  }
});

test("the inbox draws no write control for an account that may not write", () => {
  const inbox = scan(readSource("app/inbox/page.tsx")).masked;
  const sendAt = inbox.indexOf("<SendSmsForm");
  assert.notEqual(sendAt, -1, "the inbox has no send form any more");
  assert.ok(
    drawnOnlyWhen(inbox, sendAt, "writable"),
    "the send form is drawn for every account, read-only included",
  );

  // The conversation gets the answer rather than working one out: it is a
  // client component rendered by a server page that has already asked.
  const thread = readSource("app/inbox/[peer]/page.tsx");
  const tag = openingTags(thread).find((each) => each.name === "Conversation");
  assert.ok(tag, "the thread page no longer renders a conversation");
  assert.match(
    tag.text,
    /writable=\{writable\}/,
    "the conversation is not told what the account may do, so it will draw everything",
  );

  const source = readSource("components/conversation.tsx");
  const masked = scan(source).masked;

  // The two deletions. Each one starts at a control, and the control is the
  // thing that has to disappear — `setPending` is what opens the dialog.
  const deletions = attributeSites(source, "onClick").filter((site) =>
    /setPending\(/.test(site.text),
  );
  assert.equal(deletions.length, 2, "expected exactly the thread and the single message");
  for (const site of deletions) {
    assert.ok(
      drawnOnlyWhen(masked, site.at, "writable"),
      `a deletion is offered to every account: ${site.text}`,
    );
  }

  // The rename box, gated twice: by the caller, and by the component itself so
  // that the guard survives it being rendered from somewhere else.
  const contactAt = masked.indexOf("<ContactName");
  assert.notEqual(contactAt, -1, "the contact name control is gone");
  assert.ok(drawnOnlyWhen(masked, contactAt, "writable"), "the rename box is drawn for everyone");
  assert.match(
    codeOnly(source),
    /if \(!writable\) return null;/,
    "the rename box renders itself for any account it is handed to",
  );
});

test("every request the conversation makes refuses without the role, not only without the button", () => {
  const source = readSource("components/conversation.tsx");

  // `rename` is here and not in CONFIRMED_WRITES on purpose: a rename is not
  // destructive enough to ask about, and it is still a PUT the gateway refuses.
  for (const name of ["removeThread", "removeMessage", "forgetContact", "rename"]) {
    const body = functionBody(source, name);
    assert.ok(body, `${name} no longer exists`);
    assert.ok(/fetch\s*\(/.test(body), `${name} does not perform the request it is guarded for`);
    assert.match(body, /if \(!writable\) return;/, `${name} runs for an account that may not write`);
    assert.ok(
      body.indexOf("!writable") < body.indexOf("fetch("),
      `${name} checks the role after it has already sent the request`,
    );
  }

  // Opening a conversation marks it read, which is a POST. A read-only session
  // is refused it, so the account that could not clear the badge was producing
  // a 403 and a router refresh on every conversation it opened.
  const masked = scan(source).masked;
  const effect = masked.indexOf("useEffect(");
  assert.notEqual(effect, -1, "the read receipt is gone");
  const close = closingBracket(masked, masked.indexOf("(", effect));
  assert.ok(
    masked.slice(effect, close).includes("!writable"),
    "opening a conversation still posts a read receipt for an account that cannot mark it read",
  );
});

/* ── The same thing on /devices, which is where the five worst ones are ──
 *
 * Each card policy edit is a `PUT` or a `DELETE` **pushed to every device in
 * the tenant**, and clearing the tick takes cellular data away from a SIM
 * fleet-wide. They were drawn for every account until T034.
 *
 * Every control in the file is checked rather than a list of the ones somebody
 * remembered, because the failure this is written against is a sixth control
 * arriving ungated — which is exactly how the five got here.
 */

/** The tags in `card-policies.tsx` that let somebody change something. */
const CARD_POLICY_CONTROLS = /<(InlineField|InlineForm|Select|Button|Field|RowActions)\b/g;

test("the device list draws no card policy control for an account that may not write", () => {
  const page = readSource("app/devices/page.tsx");
  const pageCode = codeOnly(page);
  const tag = openingTags(page).find((each) => each.name === "CardPolicies");
  assert.ok(tag, "the device list no longer renders the card policy table");
  assert.match(
    tag.text,
    /writable=\{writable\}/,
    "the policy table is not told what the account may do, so it will draw everything",
  );
  assert.match(
    pageCode,
    /const writable = mayWrite\(await fetchConsoleRole\(host, token\)\)/,
    "the device list works the role out some other way",
  );

  // The badge is drawn *because* the account may not write, so it is the other
  // arm. Asserting it with drawnOnlyWhen would pass on a page that shows it to
  // everybody.
  const badgeAt = pageCode.indexOf('t("role.readOnlyBadge"');
  assert.notEqual(badgeAt, -1, "nothing on the page says why the controls are missing");
  assert.ok(
    drawnOnlyUnless(scan(page).masked, badgeAt, "writable"),
    "the read-only badge is shown to accounts that can write, or to everyone",
  );

  const source = readSource("components/card-policies.tsx");
  const masked = scan(source).masked;
  const code = codeOnly(source);

  // 🔴 Required, not optional and not defaulted. `writable = true` draws every
  // control for a caller who forgot the prop, and `writable?: boolean` is
  // worse: `!undefined` is `true`, so an omitted boolean reads as "may write"
  // at the one place it is tested. That is the fail-open shape being removed.
  assert.match(code, /\n {2}writable: boolean;/, "writable stopped being a required prop");
  assert.ok(!/\bwritable\s*\?\s*:/.test(code), "writable became optional");
  assert.ok(!/\bwritable\s*=[^=]/.test(code), "writable was given a default");

  const found = [...masked.matchAll(CARD_POLICY_CONTROLS)];
  assert.equal(
    found.length,
    8,
    "the tick, the vertical picker, the Remove button, the add form and its" +
      " field, picker and button — a control that stopped being found would" +
      " reduce the check below to nothing",
  );
  const ungated = found
    .filter((match) => !drawnOnlyWhen(masked, match.index, "writable"))
    .map((match) => `${match[1]} at ${match.index}`);
  assert.deepEqual(ungated, [], "a card policy control is offered to an account that may not write");

  // Header and cells together. A column kept for actions nobody has leaves the
  // table one column wider than it has values for, which no count of controls
  // would show.
  const actionsHeaderAt = masked.indexOf("<TableHeaderCell />");
  assert.notEqual(actionsHeaderAt, -1, "the actions column lost its header cell");
  assert.ok(
    drawnOnlyWhen(masked, actionsHeaderAt, "writable"),
    "the actions column keeps its header for an account that has no actions",
  );

  // And something stands where the add form was: a read-only account told
  // nothing goes looking for a control that is simply not there any more.
  const noteAt = code.indexOf("labels.readOnly");
  assert.notEqual(noteAt, -1, "nothing says why the controls are gone");
  assert.ok(
    drawnOnlyUnless(masked, noteAt, "writable"),
    "the read-only note is drawn for accounts that can write, or for everyone",
  );
});

test("every card policy request refuses without the role, and reads the answer it gets", () => {
  const source = readSource("components/card-policies.tsx");

  for (const name of ["save", "removePolicy"]) {
    const body = functionBody(source, name);
    assert.ok(body, `${name} no longer exists`);
    assert.ok(/fetch\s*\(/.test(body), `${name} does not perform the request it is guarded for`);
    assert.match(body, /if \(!writable\) return;/, `${name} runs for an account that may not write`);
    assert.ok(
      body.indexOf("!writable") < body.indexOf("fetch("),
      `${name} checks the role after it has already sent the request`,
    );

    // 🔴 The `DELETE` used to be `await fetch(…)` with the response discarded
    // and `router.refresh()` run either way, so a refusal drew the row back
    // exactly as a success drew it away and the operator's only evidence was
    // whether a twenty-digit ICCID was still in the table. Same family as the
    // edge panel's "assume the answer" defect that T005 fixed.
    assert.match(body, /const response = await fetch\(/, `${name} throws the response away`);
    assert.match(
      body,
      /if \(!response\.ok\) \{\s*setError\(\(await response\.text\(\)\)\.trim\(\) \|\| labels\.failed\);\s*return;\s*\}/,
      `${name} does not say what the gateway said`,
    );
    assert.ok(
      body.indexOf("if (!response.ok)") < body.lastIndexOf("router.refresh()"),
      `${name} refreshes the page before it knows whether anything changed`,
    );
  }

  // `propose` is the only entry point a control has. With the controls gone
  // there is nothing to click, and the day one comes back ungated it still
  // cannot open a dialog.
  const propose = functionBody(source, "propose");
  assert.ok(propose, "the single entry point every control goes through is gone");
  assert.match(
    propose,
    /if \(!writable\) return;/,
    "propose opens a dialog for an account that may not write",
  );
});

test("the read-only note names what is gone from the card policies", () => {
  // "You are read-only" alone leaves an operator looking for the Remove button
  // that is simply not there any more. All three edits disappear together, so
  // all three are named — the rule `role.readOnlyInbox` is held to next door.
  const VERBS = {
    zh: ["添加", "删除", "修改"],
    en: ["Adding", "removing", "changing"],
  } as const;
  const catalogues = [
    ["zh", JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"))],
    ["en", JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"))],
  ] as const;

  for (const [language, catalogue] of catalogues) {
    const note = catalogue["role.readOnlyCards"];
    assert.equal(typeof note, "string", `${language} has no read-only note for the card policies`);
    for (const verb of VERBS[language]) {
      assert.ok(note.includes(verb), `${language} role.readOnlyCards stopped naming ${verb}`);
    }
  }
});

/* ── And on the device page, which is told nothing and has to ask ────────
 *
 * The four pages above resolve the role on the server and hand a required
 * `writable` prop down. `app/devices/[deviceId]/page.tsx` resolves no role at
 * all, so all three client components on it ask `GET /v1/auth/session` from an
 * effect and start closed.
 *
 * That is the weaker of the two shapes and it is not being blessed here. A prop
 * exists before the first render; an effect answers after one paint, which is
 * why the state before the answer has to be the one that draws nothing. The
 * reason it is used is that both components sit in a page that is being
 * rewritten wholesale on another branch — the card holding `DeviceAdmin` has
 * already moved into a different shell there — and an argument added to a call
 * site that has moved is an argument a merge can quietly drop. Which is not a
 * worry invented for this comment: see the block above.
 *
 * What this holds is that the copies cannot drift. `device-console.tsx` and
 * `device-admin.tsx` are three cards apart on the console tab and
 * `esim-panel.tsx` is the whole of the tab beside it, and three components
 * disagreeing about what "the gateway did not answer" means is the same defect
 * the four-page test guards against, one level down and with one more place to
 * drift.
 */

/** Components on the device page that establish the role for themselves. */
const SELF_ASKING_CONTROLS = [
  "components/device-console.tsx",
  "components/device-admin.tsx",
  // T036. The eSIM tab had no role gate at all — T010 and T011 each reported
  // it — and it is on this same page, so it takes this shape rather than a
  // fourth one. Added to the list rather than checked beside it: a third copy
  // held to the same four lines is the whole point of there being a list.
  "components/esim-panel.tsx",
];

test("all three device page controls ask the gateway themselves, and all start closed", () => {
  for (const relative of SELF_ASKING_CONTROLS) {
    const code = codeOnly(readSource(relative));
    assert.match(
      code,
      /import \{ mayWrite, roleFromSessionBody, SESSION_ENDPOINT \} from "@\/lib\/session";/,
      `${relative} reads the role its own way`,
    );
    assert.match(
      code,
      /useState<"unknown" \| "write" \| "read">\("unknown"\)/,
      `${relative} decides what to draw before it has asked`,
    );
    assert.match(
      code,
      /response\.ok && mayWrite\(roleFromSessionBody\(await response\.json\(\)\)\) \? "write" : "read"/,
      `${relative} treats a refused session lookup as permission to write`,
    );
    assert.match(
      code,
      /catch \{\s*if \(alive\) setPermission\("read"\);\s*\}/,
      `${relative} fails open when the gateway cannot be reached`,
    );
  }
});

/**
 * Every control in the device admin card, checked by position.
 *
 * The gate here is an early `return`, not a `{writable ? … : …}`, so
 * `drawnOnlyWhen` has nothing to walk out of. What makes the same statement is
 * where the controls are: all of them after the block that returns for anyone
 * who is not established as a writer, and none of them inside it.
 *
 * Every control the file draws, rather than the two the card is named for. The
 * failure this is written against is a third one arriving ungated, which is
 * how both of these got here.
 */
const DEVICE_ADMIN_CONTROLS = /<(InlineForm|ButtonRow|Button|Field|Input|FormHint|FormError)\b/g;

test("the device admin card draws no rename box and no delete button for a read-only account", () => {
  const source = readSource("components/device-admin.tsx");
  const { masked, code } = scan(source);

  // `code`, not `masked`: the literal is the whole point of the condition and
  // `masked` blanks it, so the same search on `masked` would find
  // `if (permission !== "     ")` and keep matching after somebody changed
  // which state opens the card.
  const guardAt = code.indexOf('if (permission !== "write") {');
  assert.notEqual(guardAt, -1, "the device admin card no longer gates on what the account may do");
  const guardEnd = closingBracket(masked, masked.indexOf("{", guardAt));
  assert.notEqual(guardEnd, -1, "the read-only branch has no end");

  const readOnly = masked.slice(guardAt, guardEnd + 1);
  assert.deepEqual(
    [...readOnly.matchAll(DEVICE_ADMIN_CONTROLS)].map((match) => match[1]),
    [],
    "a control is drawn in the half of this card meant for an account with none",
  );
  assert.ok(
    !/\bon[A-Z]\w*\s*=/.test(readOnly),
    "the read-only branch carries a handler, so something in it can still be operated",
  );

  const drawn = [...masked.matchAll(DEVICE_ADMIN_CONTROLS)];
  assert.equal(
    drawn.length,
    8,
    "the rename form, its field, its box and its submit; the error; the button row," +
      " the remove button and its note — a control that stopped being found would" +
      " reduce the check below to nothing",
  );
  const ungated = drawn
    .filter((match) => match.index < guardEnd)
    .map((match) => `${match[1]} at ${match.index}`);
  assert.deepEqual(ungated, [], "a device admin control is drawn before the role is established");

  // The name is what the card is about, so it stays — as the word it is. A
  // disabled box still reads as an offer, which is the thing being withdrawn.
  assert.match(
    readOnly,
    /<SpecRow term=\{labels\.name\}>/,
    "the read-only card no longer says which device it is about",
  );
});

test("both device admin writes refuse without the role, before they ask for anything", () => {
  const source = readSource("components/device-admin.tsx");

  for (const name of ["rename", "remove"]) {
    const body = functionBody(source, name);
    assert.ok(body, `${name} no longer exists`);
    assert.ok(/fetch\s*\(/.test(body), `${name} does not perform the request it is guarded for`);
    assert.match(
      body,
      /if \(permission !== "write"\) return;/,
      `${name} runs for an account that may not write`,
    );
    assert.ok(
      body.indexOf('permission !== "write"') < body.indexOf("fetch("),
      `${name} checks the role after it has already sent the request`,
    );
  }

  // In front of the friction, not behind it. Typing a device's name out is the
  // strongest confirmation in this console and it is unchanged — but asking an
  // account that cannot delete anything to perform it, and then having the
  // gateway answer 403, is all of the cost and none of the outcome.
  const remove = functionBody(source, "remove") as string;
  assert.ok(
    remove.indexOf('permission !== "write"') < remove.indexOf("window.prompt("),
    "a read-only account is made to type the device name out before it is refused",
  );
});

/* ── And the eSIM tab, the third copy on that same page ──────────────────
 *
 * ⚠️ **The wording rule at the top of this section applies here too.**
 * `viewer@vodoge.com` could *see* every control on this tab; it could never use
 * one. Each of them is a `POST /v1/commands`, which is a state-changing request,
 * and the gateway refuses those from a read-only session at the one chokepoint
 * around its whole route table — so a profile switch, a download, a
 * notification retrieval and a chip read were all answered 403 whichever
 * account pressed them. **Nothing here closes a hole.** What is withdrawn is
 * the offer, and this is the tab where withdrawing it is worth most: the
 * buttons are labelled *Switch* and *Download and install*, they act on
 * hardware nobody can reach to unplug, and an operator offered a button that
 * cannot work learns to distrust every button on the page.
 *
 * T010 and T011 each reported this file as having no role gate at all, and
 * T034 left it out on purpose because T011 was rewriting it at the time.
 *
 * `app/devices/[deviceId]/page.tsx` still resolves no role, so this takes the
 * shape its two neighbours already have rather than inventing a fourth. What
 * the gate is *called* is the one thing borrowed from the other side: a plain
 * `writable` boolean derived from the three-state answer, so the condition in
 * front of a control is that word and nothing else — which is what
 * `drawnOnlyWhen` can walk out of, and what the four pages that are handed the
 * answer already call it.
 */

/**
 * The dependency list of `const name = useCallback(…, [ … ])`.
 *
 * 🔴 A memoised guard needs the thing it guards on in here, and leaving it out
 * fails in the direction nothing else would notice: `runNow` would keep the
 * `false` it closed over on the first render, so the account that *may* write
 * gets the buttons, gets the dialog, confirms — and nothing is sent, with no
 * error anywhere. There is no lint step in this workspace to say so.
 */
function dependencyList(source: string, name: string): string | null {
  const { masked, code } = scan(source);
  const at = masked.search(new RegExp(`\\bconst\\s+${name}\\s*=\\s*useCallback\\(`));
  if (at === -1) return null;
  const call = masked.indexOf("(", masked.indexOf("useCallback", at));
  const end = closingBracket(masked, call);
  if (end === -1) return null;
  const open = masked.lastIndexOf("[", end);
  if (open === -1 || open < call) return null;
  const close = closingBracket(masked, open);
  return close === -1 ? null : code.slice(open, close + 1);
}

/** Everything on the eSIM tab that lets somebody operate the hardware. */
const ESIM_PANEL_CONTROLS = /<(Button|Select|Input|Field|ButtonRow|RowActions|ConfirmDialog)\b/g;

/** And every attribute on it that can be operated. */
const ESIM_PANEL_HANDLERS = ["onClick", "onChange", "onConfirm", "onCancel"];

test("the eSIM tab draws no write control for an account that may not write", () => {
  const source = readSource(ESIM_SOURCE);
  const { masked, code } = scan(source);

  // 🔴 The derivation itself, pinned. `permission !== "read"` reads as writable
  // for the `"unknown"` this panel starts in — the one state the whole shape
  // exists in order to draw nothing for — and it would satisfy every check
  // below, because every check below asks about the word and not the answer.
  assert.match(
    code,
    /const writable = permission === "write";/,
    "the eSIM panel's gate is no longer the answer the gateway gave",
  );

  const drawn = [...masked.matchAll(ESIM_PANEL_CONTROLS)];
  assert.equal(
    drawn.length,
    16,
    "the module picker and its field; Refresh, Read the chip, Authenticate," +
      " Switch, Retrieve and Download and install; the two download boxes, their" +
      " fields and the row they sit in; the two row-action wrappers; the dialog" +
      " — a control that stopped being found would reduce the check below to nothing",
  );
  const ungated = drawn
    .filter((match) => !drawnOnlyWhen(masked, match.index, "writable"))
    .map((match) => `${match[1]} at ${match.index}`);
  assert.deepEqual(ungated, [], "an eSIM control is offered to an account that may not write");

  // The other axis, and it is not the same one. A control can be gated while
  // the handler that operated it is left on something else, and a count of
  // tags would not show it.
  const handlers = ESIM_PANEL_HANDLERS.flatMap((attribute) =>
    attributeSites(source, attribute).map((site) => ({ attribute, at: site.at })),
  );
  assert.equal(handlers.length, 11, `${handlers.length} handlers, not the 11 this file has`);
  assert.deepEqual(
    handlers
      .filter((site) => !drawnOnlyWhen(masked, site.at, "writable"))
      .map((site) => `${site.attribute} at ${site.at}`),
    [],
    "something on the eSIM tab can still be operated by an account that may not write",
  );

  // Header and cells together, in both tables. A column kept for actions
  // nobody has leaves a table one heading wider than it has values for, which
  // no count of controls would show — the same check the card policy table
  // carries, twice over because this tab has two tables with an actions column.
  const headers = [...masked.matchAll(/<TableHeaderCell \/>/g)];
  assert.equal(headers.length, 2, "the two actions columns are not both still here");
  for (const header of headers) {
    assert.ok(
      drawnOnlyWhen(masked, header.index, "writable"),
      `an actions column keeps its header for an account with no actions: ${header.index}`,
    );
  }

  // The card note that explains where an activation code goes travels with the
  // box that took one. A card telling a read-only account that its one-time
  // credential is not written to the log, above no field to type one into, is
  // the same kind of leftover as an actions column with no actions.
  const secretAt = code.indexOf('t("esim.dlSecret", locale)');
  assert.notEqual(secretAt, -1, "the download card stopped saying where the code goes");
  assert.ok(
    drawnOnlyWhen(masked, secretAt, "writable"),
    "the activation-code note is shown to an account that is offered no box for one",
  );

  // And the tab says why, in the arm drawn *because* the account may not write.
  // Reused rather than invented: `role.readOnlyDevice` is this page's sentence
  // and `device-console.tsx` draws the same one on the tab next to this.
  const noteAt = code.indexOf('t("role.readOnlyDevice", locale)');
  assert.notEqual(noteAt, -1, "nothing on the eSIM tab says why the controls are missing");
  assert.ok(
    drawnOnlyUnless(masked, noteAt, "writable"),
    "the read-only sentence is shown to accounts that can write, or to everyone",
  );
});

test("both eSIM entry points refuse without the role, before the dialog and before the request", () => {
  const source = readSource(ESIM_SOURCE);

  // `runNow` is the only function in the file that reaches the gateway and
  // `request` is the only thing that reaches `runNow`. Both are checked: the
  // one that draws nothing is the one a later change is least likely to notice.
  const write = bodyOfFunction(source, "runNow");
  assert.ok(write, "the eSIM panel no longer has a runNow");
  assert.match(
    write as string,
    /if \(!writable\) return;/,
    "runNow runs for an account that may not write",
  );
  assert.ok(
    (write as string).indexOf("!writable") < (write as string).indexOf("fetch("),
    "runNow checks the role after it has already sent the request",
  );

  const dispatcher = bodyOfFunction(source, "request");
  assert.ok(dispatcher, "the eSIM panel no longer has a request dispatcher");
  assert.match(
    dispatcher as string,
    /if \(!writable\) return;/,
    "request opens a dialog for an account that may not write",
  );
  // In front of the friction, not behind it — the same judgement `remove` in
  // device-admin.tsx is held to. Weighing the consequence of a profile switch,
  // asking someone to confirm it and then having the gateway refuse it is all
  // of the cost and none of the outcome.
  assert.ok(
    (dispatcher as string).indexOf("!writable") <
      (dispatcher as string).indexOf("deviceCommandGuard("),
    "request weighs the consequence first and the role afterwards",
  );

  // Both are `useCallback`s, so the gate has to be in the dependency list as
  // well as in the body. This is the assertion that has no visible symptom to
  // report it: everything above stays green while the panel silently stops
  // sending anything at all for the account that may write.
  for (const name of ["runNow", "request"]) {
    const deps = dependencyList(source, name);
    assert.ok(deps, `${name} is no longer a memoised callback this can read`);
    assert.ok(
      /\bwritable\b/.test(deps as string),
      `${name} is memoised without the gate, so it keeps whichever answer it first saw`,
    );
  }
});

/* ── The module this console will not send from ──────────────────────────
 *
 * `867018069509705` leaves the USB bus on every MO submit. What makes this a
 * test rather than a comment is the *wording*: the board believed for two days
 * that its MO path was dead, and `edge-bin/src/main.rs:537-560` records the
 * opposite — the SIM's own `EF_SMSS` counter advanced by 34 over a day of sends
 * the console called failures, and 10086 kept replying. Told the message
 * failed, an operator sends it again and the recipient gets it twice.
 *
 * So "cannot send" is the wrong refusal and "costs you the module" is the right
 * one, and the difference lives entirely in `messages/*.json` where no type can
 * reach it.
 */

test("a device carrying the module that leaves the bus cannot be sent from", () => {
  const fleet = [
    { deviceId: "edge-a", imei: "867018069509705" },
    // On the same device, and healthy. Without it this fixture would only show
    // that a device with one bad module is refused, which is the easy half:
    // the console sends to a *device* and cannot aim at a module, so a device
    // with a good module and a bad one has to be refused as well.
    { deviceId: "edge-a", imei: "867018069514820" },
    { deviceId: "edge-b", imei: "862547055142811" },
  ];

  const blocked = blockedSendModules(fleet, "edge-a");
  assert.equal(blocked.length, 1, "the refusal has to name which module it is about");
  assert.equal(blocked[0].imei, "867018069509705");
  assert.deepEqual(blockedSendModules(fleet, "edge-b"), [], "no other device is refused");

  // A module list that could not be read is an empty one, and it must not read
  // as "checked and clean" anywhere but here — see `inbox.smsModemsUnknown`.
  assert.deepEqual(blockedSendModules([], "edge-a"), []);
});

test("the blocked module says what it costs, and never that the message failed", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));

  const entries = Object.entries(SMS_BLOCKED_MODULES);
  assert.ok(entries.length > 0, "an empty block list checks nothing");

  for (const [imei, keys] of entries) {
    assert.match(imei, /^\d{15}$/, "keyed by IMEI, because the card in it can be moved");

    for (const [language, catalogue] of [["zh", zh], ["en", en]] as const) {
      const why = catalogue[keys.why];
      const cost = catalogue[keys.cost];
      assert.equal(typeof why, "string", `${language} ${keys.why} is missing`);
      assert.equal(typeof cost, "string", `${language} ${keys.cost} is missing`);

      // Which module, not "a module": there are three on this bench.
      assert.ok(why.includes("{imei}"), `${language} ${keys.why} does not name the module`);
      // What actually happens, in both transports' shared terms.
      for (const term of ["QMI", "USB"]) {
        assert.ok(why.includes(term), `${language} ${keys.why} stopped saying what happens: ${term}`);
      }
      // And the correction, which is the reason this key exists at all. These
      // two are the evidence, not decoration: without them the sentence is an
      // opinion, and the opinion it replaces is the one that gets a recipient
      // the same message twice.
      for (const term of ["EF_SMSS", "34"]) {
        assert.ok(
          cost.includes(term),
          `${language} ${keys.cost} dropped the evidence that the message goes out: ${term}`,
        );
      }
    }
  }
});

test("the refusal reaches the button and the handler, not just one of them", () => {
  const source = readSource("components/send-sms.tsx");

  const submit = openingTags(source).find((tag) => /type=\{?"submit"/.test(tag.text));
  assert.ok(submit, "the send form has no submit button any more");
  assert.match(
    submit.text,
    /disabled=\{[^}]*hold !== null/,
    "the send button is live while something is holding the send",
  );

  // And again in the handler. Return submits a form without the button being
  // pressed, so a guard that lives only in an attribute is one keystroke and
  // one stale render away from not existing — which is exactly the note the
  // edge panel carries over the same module.
  const body = functionBody(source, "onSubmit");
  assert.ok(body, "the send form has no submit handler");
  assert.match(body, /hold !== null\)\s*return;/, "the submit handler does not refuse");
  assert.ok(
    body.indexOf("hold !== null") < body.indexOf("setPending"),
    "the handler refuses after it has already started asking",
  );

  // And it is the shared answer, not a second opinion computed here. A form
  // that re-derived "may I send" from `blocked.length` would be green on the
  // two assertions above and fail open again the moment the module list did
  // not load — which is the exact defect this card was opened for.
  const code = codeOnly(source);
  assert.match(code, /sendHold\(\{[^}]*modemsKnown: !modemsUnknown/, "the hold no longer asks sendHold");
  assert.ok(
    !/\bmodemsUnknown\??:\s*boolean\s*\|\s*undefined|\bmodemsUnknown\?:/.test(code),
    "modemsUnknown became optional: an omitted prop then reads as a module list that was checked",
  );
});

/* ── A stored secret ─────────────────────────────────────────────────────── */

/**
 * Four more password fields are about to be migrated across three cards.
 *
 * The semantics already exist in `settings-form.tsx:161-172`: an already-stored
 * secret shows an *empty* box whose placeholder is the redaction marker, so
 * typing replaces it and leaving it keeps it. The failure this guards against
 * is the obvious-looking alternative — putting the marker in `value` — which
 * submits eight bullet characters and saves them as the new password the first
 * time someone saves the form without touching that field.
 */
test("a stored secret shows an empty box, never the marker as its value", () => {
  const stored = secretInputProps(REDACTED_SECRET);
  assert.equal(stored.value, "", "the redaction marker would be submitted as the new secret");
  assert.equal(stored.placeholder, REDACTED_SECRET, "nothing says a secret is already held");
  assert.equal(stored.stored, true);

  const typed = secretInputProps("hunter2");
  assert.equal(typed.value, "hunter2");
  assert.equal(typed.placeholder, "", "a placeholder here would look like a stored secret");
  assert.equal(typed.stored, false);

  // An empty field is a field the operator has not filled in, not a stored one.
  assert.equal(secretInputProps("").stored, false);
  assert.equal(secretInputProps(undefined).value, "");
  assert.equal(secretInputProps(null).value, "");

  for (const value of [REDACTED_SECRET, "hunter2", "", undefined]) {
    const props = secretInputProps(value);
    assert.equal(props.type, "password", "a secret field that is not a password field");
    // Never `current-password`: browsers offer to fill that one, and this box
    // is for a new value.
    assert.equal(props.autoComplete, "new-password");
    assert.equal(props.spellCheck, false);
  }
});

/**
 * There is no channel count in the primitives, and there must not be.
 *
 * "The seven notification channels" cannot be found in any `.tsx`: the fields
 * arrive from the gateway at runtime as a `Field[]`, and `kind === "secret"` is
 * the server's answer. A primitive that knew how many there were would be
 * wrong the first time a channel is added, and it would be wrong quietly.
 */
test("the secret input knows about one value and not about how many there are", () => {
  const code = codeOnly(readSource("components/ui/secret-input.tsx"));
  assert.ok(!/\b\d+\b/.test(code), "a number in the secret input is a count of something");
  assert.match(code, /secretInputProps\(value\)/, "the behaviour is no longer read from lib/");
  assert.ok(!/REDACTED|••/.test(code), "the marker is defined in lib/tokens.ts, not copied here");
});

/* ── The proxy page ──────────────────────────────────────────────────────
 *
 * `/proxy` is two reads and eight writes, and until this card four of the
 * writes could not be undone with nothing but a shared "Remove this
 * permanently?" — or, for a country rule and for stop/restart, with nothing at
 * all. The checks below are about *where the request is written*, because that
 * is the one thing a test in this app can read: `.tsx` cannot be rendered here,
 * so "did a dialog appear" is unanswerable and "is the call reachable without
 * one" is not.
 *
 * The component is arranged to make that question decidable. A destructive
 * click builds a `Pending` and hands it to `ask`; the only place the request is
 * written is inside that call, and the only place it runs is the dialog's
 * confirm button. Moving one back into an `onClick` fails the first test below.
 */

/** `call("…", { method: "…" })` sites, and whether each is inside `ask(…)`. */
function proxyCallSites(source: string): { label: string; guarded: boolean }[] {
  const { masked, literals } = scan(source);
  const byStart = new Map(literals.map((literal) => [literal.start, literal.text]));

  const askSpans: [number, number][] = [];
  for (const match of masked.matchAll(/\bask\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    askSpans.push([open, closingBracket(masked, open)]);
  }

  const sites: { label: string; guarded: boolean }[] = [];
  for (const match of masked.matchAll(/\bcall\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closingBracket(masked, open);
    const first = literals.find((literal) => literal.start > open && literal.start < close);
    // `${…}` is blanked to a single space by the scanner, so a path reads back
    // as its shape rather than as one row's id.
    const path = (first?.text ?? "").replace(/\s+/g, "{}");
    const method = /\bmethod:\s*["'`]/.exec(masked.slice(open, close));
    const verb = method
      ? (byStart.get(open + method.index + method[0].length - 1) ?? "")
      : "";
    sites.push({
      label: `${verb} ${path}`,
      guarded: askSpans.some(([from, to]) => open > from && open < to),
    });
  }
  return sites.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Every proxy write that cannot simply be undone, and the ones that can.
 *
 * Both halves are frozen. The guarded list may only grow and the unguarded list
 * may only shrink, and a call that moves between them has to be moved here
 * too — which is the point: "remove a listener is confirmed" is a claim about
 * code that can be checked, where "somebody added a dialog" is not.
 *
 * `POST …/start` is deliberately on the unguarded side and is the control for
 * this test. It is the one instance command that interrupts nothing: starting
 * a listener that is already up does nothing, and starting one that is down is
 * what an operator came here to do. `stop` and `restart` drop every connection
 * running through the listener, which is why they are on the other list — and
 * why the two of them looked identical to `start` before this card, three
 * unlabelled buttons in a row rendered from `["start", "stop", "restart"]`.
 */
const PROXY_GUARDED_CALLS = [
  "DELETE /v1/proxy/country-rules/{}",
  "DELETE /v1/proxy/instances/{}",
  "DELETE /v1/proxy/upstreams/{}",
  "POST /v1/proxy/instances/{}/restart",
  "POST /v1/proxy/instances/{}/stop",
];

const PROXY_UNGUARDED_CALLS = [
  // Creating something, which is undone by removing it.
  "POST /v1/proxy/instances",
  "POST /v1/proxy/upstreams",
  "PUT /v1/proxy/country-rules/{}",
  // Bringing a listener up, and asking a device whether it can reach a proxy.
  "POST /v1/proxy/instances/{}/start",
  "POST /v1/proxy/upstreams/{}/probe",
];

test("every proxy write that cannot be undone is behind the dialog, and start is not", () => {
  const source = readSource("components/proxy-manager.tsx");
  const sites = proxyCallSites(source);
  assert.ok(sites.length > 5, `only ${sites.length} call sites found — the extractor is broken`);

  assert.deepEqual(
    sites.filter((site) => site.guarded).map((site) => site.label).sort(),
    [...PROXY_GUARDED_CALLS].sort(),
    "a destructive proxy request is written somewhere other than inside ask(…), which means it runs on the click",
  );
  assert.deepEqual(
    sites.filter((site) => !site.guarded).map((site) => site.label).sort(),
    [...PROXY_UNGUARDED_CALLS].sort(),
    "a proxy request runs with no confirmation and is not on the list of ones that may",
  );

  // The mechanism, not just the copy. `window.confirm` can only show one
  // string, which is the whole reason `proxy.confirmRemove` said nothing.
  assert.ok(
    !/window\.confirm/.test(codeOnly(source)),
    "back to the native dialog, which has nowhere to put a consequence",
  );
});

/**
 * A consequence names the row the operator clicked, and every name is filled.
 *
 * The catalogue strings carry `{name}`, `{address}`, `{count}`, `{listen}`,
 * `{code}` and `{upstream}`, and a placeholder nobody supplies is not a silent
 * failure — it renders as a literal `{count}` inside the sentence an operator
 * is being asked to act on. So the arguments at each call site are compared
 * against the placeholders in *both* catalogues, which also catches a
 * translation that quietly drops one.
 */
test("every proxy confirmation is wired up and fills every name it uses", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));
  const source = readSource("components/proxy-manager.tsx");
  const { masked } = scan(source);

  // Every `proxy.confirm*` consequence in the catalogue is on the ledger the
  // both-languages check reads. A title is chrome; a consequence is the claim.
  const catalogued = Object.keys(zh)
    .filter((key) => key.startsWith("proxy.confirm") && !key.endsWith("Title"))
    .sort();
  assert.ok(catalogued.length > 0, "the proxy confirmations went missing from the catalogue");
  assert.deepEqual(
    catalogued.filter((key) => !(CONFIRM_CONSEQUENCE_KEYS as readonly string[]).includes(key)),
    [],
    "a proxy consequence nothing checks in both languages",
  );

  const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  const problems: string[] = [];
  for (const key of [...catalogued, ...catalogued.map((key) => `${key}Title`)]) {
    const label = key.slice("proxy.".length);
    const marker = `interpolate(labels.${label},`;
    const at = masked.indexOf(marker);
    if (at === -1) {
      problems.push(`${key} is in the catalogue and nothing draws it`);
      continue;
    }
    const open = masked.indexOf("{", at + marker.length);
    const close = closingBracket(masked, open);
    const supplied: string[] = [];
    let depth = 0;
    for (let i = open + 1; i < close; i++) {
      if ("({[".includes(masked[i])) depth += 1;
      else if (")}]".includes(masked[i])) depth -= 1;
      else if (depth === 0) {
        const rest = /^([A-Za-z_]\w*)\s*:/.exec(masked.slice(i, close));
        if (rest && !/[\w$]/.test(masked[i - 1])) supplied.push(rest[1]);
      }
    }
    for (const [language, catalogue] of [["zh", zh], ["en", en]] as const) {
      const wanted = placeholders(String(catalogue[key]));
      const got = [...supplied].sort();
      if (wanted.join(",") !== got.join(",")) {
        problems.push(`${language} ${key} wants [${wanted}] and the call supplies [${got}]`);
      }
    }
  }
  assert.deepEqual(problems, [], "a confirmation would show a literal {placeholder} to an operator");
});

/**
 * Start and restart cannot look the same, because they are opposites.
 *
 * They were rendered from `["start", "stop", "restart"].map(…)` as three
 * buttons with no class between them: identical shape, identical colour,
 * adjacent, and the only difference between "bring this listener up" and "drop
 * every connection through it" was three letters. Colour is not the safeguard —
 * the confirmation is — but a control that is indistinguishable from its
 * opposite is how the wrong one gets clicked in the first place.
 */
test("start and restart are not the same button", () => {
  const source = readSource("components/proxy-manager.tsx");
  const variants = new Map<string, string>();
  for (const tag of openingTags(source)) {
    if (tag.name !== "Button") continue;
    for (const verb of ["start", "stop", "restart"]) {
      if (!tag.text.includes(`/${verb}\``)) continue;
      variants.set(verb, /variant="(\w+)"/.exec(tag.text)?.[1] ?? "none");
    }
  }

  assert.deepEqual(
    [...variants.keys()].sort(),
    ["restart", "start", "stop"],
    "the three instance commands are not three separate buttons any more",
  );
  assert.notEqual(
    variants.get("start"),
    variants.get("restart"),
    "start and restart render identically again",
  );
  for (const verb of ["stop", "restart"]) {
    assert.equal(
      variants.get(verb),
      "risk",
      `${verb} drops every connection through the listener and does not read as one that does`,
    );
  }
});

/**
 * The export panel's rule, unchanged: the password never reaches the screen.
 *
 * It comes out of the gateway in a response body, lives in React state for as
 * long as the tab does, and goes to the clipboard when asked. What is drawn is
 * the same string with the password taken out, parsed rather than rebuilt.
 * This is a regression check on somebody else's work — the panel was delivered
 * whole and this card only restyled it — so it asserts the shape rather than
 * the styling.
 */
test("the export panel still keeps the password off the screen", () => {
  const code = codeOnly(readSource("components/proxy-manager.tsx"));

  assert.match(code, /parsed\.password = ""/, "the drawn string is no longer redacted");
  assert.match(code, /\{withoutPassword\(endpoint\)\}/, "the row is drawing something else now");
  assert.ok(
    !/\{\s*endpoint\.url\s*\}/.test(code),
    "the connection string with the password in it is being rendered",
  );
  assert.match(code, /copy\(endpoint\.url\)/, "the clipboard is the only place it may go");
  assert.ok(
    !/localStorage|sessionStorage|document\.cookie/.test(code),
    "a secret that survives the tab",
  );

  // The host is an address to dial, not a secret, and is the only thing that
  // may travel in the query string.
  assert.match(code, /URLSearchParams\(\{ format: "json" \}\)/);
  assert.match(code, /query\.set\("host", dial\)/);
  // And the gateway's own refusal is shown verbatim, because it is the one
  // that says to repeat the request with ?host=.
  assert.match(code, /labels\.exportHostHint/, "the ?host= hint stopped being drawn");
  assert.match(code, /labels\.exportUnexportable/, "listeners that could not be exported vanished");
  assert.match(code, /\{item\.reason\}/, "the gateway's reason is no longer shown");
});

/**
 * A read-only account is not offered the export control.
 *
 * Courtesy rather than enforcement — the gateway refuses the request itself,
 * because an export is a GET and the read-only guard decides by method — but
 * the refactor must not be what makes a write control appear for `readonly`.
 */
test("the proxy page still asks who is looking before drawing the export control", () => {
  const page = codeOnly(readSource("app/proxy/page.tsx"));
  assert.match(page, /mayWrite\(await fetchConsoleRole\(host, token\)\)/);
  assert.match(page, /canExport=\{canExport\}/, "the answer stopped reaching the component");

  const manager = codeOnly(readSource("components/proxy-manager.tsx"));
  assert.match(
    manager,
    /\{canExport \? <ExportPanel/,
    "the export panel is drawn without asking, or asks something else",
  );
});

/* ── The settings page ───────────────────────────────────────────────────
 *
 * The densest form in this console: one PUT per section, a body assembled from
 * a runtime field table, two actions that reach outside the browser, and a
 * credential rule where being wrong saves eight bullet characters as somebody's
 * SMTP password. None of it was reachable from a test while it lived in the
 * page, which is why the field tables and the document builder are in
 * `lib/tokens.ts` now.
 */

/**
 * 🔴 The request body, beside the one the page sent before it was touched.
 *
 * This card was allowed one appearance change that is not a class swap: the
 * "one per line" list field, which carried multi-line meaning in a *single*
 * line box, becomes a `<textarea>`. "The behaviour does not change" is a claim
 * about the request — same field, same PUT, same bytes — and a claim about
 * bytes deserves the bytes. The literal below is the body, verbatim.
 *
 * Every rule the old `save()` had is pinned here at once: key order follows the
 * field table, a number arrives as a number rather than the string the box
 * held, and a list splits on newlines *and* commas — the second half is what
 * keeps what an operator typed into the old single-line box meaning what it
 * meant.
 *
 * 🔴 **An untouched credential is sent back as the marker, and that is
 * correct.** It reads like the bug this whole area exists to prevent and it is
 * the opposite: the gateway sends `••••••••` in place of a stored credential
 * *and takes it back to mean "leave that one alone"* — the sentence is at the
 * top of the file this came out of. The skip on `""`/`undefined` is for a
 * different case, a box the operator emptied on purpose. Writing this expected
 * body from memory got it wrong in exactly that place, and the harness in
 * `scratchpad/t013/request-shape.cjs` — which runs the *previous* `read`,
 * `coerce`, `write` and `save` transcribed out of `git show HEAD` beside the
 * ones here — is what settled it: 36 of 36 cases byte-identical.
 */
const SETTINGS_PUT_BODY =
  '{"webhook":{"enabled":true,"urls":["https://a.example/hook","https://b.example/hook"],' +
  '"secret":"n3w-signing-key"},"email":{"enabled":true,"smtp_host":"smtp.example.com",' +
  '"smtp_port":2525,"username":"alerts","password":"••••••••",' +
  '"from_address":"alerts@example.com",' +
  '"to_addresses":["ops@example.com","sre@example.com"]},"bark":{"enabled":false,"urls":[]},' +
  '"telegram":{"enabled":false,"chat_id":"","bot":{"enabled":false,"operators":[]}},' +
  '"feishu":{"enabled":false,"webhook_url":""},"wecom":{"enabled":false,"webhook_url":""},' +
  '"pushplus":{"enabled":false,"topic":""}}';

test("the settings form sends the document it has always sent", () => {
  // What the gateway hands back: two channels configured, and both of their
  // credentials replaced by the redaction marker.
  const stored = {
    webhook: {
      enabled: true,
      urls: ["https://a.example/hook", "https://b.example/hook"],
      secret: REDACTED_SECRET,
    },
    email: {
      enabled: true,
      smtp_host: "smtp.example.com",
      smtp_port: 587,
      username: "alerts",
      password: REDACTED_SECRET,
      from_address: "alerts@example.com",
      to_addresses: ["ops@example.com"],
    },
  };

  const values = {
    ...settingsFormValues(stored, NOTIFICATION_FIELDS),
    // The operator types a new signing key, leaves the SMTP password alone,
    // changes the port, and adds a second recipient on its own line.
    "webhook.secret": "n3w-signing-key",
    "email.smtp_port": "2525",
    "email.to_addresses": "ops@example.com\nsre@example.com",
  };

  assert.equal(
    JSON.stringify(settingsDocument(NOTIFICATION_FIELDS, values)),
    SETTINGS_PUT_BODY,
    "the body of PUT /v1/settings/notifications is not what it was",
  );

  // And each rule again on its own, so a failure above says which one broke.
  const body = settingsDocument(NOTIFICATION_FIELDS, values) as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(
    body.email.password,
    REDACTED_SECRET,
    "an untouched credential goes back as the marker, which is how the gateway is told to keep it",
  );
  assert.equal(body.webhook.secret, "n3w-signing-key", "a typed secret has to be sent");
  assert.equal(body.email.smtp_port, 2525, "a number box sends a string");
  assert.equal(body.bark.enabled, false, "an absent boolean has to become false, not undefined");

  // The other half of the credential rule: a box the operator emptied is left
  // out of the document entirely, rather than sent as an empty credential.
  const emptied = settingsDocument(NOTIFICATION_FIELDS, {
    ...values,
    "email.password": "",
  }) as Record<string, Record<string, unknown>>;
  assert.ok(
    !("password" in emptied.email),
    "an emptied credential box would be saved as an empty credential",
  );

  // 🔴 The textarea's whole justification: the two ways of writing a list are
  // the same list. If they ever stop being, changing the control changed what
  // an operator's existing input means.
  const list = [{ path: "email.to_addresses", kind: "list" }] as const;
  assert.deepEqual(
    settingsDocument(list, { "email.to_addresses": "ops@example.com\nsre@example.com" }),
    settingsDocument(list, { "email.to_addresses": "ops@example.com, sre@example.com" }),
    "newlines and commas have to keep meaning the same thing",
  );
  assert.deepEqual(settingsDocument(list, { "email.to_addresses": "  \n \n " }), {
    email: { to_addresses: [] },
  });
});

test("a read-only account is shown the value, in its own language", () => {
  const words = { on: "开", off: "关" };
  assert.equal(displaySettingValue(true, words), "开");
  assert.equal(displaySettingValue(false, words), "关");
  assert.equal(displaySettingValue(["a", "b"], words), "a, b");
  assert.equal(displaySettingValue([], words), "—");
  assert.equal(displaySettingValue("", words), "—");
  assert.equal(displaySettingValue(undefined, words), "—");
  assert.equal(displaySettingValue(587, words), "587");
});

/**
 * The channels are derived, and there is nowhere for a count to hide.
 *
 * "Seven notification channels" is how this page is described and it is written
 * down nowhere, correctly: a channel is a path prefix in `NOTIFICATION_FIELDS`,
 * the gateway holds its own settings list equal to its sender registry, and the
 * last drift on this page started from a hand-written list of testable channels
 * that had fallen behind the fields.
 */
test("the channels come from the field paths and are named in both catalogues", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));

  const groups = groupSettingsFields(NOTIFICATION_FIELDS);
  assert.deepEqual(
    groups.flatMap((group) => group.fields),
    [...NOTIFICATION_FIELDS],
    "grouping dropped, reordered or duplicated a field: a setting stopped being editable",
  );
  assert.deepEqual(
    groups.map((group) => group.name),
    notificationChannels(NOTIFICATION_FIELDS),
    "the testable channels and the folded panels disagree about what a channel is",
  );

  const unswitchable = groups.filter((group) => group.enabledPath === null);
  assert.deepEqual(
    unswitchable.map((group) => group.name),
    [],
    "a channel with no enabled switch cannot say on or off in a folded summary",
  );

  // Every panel heading and every field label, in both languages. A missing one
  // renders as ⟦f.whatever⟧ in a card the operator is reading.
  const missing: string[] = [];
  const keys = [
    ...groups.map((group) => `f.${group.name}`),
    ...[...NOTIFICATION_FIELDS, ...SMS_FIELDS, ...SECURITY_FIELDS].map(
      (field) => `f.${field.path}`,
    ),
  ];
  for (const key of keys) {
    if (typeof zh[key] !== "string") missing.push(`zh ${key}`);
    if (typeof en[key] !== "string") missing.push(`en ${key}`);
  }
  assert.deepEqual(missing, [], "a settings label has no translation");

  // Derived, not listed: a channel nobody has heard of still gets a panel.
  const invented = groupSettingsFields([
    ...NOTIFICATION_FIELDS,
    { path: "matrix.enabled", kind: "boolean" },
    { path: "matrix.room", kind: "text" },
  ]);
  assert.equal(invented.length, groups.length + 1, "the grouping is a list, not a derivation");
  assert.equal(invented[invented.length - 1].enabledPath, "matrix.enabled");

  // A section whose fields are not under a prefix is one flat group, not a
  // panel called "hourly_limit".
  const flat = groupSettingsFields(SMS_FIELDS);
  assert.deepEqual(flat, [
    { name: null, fields: [...SMS_FIELDS], enabledPath: null },
  ]);
  assert.equal(settingsGroupIsOn(flat[0], {}), false);
});

test("no file on the settings page writes down how many channels there are", () => {
  const channels = notificationChannels(NOTIFICATION_FIELDS);
  const offenders: string[] = [];

  for (const relative of ["components/settings-form.tsx", "app/settings/page.tsx"]) {
    const source = readSource(relative);
    // A channel's *name* in a string literal is the list being written a second
    // time, whatever it is called.
    for (const literal of scan(source).literals) {
      if (channels.includes(literal.text)) offenders.push(`${relative}: ${literal.text}`);
    }
    // And the count itself. `rows`, `minLength` and the session timeout are the
    // only numbers either file has any business holding.
    for (const match of codeOnly(source).matchAll(/\b\d+\b/g)) {
      if (Number(match[0]) === channels.length) offenders.push(`${relative}: ${match[0]}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "the channel set belongs in NOTIFICATION_FIELDS, where the gateway's own list can be compared to it",
  );
});

/**
 * 🔴 A credential is rendered by the one control that cannot echo it.
 *
 * `SecretInput` puts an empty box with the marker as its placeholder in front
 * of a stored credential; anything else — a plain `Input`, a computed `type`, a
 * reveal toggle — either shows the credential or submits the marker back as the
 * new one. The failure is silent both ways round.
 */
test("the settings form renders every credential through the secret input", () => {
  const source = readSource("components/settings-form.tsx");
  const code = codeOnly(source);

  assert.match(code, /from "@\/components\/ui\/secret-input"/, "the sealed control is gone");
  assert.equal(
    (code.match(/<SecretInput\b/g) ?? []).length,
    1,
    "there is one place a credential is drawn, and this is not it any more",
  );
  assert.ok(!/type=\{/.test(code), "a computed input type is how a reveal toggle gets in");
  assert.ok(!/type="text"/.test(code), "a credential rendered as text is a credential on screen");
  assert.ok(!/REDACTED|••/.test(code), "the marker belongs in lib/tokens.ts, not copied here");

  // The account's own password boxes: still passwords, still asking the browser
  // for the right thing. `current-password` on the *new* one is how a browser
  // offers to fill it with the old one.
  assert.match(code, /name="current"[^/>]*type="password"[^/>]*autoComplete="current-password"/);
  assert.match(code, /name="next"[^/>]*type="password"[^/>]*autoComplete="new-password"/);

  // Every kind the field table can hold is decided on explicitly; `text` is the
  // one that falls through. A kind added to lib/ that this file never learned
  // about would otherwise render as a text box without anybody noticing.
  const decided = [...new Set([...code.matchAll(/field\.kind === "(\w+)"/g)].map((m) => m[1]))];
  assert.deepEqual(
    decided.sort(),
    SETTINGS_FIELD_KINDS.filter((kind) => kind !== "text").sort(),
    "a field kind is being drawn by whatever branch happens to catch it",
  );
});

/**
 * The list field is a textarea, and `FORM.textarea` finally has a caller.
 *
 * The recipe was added with no consumer at all, because the only place in this
 * console that carries multi-line meaning was a single-line `<input>` whose
 * placeholder said "one per line" — the one thing it told the operator to do
 * was the one thing it would not let them do. That was ruled an appearance
 * defect rather than a behaviour change: the field, the PUT and the bytes are
 * unchanged, and a box's height is not behaviour.
 */
test("the one field that means several lines is drawn as several lines", () => {
  // 🔴 What the box is *given*, which the request-body test cannot see.
  // `coerceSettingValue` splits on commas as well as newlines, so a stored list
  // joined with commas produces a byte-identical PUT and a textarea showing
  // "a@x,b@x" on one line — the exact defect this control was made to fix,
  // passing every other assertion here. Found by mutation, not by reading.
  const list = [{ path: "email.to_addresses", kind: "list" }] as const;
  assert.equal(
    settingsFormValues({ email: { to_addresses: ["a@example.com", "b@example.com"] } }, list)[
      "email.to_addresses"
    ],
    "a@example.com\nb@example.com",
    "a stored list has to arrive as one entry per line, which is what the box is now shaped for",
  );

  const areas = openingTags(readSource("components/settings-form.tsx")).filter(
    (tag) => tag.name === "textarea",
  );
  assert.equal(areas.length, 1, "the list field went back to a single line");
  assert.match(areas[0].text, /className=\{FORM\.textarea\}/, "the recipe is not the one used");
  assert.match(
    areas[0].text,
    /rows=\{\d+\}/,
    "height comes from a count of lines, which survives a change of type scale",
  );

  // The placeholder is not carrying meaning any more. It says the same thing,
  // in the operator's language, above a box that can actually hold it.
  const inputs = openingTags(readSource("components/settings-form.tsx")).filter((tag) =>
    tag.name.endsWith("Input"),
  );
  assert.deepEqual(
    inputs.filter((tag) => /placeholder=/.test(tag.text)).map((tag) => tag.name),
    [],
    "a placeholder is being asked to explain a control again",
  );

  const consumers = [...MIGRATED_SOURCES, ...UNMIGRATED_SOURCES].filter((relative) =>
    /FORM\.textarea/.test(codeOnly(readSource(relative))),
  );
  assert.ok(
    consumers.includes("components/settings-form.tsx"),
    "FORM.textarea is back to having no consumer, and a recipe nothing uses is a dead rule",
  );
});

/**
 * 🔴 The two actions that leave the browser run from a confirmation only.
 *
 * "Send test" was the one unguarded action in this console that reaches a
 * *person*: it dials the channel now, with the credential the gateway is
 * holding, and a real notification arrives somewhere real. "Save" writes a
 * whole section, credentials included, for the tenant.
 *
 * Checked at the call site, not at the import. An `ask` that is wired up and a
 * `fetch` that also still runs straight from the click is exactly the shape a
 * review reads as correct.
 */
test("the settings page cannot send or save without asking first", () => {
  const code = codeOnly(readSource("components/settings-form.tsx"));

  for (const name of ["sendTest", "saveSettings"]) {
    const calls = [...code.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))];
    assert.equal(calls.length, 2, `${name} should be declared once and called once, not ${calls.length - 1} times`);
    assert.match(
      code.slice(Math.max(0, calls[1].index - 40), calls[1].index),
      /run:\s*\(\)\s*=>\s*(void\s+)?$/,
      `${name} no longer runs from a confirmation's run`,
    );
  }

  // Every click and every submit goes to a named handler that asks. An inline
  // arrow here is how the network gets reached directly again.
  const handlers = [...code.matchAll(/on(?:Click|Submit)=\{([A-Za-z]+)\}/g)].map((m) => m[1]);
  assert.deepEqual(
    handlers.sort(),
    ["askSave", "askTest", "submit"],
    "a handler on this form reaches the gateway without asking",
  );

  assert.match(code, /<ConfirmDialog\b/, "the dialog is not rendered");

  // 🔴 And not `window.confirm` in front of it. An extra gate looks like extra
  // safety and is the thing this dialog replaced: one string, no place for the
  // consequence, which is how `device.confirmDisruptive` came to be one
  // sentence shared by seven commands that names none of them. Found by
  // mutation — adding it back passed every other assertion here.
  assert.ok(
    !/\bconfirm\s*\(/.test(code),
    "window.confirm is back: a question with nowhere to put what will happen",
  );
});

/**
 * Every label the proxy page lists resolves, in both languages.
 *
 * This page's own history: the label list was a bare `string[]` with no
 * relation to what the component read, a control reached for a key nobody had
 * listed, `t()` handed back `undefined`, and React drew undefined as nothing —
 * an empty button, in both locales, with no error anywhere. The list is a total
 * `Record<ProxyLabelKey, true>` now, so *that* half is a compile error.
 *
 * The other half is not, and was still open: a key added to the union and to
 * the list but never added to `messages/` type-checks, and passes `check-i18n`
 * because both catalogues are equally missing it. It renders as `⟦proxy.foo⟧`
 * on the page. Ten of this page's fifty labels are new, so the gap was worth
 * closing rather than noting.
 */
test("every label the proxy page lists resolves in both catalogues", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));

  const component = codeOnly(readSource("components/proxy-manager.tsx"));
  const union = component.slice(
    component.indexOf("export type ProxyLabelKey ="),
    component.indexOf(";", component.indexOf("export type ProxyLabelKey =")),
  );
  const declared = [...union.matchAll(/\|\s*"([A-Za-z]+)"/g)].map((match) => match[1]).sort();

  const page = codeOnly(readSource("app/proxy/page.tsx"));
  const listStart = page.indexOf("const PROXY_LABEL_KEYS");
  const list = page.slice(listStart, page.indexOf("};", listStart));
  const listed = [...list.matchAll(/^\s*([A-Za-z]+): true,$/gm)].map((match) => match[1]).sort();

  assert.ok(declared.length > 40, `only ${declared.length} label keys found — the reader is broken`);
  assert.deepEqual(listed, declared, "the page's list and the component's union have drifted apart");

  const unresolved: string[] = [];
  for (const key of declared) {
    for (const [language, catalogue] of [["zh", zh], ["en", en]] as const) {
      if (typeof catalogue[`proxy.${key}`] !== "string") unresolved.push(`${language} proxy.${key}`);
    }
  }
  assert.deepEqual(
    unresolved,
    [],
    "this label has no catalogue entry: it draws as ⟦proxy.…⟧, or as nothing at all",
  );
});

/**
 * A `secondary` column is secondary in its header *and* in its cells.
 *
 * `TABLE.cellSecondary` is `hidden sm:table-cell`, and it has to be on both or
 * the column half-disappears: a header with no cells under it, or a stack of
 * cells under nothing. Counting is enough because both are written once per
 * column in the source, and it is the cheapest way to catch the half that gets
 * forgotten — which is always the header, because the body cell is the one the
 * author is looking at.
 */
test("a secondary column is secondary in both its header and its cells", () => {
  const mismatched: string[] = [];
  for (const relative of MIGRATED_SOURCES) {
    const code = codeOnly(readSource(relative));
    const headers = (code.match(/<TableHeaderCell\s[^>]*secondary/g) ?? []).length;
    const cells = (code.match(/<TableCell\s[^>]*secondary/g) ?? []).length;
    if (headers !== cells) mismatched.push(`${relative}: ${headers} headers, ${cells} cells`);
  }
  assert.deepEqual(
    mismatched,
    [],
    "a column drops off the phone at one end only, which leaves a header over nothing",
  );
});

/**
 * And the confirmations say which thing, not just that something will happen.
 *
 * The interpolation is the half that goes wrong quietly: a template that names
 * `{channel}` and a call that never fills it shows the operator a literal pair
 * of braces, which is worse than the generic sentence it replaced.
 */
test("the settings confirmations name the channel and the section", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));

  for (const catalogue of [zh, en]) {
    for (const key of ["settings.confirmTest", "settings.confirmTestTitle"]) {
      assert.match(catalogue[key], /\{channel\}/, `${key} does not name the channel`);
    }
    for (const key of ["settings.confirmSave", "settings.confirmSaveTitle"]) {
      assert.match(catalogue[key], /\{section\}/, `${key} does not name the section`);
    }
  }

  const code = codeOnly(readSource("app/settings/page.tsx"));
  assert.match(code, /settings\.confirmTest"[\s\S]{0,80}channel:/, "{channel} is never filled in");
  assert.match(code, /settings\.confirmSave"[\s\S]{0,80}section:/, "{section} is never filled in");

  // The credential sentence is appended only where there is a credential, so
  // the SMS section's single number does not warn about passwords.
  const text = { save: "The section is written.", secrets: "Credentials are written." };
  assert.equal(settingsSaveConsequence(NOTIFICATION_FIELDS, text), `${text.save} ${text.secrets}`);
  assert.equal(settingsSaveConsequence(SMS_FIELDS, text), text.save);
  assert.equal(settingsSaveConsequence(SECURITY_FIELDS, text), text.save);
});

/**
 * The layout, and the read-only gate that has to survive it.
 *
 * `card-grid` was the fourth dead class, and unlike the other three it was on
 * no survey — three separate readings of this page missed it. The four cards
 * have been stacking in ordinary block flow with no gap at all while the markup
 * said they were in a grid. The replacement is measured in a browser at 390px
 * rather than asserted here; what is asserted here is that the page asks for
 * something that exists, and that migrating it did not hand a read-only account
 * a Save button.
 */
test("the settings page lays its cards out with something that exists", () => {
  const source = readSource("app/settings/page.tsx");
  const { masked } = scan(source);
  const code = codeOnly(source);

  const stacked = openingTags(source).filter((tag) => /className=\{PAGE\.stack\}/.test(tag.text));
  assert.equal(stacked.length, 1, "the cards are back in block flow with no gap between them");
  for (const dead of ["card-grid", "card-span-all"]) {
    assert.ok(!code.includes(dead), `${dead} is back, and neither of them is a rule anywhere`);
  }

  // Read-only: the form is the consequent of the writable branch and appears
  // nowhere else.
  assert.match(code, /mayWrite\(role\)/, "the role is no longer being asked for");
  assert.equal((code.match(/<SettingsForm\b/g) ?? []).length, 1);
  assert.match(
    code,
    /return writable \? \(\s*<SettingsForm/,
    "the editable form is no longer behind the write check",
  );

  // And changing your own password is *not* behind it. The gateway allows it
  // for a read-only session, and an account that cannot respond to its own
  // credential leaking leaves nobody safer. Every brace opened after the stack
  // closes again before this element, so it is not the arm of a conditional.
  const stackAt = masked.indexOf("className={PAGE.stack}");
  const passwordAt = masked.indexOf("<PasswordForm");
  assert.ok(stackAt !== -1 && passwordAt > stackAt, "the password form left the page");
  const between = masked.slice(stackAt, passwordAt);
  assert.equal(
    (between.match(/\{/g) ?? []).length,
    (between.match(/\}/g) ?? []).length,
    "something is gating the password form: a read-only account cannot rotate its own credential",
  );
});

/**
 * Nothing ships a rule that nothing asks for.
 *
 * Tailwind's scanner reads *text*, not code. A class name written in a comment,
 * or a list of identifiers that happen to be utility names, becomes a real rule
 * in the stylesheet the console downloads. `tailwind.config.ts` already records
 * this happening once — a test that had to write `p-[13px]` and `dark:bg-bad`
 * down in order to reject them put both into the shipped CSS, "dead rules that
 * look exactly like the thing being guarded against, in the artefact an audit
 * would read".
 *
 * It happened again while this card was being written, and the same way. A list
 * of Tailwind scale names in `lib/tokens.ts` contains `blur`, `grayscale`,
 * `invert` and `sepia`, all four of which are bare utilities, and a prose note
 * explaining that the `flex` *scale* is not the `flex-row` *utility* emitted
 * `.flex-row`. Five dead rules, from two comments and one array of identifiers.
 * It was found by diffing the built CSS against the previous build, which is
 * not something anyone will do again by hand.
 *
 * So the build is asked directly: every class it generates has to be one some
 * file actually puts in a `className`, or be on the ledger below. The fix for a
 * new one is almost always to not write the name — "the direction utilities"
 * rather than naming one — which is the right change anyway, because the rule
 * was never wanted.
 */

/**
 * Rules in the shipped stylesheet that no `className` asks for, and why.
 *
 * This cannot be empty, and pretending otherwise would make the test a
 * nuisance that gets deleted. Prose about a design system contains the words
 * "table", "inline", "block", "collapse", "filter", "outline", "ring",
 * "shrink" and "visible", and Tailwind ships a bare utility named after every
 * one of them. Three more come from the *documentation of the escape hatch* —
 * `sm:grid`, `max-sm:grid` and `sr-only` are named in `LEGACY_UTILITY_COLLISIONS`
 * and asserted to generate by the test above, so they are wanted.
 *
 * Every entry was already shipping before this card. Five more were added
 * during it and removed again — four filter utilities from an array of scale
 * names and one direction utility from a sentence explaining the difference
 * between a scale and a utility of the same name.
 *
 * The list may shrink. It may not grow without somebody saying why here.
 */
const RULES_SHIPPED_UNASKED = [
  // Ordinary English in the recipes' own comments.
  // `block` left this list under T015: `TABLE.cellNote` asks for it.
  "collapse",
  "filter",
  "inline",
  "outline",
  "ring",
  "shrink",
  "table",
  "visible",
  // The same thing in files this card cannot edit: `invisible` from
  // `components/esim-panel.tsx:918`, `static` from `app/manifest.ts:4`.
  "invisible",
  "static",
  // Wanted: the documented way to lay something out in a grid before the
  // legacy layer is deleted, plus the collision name that is safe to use.
  "max-sm:grid",
  "sm:grid",
  "sr-only",
  // `grid` itself, added by T014 and for the same reason as the two above it:
  // `LEGACY_UTILITY_COLLISIONS` and `FORBIDDEN_IN_MIGRATED_SOURCES` both spell
  // the name out in `lib/tokens.ts`, which is Tailwind content, so the rule is
  // built from the ledger that exists to forbid it. It became unasked rather
  // than newly shipped: `app/inbox/page.tsx:54` was the last `className="grid
  // grid-wide"` in the console, and migrating that page took the last caller
  // away. Deleting the name from the ledger is not the fix — the ledger is
  // what the guard reads.
  "grid",
  // `grow` joined it under T011 for exactly the same reason, one merge later:
  // it is spelled out in both ledgers in `lib/tokens.ts`, and the last caller
  // went away when the device console was migrated. Same rule as above —
  // deleting the name from the ledger is not the fix.
  "grow",
];

test("the stylesheet contains no rule that no file asks for", async () => {
  const asked = new Set<string>(allUsedClasses());
  for (const relative of UNMIGRATED_SOURCES) {
    for (const name of classesIn(classListsIn(readSource(relative)))) asked.add(name);
  }

  // The real content globs, so this is the stylesheet that ships.
  const result = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [
        join(root, "app/**/*.{ts,tsx}"),
        join(root, "components/**/*.{ts,tsx}"),
        join(root, "lib/tokens.ts"),
      ],
    }),
  ]).process("@tailwind utilities;", { from: undefined });

  const shipped = new Set<string>();
  result.root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      for (const name of classNamesInSelector(selector)) shipped.add(name);
    }
  });
  assert.ok(shipped.size > 50, `only ${shipped.size} rules built — the build is not running`);

  const unasked = [...shipped].filter((name) => !asked.has(name)).sort();
  assert.deepEqual(
    unasked,
    [...RULES_SHIPPED_UNASKED].sort(),
    "a rule is in the stylesheet the console downloads and no file uses it: " +
      "a utility name was written in prose or in a list of identifiers, and Tailwind reads text",
  );
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
    [
      "/",
      "/devices",
      "/journal",
      "/audit",
      "/inbox",
      // Comms, not Settings: `/sessions` is `/inbox`'s messages grouped per
      // peer, and the grouping that put it elsewhere was confirmed against a
      // description of it as sign-in sessions. See NAV_GROUPS.
      "/sessions",
      "/rules",
      "/schedule",
      "/proxy",
      "/settings",
    ],
    "the confirmed grouping is fleet / comms / network / settings",
  );
  assert.equal(new Set(hrefs).size, hrefs.length, "a destination appears in one group only");

  for (const group of NAV_GROUPS) {
    assert.ok(group.items.length > 0, "an empty group is a divider pretending to be a section");
    // A label is dropped only when it would repeat its single link's own name.
    if (group.label === null) assert.equal(group.items.length, 1);
  }
});

/**
 * Every page this console serves is reachable without typing a URL.
 *
 * `/sessions` was not, for two cards: T007 was given a four-group layout that
 * did not mention it, implemented exactly that, and reported that the page had
 * lost its only link. Nothing failed, because "the nav covers every
 * destination" was checked against a list of destinations that had the same
 * hole in it. So the list is derived from the routes on disk instead.
 *
 * `/login`, `/not-a-tenant` and `/unknown-tenant` are excluded on purpose: two
 * are error destinations and the third renders outside the shell that draws
 * this nav. A dynamic segment is a child of the section that links to it.
 */
test("every page under app/ has a way in", () => {
  const routes: string[] = [];
  const walk = (dir: string, href: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${href}/${entry.name}`);
      else if (entry.name === "page.tsx") routes.push(href === "" ? "/" : href);
    }
  };
  walk("app", "");

  const linked = new Set(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href)));
  const orphans = routes
    .filter((route) => !route.includes("["))
    .filter((route) => !["/login", "/not-a-tenant", "/unknown-tenant"].includes(route))
    .filter((route) => !linked.has(route))
    .sort();

  assert.deepEqual(orphans, [], "a page nothing links to: reachable only by typing its URL");
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

/* ── The device list, and the narrow-screen table pattern ─────────────────
 *
 * This page holds the two widest tables in the console — nine columns of ids,
 * addresses and timestamps, then eight of IMEIs and ICCIDs — so it is where the
 * pattern the six page cards after it copy has to be shown working. The pattern
 * itself is `TABLE.cellSecondary` and was sealed with `components/ui/table.tsx`;
 * what is checked here is the part a page gets wrong.
 */

type Column = { readonly attributes: string; readonly contents: string };

/**
 * The columns of each `<Table>` in a file: the header cells in order, and the
 * body cells in order.
 *
 * A regex over the whole file cannot answer the question that matters, which is
 * whether the *same* column is marked in both rows. `secondary` on a header and
 * `secondary` on a body cell are two different columns as easily as one, and a
 * count of each would be equal either way — which is a check that passes while
 * the header of one column and the body of another disappear on a phone,
 * leaving a table whose remaining headings name the wrong values.
 */
function tableColumns(source: string): { headers: Column[]; cells: Column[] }[] {
  const { masked, code } = scan(source);
  const tables: { headers: Column[]; cells: Column[] }[] = [];
  const opened: { name: string; start: number; end: number }[] = [];

  for (const match of masked.matchAll(/<(Table|TableHeaderCell|TableCell)\b/g)) {
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
    opened.push({ name: match[1], start, end });
  }

  for (const [index, tag] of opened.entries()) {
    if (tag.name === "Table") {
      tables.push({ headers: [], cells: [] });
      continue;
    }
    const table = tables[tables.length - 1];
    if (!table) continue;
    // A cell's contents run to whatever opens next, or to the end of the body.
    const next = opened[index + 1];
    const bodyEnd = code.indexOf("</TableBody>", tag.end);
    const stop = Math.min(
      next ? next.start : code.length,
      bodyEnd === -1 ? code.length : bodyEnd,
    );
    const column = {
      attributes: code.slice(tag.start, tag.end + 1),
      contents: code.slice(tag.end + 1, stop),
    };
    if (tag.name === "TableHeaderCell") table.headers.push(column);
    else table.cells.push(column);
  }
  return tables;
}

const NARROW_SCREEN_TABLES = ["app/devices/page.tsx", "components/card-policies.tsx"];

test("a column that drops off the phone drops off in its header and its body alike", () => {
  const mismatched: string[] = [];
  let checked = 0;

  for (const relative of NARROW_SCREEN_TABLES) {
    const tables = tableColumns(readSource(relative));
    assert.ok(tables.length > 0, `${relative} renders no <Table>`);
    for (const [index, table] of tables.entries()) {
      const secondary = (column: Column) => /\bsecondary\b/.test(column.attributes);
      const headers = table.headers.map(secondary);
      const cells = table.cells.map(secondary);
      if (headers.length !== cells.length || headers.some((on, at) => on !== cells[at])) {
        mismatched.push(`${relative} table ${index}: ${headers.join()} vs ${cells.join()}`);
      }
      // A table where nothing is secondary is a table that scrolls sideways on
      // a phone for every one of its columns, and would pass the line above
      // without the pattern having been applied at all.
      assert.ok(
        headers.some(Boolean),
        `${relative} table ${index} drops no column on a phone`,
      );
      checked += headers.length;
    }
  }

  assert.deepEqual(mismatched, [], "a column is secondary in one row and not the other");
  // The two tables on the device page are nine and eight columns; the card
  // policy table is five. A count here so that a table which stops being found
  // fails rather than quietly reducing this test to nothing.
  assert.equal(checked, 22, `${checked} columns found, not the 22 these three tables have`);
});

test("a column with a control in it never drops off the phone", () => {
  // Hiding a reading below `sm` is deprioritising context. Hiding a link, a
  // tick, a picker or a button is removing the ability to do the thing, on the
  // device where it is hardest to get it back.
  const controls = /<(Link|Button|Select|Checkbox|InlineField|RowActions|a|button|select|input)\b/;
  const hidden: string[] = [];
  for (const relative of NARROW_SCREEN_TABLES) {
    for (const table of tableColumns(readSource(relative))) {
      for (const cell of table.cells) {
        if (!/\bsecondary\b/.test(cell.attributes)) continue;
        if (controls.test(cell.contents)) hidden.push(`${relative}: ${cell.attributes}`);
      }
    }
  }
  assert.deepEqual(hidden, [], "a control is being hidden on a phone, not a reading");
});

/**
 * Recipes that ask for a border width and never say what kind of border.
 *
 * 🔴 **Preflight is off, and the reset that stands in for it does not carry
 * preflight's `border-style: solid`.** `app/globals.css` resets `box-sizing`
 * and nothing else. So a Tailwind border-*width* utility computes to **0px**
 * unless something else has set a style: `border-style` defaults to `none`, and
 * a `none` border has no width whatever the width utility says.
 *
 * Measured at 390x844 against the real build, not read:
 *
 * | recipe | element | asked for | computed |
 * |---|---|---|---|
 * | `TABS.list` | `div` | `border-b border-line` | `none 0px` — **fixed here** |
 * | `TABS.tab` | `a` | `border-b-2` | `none 0px` — **fixed here** |
 * | `CARD.root` | `section` | `border border-line` | `none 0px` |
 * | `TABLE.row` | `tr` | `border-b border-line` | `none 0px` |
 * | `BUTTON.base` | `button` | `border` | `solid 1px` — the legacy layer |
 * | `FORM.input` | `input` | `border` | `solid 1px` — the legacy layer |
 * | `TABLE.headerCell` | `th` | `border-b` | `solid 1px` — the legacy layer |
 *
 * The ones that work are the ones the legacy layer hands a `border:` shorthand
 * to by element name. **That is the trap**: the tab that renders as a
 * `<button>` drew correctly and the one that renders as an `<a>` did not, from
 * one recipe — and it means the whole class of defect disappears on the day
 * `@layer legacy` is deleted for the recipes that look fine today, and stays
 * for the ones that do not.
 *
 * 🔴 **`CARD.root` and `TABLE.row` are not fixed here and this list is how that
 * is reported rather than forgotten.** They are drawn on `/`, `/login`,
 * `/audit`, the shell, and the ten pages that still import the compatibility
 * layer. Giving them a border style makes a border appear on fifteen pages that
 * do not have one today — a visible change to already-migrated pages, which is
 * a call for the operator and the PM, not for a card migrating one page. The
 * complete fix is one declaration in the reset in `app/globals.css`, which no
 * page card may edit.
 *
 * The list may only shrink: a new recipe that asks for a width without a style
 * fails immediately.
 */
const BORDER_WIDTH_WITHOUT_A_STYLE = [
  "BUTTON.base",
  "CARD.disclosureSummary",
  "CARD.header",
  "CARD.root",
  "CENTERED.card",
  "CONFIRM.panel",
  "FORM.input",
  "FORM.select",
  "FORM.textarea",
  "SEGMENTED.root",
  "SHELL.header",
  "SHELL.navGroup",
  "SHELL.tenant",
  "STAT.root",
  "TABLE.headerCell",
  "TABLE.row",
  "TABLE.specRow",
];

test("a recipe that asks for a border width says what kind of border it is", () => {
  const width = /^(-?border)(-[xytrbl])?(-\d+)?$/;
  const found: string[] = [];
  const table = TOKENS as unknown as Record<string, unknown>;

  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      const words = value.split(/\s+/).filter(Boolean);
      // `border-b-0` and friends switch a side off; asking for a style there
      // would be asking for a style on a border that is not being drawn.
      const asks = words.some((word) => width.test(word) && !/-0$/.test(word));
      if (asks && !words.includes("border-solid")) found.push(path);
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    }
  };
  for (const name of recipeNames()) walk(table[name], name);

  // Derived, not remembered: if the width matcher stops matching, everything
  // below it is vacuously true.
  assert.ok(
    found.length > 0,
    "the border-width matcher found nothing at all; this check is measuring nothing",
  );
  const unlisted = found.filter((path) => !BORDER_WIDTH_WITHOUT_A_STYLE.includes(path)).sort();
  assert.deepEqual(
    unlisted,
    [],
    "this recipe's border computes to 0px: preflight is off and nothing sets border-style",
  );
  const fixed = BORDER_WIDTH_WITHOUT_A_STYLE.filter((path) => !found.includes(path));
  assert.deepEqual(fixed, [], "one of these was fixed; take it off the list so it cannot come back");

  // 🔴 The other half, and the reason preflight is two declarations rather than
  // one. Switching `border-style` on switches it on for all four sides, and the
  // initial `border-*-width` is `medium` — 3px. A recipe that says
  // `border-solid` and states a width for one side gets a 3px rule on the other
  // three. Measured: the first `border-solid` on the tab strip put a 3px line
  // along its top. So every side has to be given a width.
  const SIDES = ["top", "right", "bottom", "left"];
  const covers: Record<string, string[]> = {
    "": SIDES,
    x: ["right", "left"],
    y: ["top", "bottom"],
    t: ["top"],
    r: ["right"],
    b: ["bottom"],
    l: ["left"],
  };
  const partial: string[] = [];
  const walkStyles = (value: unknown, path: string) => {
    if (typeof value === "string") {
      const words = value.split(/\s+/).filter(Boolean);
      if (!words.includes("border-solid")) return;
      const given = new Set<string>();
      for (const word of words) {
        const match = width.exec(word);
        if (match) for (const side of covers[(match[2] ?? "").replace("-", "")]) given.add(side);
      }
      const uncovered = SIDES.filter((side) => !given.has(side));
      if (uncovered.length) partial.push(`${path}: no width on ${uncovered.join(", ")}`);
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) walkStyles(inner, `${path}.${key}`);
    }
  };
  for (const name of recipeNames()) walkStyles(table[name], name);
  assert.deepEqual(
    partial,
    [],
    "a side with no width stated renders at the initial `medium`, which is 3px",
  );
});

/* ── The device detail page ──────────────────────────────────────────── */

const DEVICE_PAGE = "app/devices/[deviceId]/page.tsx";

/**
 * The four tabs are one list, and every one of them has a panel.
 *
 * This page was split across two cards: one built the strip and filled the two
 * read-only panels, the next fills the console and the eSIM panels. The list is
 * data so that both cards are reading the same four ids — a strip written as
 * markup would let the second card arrive with a fifth tab, a renamed id or a
 * second spelling of "console", and nothing here could see it.
 *
 * The `case` check is the half that matters: a tab whose id has no branch in
 * `panelFor` renders an empty panel, which looks like a page that failed to
 * load rather than like a mistake.
 */
test("the device page's four tabs are one list, and every one of them has a panel", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));

  assert.equal(DEVICE_TABS.length, 4, "the operator agreed to four tabs on this page");
  assert.deepEqual(
    [...new Set(DEVICE_TABS.map((tab) => tab.id))].length,
    DEVICE_TABS.length,
    "two tabs share an id, so one of them can never be selected",
  );
  assert.equal(
    DEVICE_TABS.filter((tab) => tab.readOnly).length,
    2,
    "two panels read and two write; that split is why this page took two cards",
  );

  // A missing key renders as ⟦key⟧ in the tab strip itself.
  const missing = DEVICE_TABS.map((tab) => tab.key).filter(
    (key) => typeof zh[key] !== "string" || typeof en[key] !== "string",
  );
  assert.deepEqual(missing, [], "a tab label is not in both catalogues");

  const code = codeOnly(readSource(DEVICE_PAGE));
  const branches = (code.match(/case "([a-z]+)":/g) ?? []).map((line) =>
    line.slice(6, -2),
  );
  assert.deepEqual(
    branches.slice().sort(),
    DEVICE_TABS.map((tab) => tab.id).sort(),
    "a tab has no panel, or a panel answers to an id no tab asks for",
  );
});

/**
 * The strip is rendered from that list, and it is links.
 *
 * Two claims, and both have been wrong in this console before. Rendering from
 * the list rather than writing four elements is what makes the assertion above
 * mean anything — four hand-written tabs satisfy every count and share nothing
 * with the data. And links rather than client state is what keeps this page a
 * server component: the moment it takes `"use client"` to remember which tab is
 * open, every string on it is resolved against the default locale in the
 * server's HTML and corrected only by hydration. This console has shipped that
 * exact defect twice.
 */
test("the device page's tabs are links rendered from the shared list", () => {
  const code = codeOnly(readSource(DEVICE_PAGE));

  assert.match(code, /DEVICE_TABS\.map\(/, "the strip is not rendered from the shared list");
  assert.equal((code.match(/<Tab\b/g) ?? []).length, 1, "a tab was written by hand beside the map");
  assert.equal((code.match(/<TabList\b/g) ?? []).length, 1);
  assert.equal((code.match(/<TabPanel\b/g) ?? []).length, 1, "exactly one panel is drawn at a time");
  assert.match(code, /<Tab\b[^>]*href=\{deviceTabHref\(/, "a tab that does not change the URL");

  for (const forbidden of [/"use client"/, /\buseState\b/, /\bonClick\b/]) {
    assert.ok(
      !forbidden.test(code),
      `the device page gained ${forbidden}: its tabs are URLs, and its language depends on that`,
    );
  }
  // And every string is resolved against the locale this request read on the
  // server. A `t(key)` with the locale left off renders the default language
  // into the HTML and looks right in a browser only after hydration.
  assert.match(code, /await getRequestLocale\(\)/);
  assert.equal(
    (code.match(/\bt\(/g) ?? []).length,
    (code.match(/\bt\([^)]*,\s*locale\b/g) ?? []).length,
    "a t() call on the device page is missing its locale argument",
  );
});

/**
 * Every part of the page comes from the shared components, at the point of use.
 *
 * Counting call sites rather than imports, for the reason the overview's
 * version of this says: an import survives the deletion of the thing it was
 * wired to.
 */
test("the device list is drawn by the shared components, at the point of use", () => {
  const code = codeOnly(readSource("app/devices/page.tsx"));
  const uses = (pattern: RegExp) => (code.match(pattern) ?? []).length;

  assert.equal(uses(/<Table\b/g), 2, "the fleet table and the module table");
  // Seventeen, which is what this page actually has. T021 reported nineteen and
  // T030 recounted it; the number is here so that a column added without a
  // narrow-screen decision fails rather than arrives.
  assert.equal(uses(/<TableHeaderCell\b/g), 17, "nine columns then eight");
  assert.equal(uses(/<CardEmpty\b/g), 2, "both empty cases still say what would be here");
  assert.equal(uses(/<Card\b/g), 3, "devices, modules, card policies");
  // Preflight is off, so a bare `<table>` is not merely a second implementation:
  // the legacy stylesheet would style it, which is the mechanism by which two
  // implementations drift apart.
  assert.equal(uses(/<(table|thead|tbody|tr|th|td)\b/g), 0, "hand-written table markup is back");
  assert.equal(uses(/<section\b/g), 0, "a card was written by hand beside the components");

  // The page reads nothing on the client and the locale is the server's.
  assert.ok(!/"use client"/.test(code), "the device list stopped being a server component");
  assert.match(code, /await getRequestLocale\(\)/, "the locale is no longer resolved server-side");
  assert.equal(
    (code.match(/\bt\(/g) ?? []).length,
    (code.match(/\bt\([^,()]+,\s*locale\b/g) ?? []).length,
    "a t() call on this page is missing its locale argument",
  );
});

/**
 * The four pills this page drew by hand.
 *
 * `class="badge badge-warn"` beside a `StateBadge` the same file already
 * imports is how one console ends up with two ideas of what "warn" looks like.
 * The tones are asserted, not just the count: turning the backlog pill neutral
 * or giving the roaming pill no tone at all keeps every count correct.
 */
test("the four hand-written pills on the device list are the shared badge", () => {
  const source = readSource("app/devices/page.tsx");
  const code = codeOnly(source);

  // The read-only badge T034 added is a fifth `<Badge>` and is *not* one of the
  // four: it replaced no old class, it is in the page head rather than in a
  // table, and it is checked by the role gate's own test. Counting it in here
  // would have meant loosening the tone list below, which is the part that says
  // a pill did not quietly turn neutral. `code` rather than `masked`, because
  // the key is inside a string literal and `masked` blanks those.
  const roleAt = code.indexOf('t("role.readOnlyBadge"');
  assert.notEqual(roleAt, -1, "the read-only badge left the device list");
  const roleBadgeAt = code.lastIndexOf("<Badge", roleAt);
  const rendered = [...code.matchAll(/<Badge\b[^>]*/g)]
    .filter((match) => match.index !== roleBadgeAt)
    .map((match) => match[0]);
  assert.equal(rendered.length, 4, "four hand-written pills, four shared badges");

  const tones = rendered.map((tag) => /tone="(\w+)"/.exec(tag)?.[1]);
  assert.deepEqual(
    tones,
    ["warn", "warn", "neutral", "warn"],
    "backlog, not-manageable, bearer, roaming — the tones the old classes had",
  );
  // A count and a category are not states, so they take no status dot; the two
  // that qualify a module's condition keep theirs.
  assert.equal(
    rendered.filter((tag) => /dot=\{false\}/.test(tag)).length,
    2,
    "the backlog count and the bearer are not states",
  );
  assert.equal(
    (code.match(/<StateBadge\b/g) ?? []).length,
    2,
    "the device state and the module state, which were already the component",
  );

  const handWritten = classListsIn(code).filter((list) => /(^|\s)badge(-|\s|$)/.test(list));
  assert.deepEqual(handWritten, [], "a badge is still being drawn from the old stylesheet");
});

/* ── The card policy table ───────────────────────────────────────────────
 *
 * Five edits, every one of them a `PUT` or a `DELETE` that reaches every device
 * in the tenant, and until this card not one of them asked anything. The guard
 * that the request cannot be reached except through the dialog is the shared
 * `CONFIRMED_WRITES` one above. These are about the other half: that the dialog
 * has something true to say, and that the request it finally sends is the
 * request this component always sent.
 */

test("every card policy edit has a dialog, and every dialog has both halves", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));

  const guards = Object.keys(CARD_POLICY_CONFIRMATIONS);
  assert.ok(guards.length > 0, "an empty table confirms nothing");

  const missing: string[] = [];
  for (const [guard, keys] of Object.entries(CARD_POLICY_CONFIRMATIONS)) {
    for (const [language, catalogue] of [["zh", zh], ["en", en]] as const) {
      if (typeof catalogue[keys.title] !== "string") missing.push(`${language} ${keys.title}`);
      if (typeof catalogue[keys.consequence] !== "string") {
        missing.push(`${language} ${keys.consequence}`);
      }
    }
    // The consequence has to be on the list the rule is run over, or it is a
    // paragraph nothing has ever read. That list is what catches "写了中文,
    // 英文忘了" and "this is a question, not a consequence".
    assert.ok(
      (CONFIRM_CONSEQUENCE_KEYS as readonly string[]).includes(keys.consequence),
      `${guard}'s consequence is not in CONFIRM_CONSEQUENCE_KEYS, so no rule is run over it`,
    );
  }
  assert.deepEqual(missing, [], "a card policy dialog has no copy in one of the languages");

  // Every guard the function can return has an entry, and every entry is
  // reachable. A sixth kind of edit whose copy was never written fails here.
  const returned = new Set(
    [
      cardPolicyGuardFor({ kind: "cellular", enabled: false }),
      cardPolicyGuardFor({ kind: "cellular", enabled: true }),
      cardPolicyGuardFor({ kind: "vertical", from: "cn", to: "intl" }),
      cardPolicyGuardFor({ kind: "add" }),
      cardPolicyGuardFor({ kind: "remove" }),
    ].filter((guard): guard is NonNullable<typeof guard> => guard !== null),
  );
  assert.deepEqual([...returned].sort(), guards.sort(), "a dialog nobody opens, or an edit with none");
});

test("an edit that changes nothing sends nothing, and null never means send", () => {
  // The tick, both ways round. Allowing data is not the harmless direction: a
  // card blocked to stop it billing was blocked on purpose.
  assert.equal(cardPolicyGuardFor({ kind: "cellular", enabled: false }), "cellularOff");
  assert.equal(cardPolicyGuardFor({ kind: "cellular", enabled: true }), "cellularOn");
  assert.equal(cardPolicyGuardFor({ kind: "vertical", from: "cn", to: "intl" }), "vertical");
  assert.equal(cardPolicyGuardFor({ kind: "add" }), "add");
  assert.equal(cardPolicyGuardFor({ kind: "remove" }), "remove");

  // The only `null`, and it means "there is nothing to send" — a picker put
  // back on the value it started from. The component treats `null` as a dead
  // end rather than as permission, which is what makes the dialog the only way
  // out of `propose`.
  assert.equal(cardPolicyGuardFor({ kind: "vertical", from: "cn", to: "cn" }), null);

  const propose = functionBody(readSource("components/card-policies.tsx"), "propose");
  assert.ok(propose, "the single entry point every control goes through is gone");
  assert.match(propose, /cardPolicyGuardFor\(/, "propose no longer asks which dialog is needed");
  assert.match(propose, /if\s*\(guard === null\)\s*return/, "a null guard stopped being a dead end");
  for (const escape of [/fetch\s*\(/, /\bsave\s*\(/, /\bremovePolicy\s*\(/]) {
    assert.ok(!escape.test(propose), `propose can reach ${escape} without a dialog`);
  }
});

/**
 * The request is the one this component always sent.
 *
 * The confirmation is the only thing this card was allowed to add. The body of
 * the `PUT` is four fields with a two-step fallback each — the patch, then the
 * row being edited, then the same default the gateway would apply — and `??`
 * rather than `||` is load-bearing on the first of them: `false || existing` is
 * how "block this card" turns into "leave it as it was".
 */
test("the card policy requests are the ones this component always sent", () => {
  const source = readSource("components/card-policies.tsx");
  const save = functionBody(source, "save");
  const removePolicy = functionBody(source, "removePolicy");
  assert.ok(save, "the function that sends the PUT is gone");
  assert.ok(removePolicy, "the function that sends the DELETE is gone");

  assert.match(save, /fetch\(`\/v1\/cards\/\$\{iccid\}\/policy`,/);
  assert.match(save, /method:\s*"PUT"/);
  assert.match(save, /"content-type":\s*"application\/json"/);
  assert.match(save, /cellular_enabled:\s*patch\.cellularEnabled \?\? existing\?\.cellularEnabled \?\? true/);
  assert.match(save, /vertical:\s*patch\.vertical \?\? existing\?\.vertical \?\? "cn"/);
  assert.match(save, /apn:\s*patch\.apn \?\? existing\?\.apn \?\? null/);
  assert.match(save, /note:\s*patch\.note \?\? existing\?\.note \?\? ""/);
  assert.ok(!/\|\|\s*existing/.test(save), "a ?? became a ||, and false is not absent");

  assert.match(removePolicy, /fetch\(`\/v1\/cards\/\$\{iccid\}\/policy`,\s*\{\s*method:\s*"DELETE"\s*\}/);

  // And the patch each edit turns into is the one the old call sites passed:
  // `{ cellularEnabled }` from the tick, `{ vertical }` from the picker, and
  // both from the add form, which is what a card with no row has to be given.
  assert.deepEqual(cardPolicyPatch({ kind: "cellular", enabled: false }), {
    cellularEnabled: false,
  });
  assert.deepEqual(cardPolicyPatch({ kind: "cellular", enabled: true }), { cellularEnabled: true });
  assert.deepEqual(cardPolicyPatch({ kind: "vertical", from: "cn", to: "intl" }), {
    vertical: "intl",
  });
  assert.deepEqual(cardPolicyPatch({ kind: "add" }), { cellularEnabled: true, vertical: "cn" });

  // The native dialog is gone, and with it the one string it could show.
  assert.ok(!/window\.confirm/.test(codeOnly(source)), "window.confirm is back");
});

/**
 * Counting call sites, not imports, for the reason the overview's version of
 * this gives: an import survives the deletion of the thing it was wired to.
 *
 * The two table shapes are both here and that is the point of there being two.
 * The module list is a data grid; the host block is four pairs of a name and a
 * reading with **no `<th>` at all**, which is why any narrow-screen treatment
 * built on header text does nothing to it.
 */
test("the device page is drawn by the shared components, at the point of use", () => {
  const source = readSource(DEVICE_PAGE);
  const code = codeOnly(source);
  const uses = (pattern: RegExp) => (code.match(pattern) ?? []).length;

  assert.equal(uses(/<Table\b/g), 2, "the module list and the radio readings");
  assert.equal(uses(/<SpecTable\b/g), 1, "the host block, which has no header row");
  assert.equal(uses(/<SpecRow\b/g), 4, "public IP, CPU, memory, reported-at");
  // Three, not six. The console and eSIM panels draw their own cards — one per
  // section — because a card holding four headings and eight tables is the
  // arrangement the tab strip was built to break up, and a card inside a card
  // is how a heading stops meaning anything.
  assert.equal(uses(/<Card\b/g), 3, "modules, host vitals, radio readings");
  assert.equal(uses(/<CardShell\b/g), 1, "the danger-zone card, composed so its header can be red");
  assert.equal(uses(/<CardEmpty\b/g), 3, "each empty case still says what would be here");

  // Preflight is off, so a bare `<table>` is not merely a second
  // implementation: the legacy stylesheet paints it, which is the mechanism by
  // which the two drift apart.
  assert.equal(uses(/<(table|thead|tbody|tr|th|td)\b/g), 0, "hand-written table markup is back");
  assert.equal(uses(/<section\b/g), 0, "a card was written by hand beside the components");

  // The two hand-written pills this page carried: the unmanaged module and the
  // roaming module. Both were `class="badge badge-warn"` with the gap supplied
  // by `style={{ marginLeft: … }}` — an inline style is the one thing none of
  // these guards can read.
  assert.equal(uses(/<Badge\b/g), 2, "the unmanaged pill and the roaming pill");
  assert.equal(uses(/<StateBadge\b/g), 1, "the device's own state, in the heading");
  const handWritten = classListsIn(source).filter((list) => /(^|\s)badge(-|\s|$)/.test(list));
  assert.deepEqual(handWritten, [], "a badge is still being drawn from the old stylesheet");
  assert.ok(!/\bstyle=\{\{/.test(code), "an inline style is unreachable from every check here");
});

/**
 * The widest column drops off the phone, and it drops on both of its cells.
 *
 * `TABLE.cellSecondary` is `hidden sm:table-cell`, which has to be on the
 * header cell *and* the body cell of the same column or the header stays and
 * the values vanish. The ICCID is the widest value on this page at twenty
 * monospace characters, and it is the one that goes: every control on this page
 * addresses a module by IMEI.
 */
test("the device page's widest column is marked secondary on both of its cells", () => {
  const code = codeOnly(readSource(DEVICE_PAGE));
  const headers = code.match(/<TableHeaderCell\b[^>]*secondary/g) ?? [];
  const cells = code.match(/<TableCell\b[^>]*secondary/g) ?? [];
  assert.equal(headers.length, 1, "the ICCID header is no longer marked secondary");
  assert.equal(
    cells.length,
    headers.length,
    "a column is secondary in its header and not in its body, or the other way round: " +
      "one of them stays on the phone alone",
  );
  // And the recipe those two share really is a rule the build generates.
  assert.match(TABLE.cellSecondary, /\bhidden\b/);
  assert.match(TABLE.cellSecondary, /\bsm:table-cell\b/);
});

/**
 * A class that only means something inside a grid, used outside one.
 *
 * 🔴 This is a third kind of dead class, and neither of the two ledgers above
 * can see it. `card-grid` is a name **no stylesheet defines**. `.risk` is a
 * name that is only ever declared **under an ancestor**. `card-span-all` is
 * neither: `.card-span-all { grid-column: 1 / -1 }` is a real, unconditional
 * rule — it does nothing because every container it was put in is `display:
 * block`. The device detail page carried two of them, and the proxy page's
 * migration found the shape and had no guard to hand it to.
 *
 * Derived from the stylesheet rather than listed, so the next rule of this
 * shape is covered the day it is written. It bites on migrated files only,
 * which makes it a ratchet: `app/proxy` and `app/settings` still carry one
 * each, and each becomes covered by being migrated.
 */
test("a migrated file does not use a class that only works inside a grid", () => {
  const names = new Set<string>();
  for (const rule of legacyLayer().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = rule[2]
      .split(";")
      .map((one) => one.trim())
      .filter(Boolean);
    if (declarations.length === 0) continue;
    if (!declarations.every((one) => /^grid-(column|row|area)\s*:/.test(one))) continue;
    for (const name of rule[1].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(name[1]);
  }
  // Derived, not remembered: if the extractor stops finding the one known
  // instance, the check below is passing because it is looking at nothing.
  assert.ok(
    names.has("card-span-all"),
    "the grid-only-rule extractor found nothing; every assertion under it is vacuous",
  );

  const offenders: string[] = [];
  for (const relative of MIGRATED_SOURCES) {
    for (const used of classesIn(classListsIn(readSource(relative)))) {
      if (names.has(used)) offenders.push(`${relative}: ${used}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "this rule exists and does nothing: the element carrying it is not in a grid",
  );
});

/**
 * Which panel a URL asks for, including the ones that are not asking properly.
 *
 * Total by construction. `?tab=` is a URL, so a stale bookmark, a typo and a
 * repeated parameter all have to land somewhere, and the first tab is where.
 * The array case is not defensive decoration: `?tab=a&tab=b` really does arrive
 * as an array, and `String(["a","b"])` is `"a,b"`, which matches nothing.
 */
test("the device page's tab comes from the URL and always resolves", () => {
  for (const tab of DEVICE_TABS) assert.equal(deviceTab(tab.id), tab.id);

  const first = DEVICE_TABS[0].id;
  assert.equal(deviceTab(undefined), first, "no parameter is the first tab");
  assert.equal(deviceTab(""), first);
  assert.equal(deviceTab("nonsense"), first, "a stale bookmark still renders a page");
  assert.equal(deviceTab("Overview"), first, "ids are the ones in the list, not case-folded ones");
  assert.equal(deviceTab(["esim", "console"]), "esim", "a repeated parameter takes the first");
  assert.equal(deviceTab([]), first);

  assert.equal(deviceTabHref("dev-1", "diagnostics"), "/devices/dev-1?tab=diagnostics");
  // The id reaches this from a path segment, so it is encoded rather than
  // interpolated: a device id with a `?` or a `#` in it would otherwise build a
  // link to a different page.
  assert.equal(deviceTabHref("a/b?c", "overview"), "/devices/a%2Fb%3Fc?tab=overview");
});

/**
 * Deleting a device still means typing its name.
 *
 * The strongest guard in this console, and this card's only write. A device's
 * journal is every reading it ever reported and none of it comes back, so the
 * confirmation is a prompt that compares what was typed against the name
 * verbatim — not a dialog that can be dismissed by reflex. Migrating the markup
 * is not a reason for it to become one.
 *
 * The red is the other half. `.risk` is declared only as
 * `.button-row button.risk`, so this button — which *is* in a button row — was
 * one of the few places the colour actually appeared. Keeping the appearance
 * while moving to a variant that needs no ancestor is the whole point.
 */
test("deleting a device still means typing its name", () => {
  const code = codeOnly(readSource("components/device-admin.tsx"));

  assert.match(code, /window\.prompt\(/, "the prompt is gone; a device deletes on one click");
  assert.match(
    code,
    /if\s*\(\s*typed\s*!==\s*name\s*\)\s*return/,
    "what was typed is no longer compared against the name",
  );
  assert.ok(!/window\.confirm\(/.test(code), "a dialog dismissed by reflex is not the same guard");
  assert.match(code, /method:\s*"DELETE"/);

  assert.match(code, /<Button\b[^>]*variant="risk"/, "the destructive control lost its colour");
  const legacy = classListsIn(readSource("components/device-admin.tsx"));
  assert.deepEqual(legacy, [], "a class here cannot be checked against the build");
});

/* ── Every command on this page says what it will do ─────────────────────
 *
 * The device page is where every dangerous command this console can send
 * lives, and until T011 what stood in front of them was decided by *which loop
 * drew the button*: `DISRUPTIVE.map` put one shared `window.confirm` behind
 * seven commands, and everything not in that array went out unasked. That is
 * how the free-text AT box — `AT+CFUN=0` typed by hand — reached a module with
 * nothing in the way, and it is why T021's twenty-three-row survey of dangerous
 * actions did not have a row for it: there was no control to survey, only an
 * input.
 *
 * So the decision is data now (`DEVICE_COMMAND_GUARDS`, `AT_COMMAND_GUARDS`),
 * and these are the checks that keep it wired to the two components. Each one
 * has been shown red against the specific defect it claims to catch; the
 * mutations are listed in `notes/T011-device-console-esim-danger.md`.
 */

const CONSOLE_SOURCE = "components/device-console.tsx";
const ESIM_SOURCE = "components/esim-panel.tsx";

/**
 * Every `attribute={…}` expression in a file, comments already gone.
 *
 * The point is *where a name appears*, not whether it appears. A file can keep
 * its dialog, its copy and its consequence and still have somebody wire a
 * button straight to the request; every guard that reads the file as a whole
 * stays green through that. T004 was bitten by exactly this shape — an
 * assertion that matched a definition rather than a use.
 */
function handlerExpressions(source: string, attribute: string): string[] {
  const { masked, code } = scan(source);
  const out: string[] = [];
  for (const match of masked.matchAll(new RegExp(`\\b${attribute}\\s*=\\s*`, "g"))) {
    const at = match.index + match[0].length;
    if (masked[at] !== "{") continue;
    const close = closingBracket(masked, at);
    if (close === -1) continue;
    out.push(code.slice(at, close + 1));
  }
  return out;
}

/**
 * The body of `function name(…) { … }`, or of `const name = … => { … }`.
 *
 * ⚠️ The parameter list has to be stepped over rather than searched past, and
 * the first version of this did not: every component in these two files takes a
 * destructured object, so "the first `{` after the name" was
 * `{ busy, labels, onRun }` and every assertion under it was reading a
 * parameter list. It failed loudly rather than passing, which is the only
 * reason it was noticed.
 */
function bodyOfFunction(source: string, name: string): string | null {
  const { masked, code } = scan(source);
  const declared = new RegExp(`\\b(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=)`);
  const at = masked.search(declared);
  if (at === -1) return null;

  let open: number;
  if (/function/.test(masked.slice(at, at + 9 + name.length))) {
    const params = masked.indexOf("(", at);
    const afterParams = closingBracket(masked, params);
    if (afterParams === -1) return null;
    open = masked.indexOf("{", afterParams);
  } else {
    // `const x = useCallback((a, b) => { … }, [deps])`: the arrow is what
    // separates the parameters from the body, and a default value like
    // `extra = {}` is an `=` rather than an `=>`.
    const arrow = masked.indexOf("=>", at);
    if (arrow === -1) return null;
    open = masked.indexOf("{", arrow);
  }
  if (open === -1) return null;
  const close = closingBracket(masked, open);
  return close === -1 ? null : code.slice(open, close + 1);
}

/** The string literals inside `const NAME = [ … ]`. */
function stringArray(source: string, name: string): string[] {
  const { masked, literals } = scan(source);
  const at = masked.search(new RegExp(`\\bconst\\s+${name}\\s*=`));
  if (at === -1) return [];
  const open = masked.indexOf("[", at);
  if (open === -1) return [];
  const close = closingBracket(masked, open);
  return literals
    .filter((literal) => literal.start > open && literal.start < close)
    .map((literal) => literal.text);
}

/** Every command kind the two panels can put on the wire. */
function issuedKinds(): Set<string> {
  const kinds = new Set<string>();
  for (const relative of [CONSOLE_SOURCE, ESIM_SOURCE]) {
    const code = codeOnly(readSource(relative));
    for (const match of code.matchAll(/\b(?:request|onRun|runNow)\(\s*"([a-z_]+)"/g)) {
      kinds.add(match[1]);
    }
  }
  // The two loops, whose kinds are in an array rather than at the call site.
  const console_ = readSource(CONSOLE_SOURCE);
  for (const name of ["READ_ONLY", "DISRUPTIVE"]) {
    for (const kind of stringArray(console_, name)) kinds.add(kind);
  }
  return kinds;
}

test("every command either states a consequence or says why it does not", () => {
  const listed = Object.keys(DEVICE_COMMAND_GUARDS).sort();
  const issued = [...issuedKinds()].sort();

  // Derived from the source rather than from a list beside the list it is
  // checking: if the extractor stops finding call sites, everything below is
  // vacuously true.
  assert.ok(issued.length >= 15, `only ${issued.length} command kinds found; the extractor broke`);
  assert.deepEqual(
    listed,
    issued,
    "a command a panel can send has no entry in DEVICE_COMMAND_GUARDS, or an entry names one no panel sends",
  );

  const problems: string[] = [];
  for (const [kind, variants] of Object.entries(DEVICE_COMMAND_GUARDS)) {
    assert.ok(variants.length > 0, `${kind} has no variants at all`);
    // The last one is the fallback, and without it `deviceCommandGuard` would
    // fall through to its fail-closed branch for an ordinary payload.
    assert.deepEqual(
      Object.keys(variants[variants.length - 1].when),
      [],
      `${kind}'s last variant has conditions, so some payloads match nothing`,
    );
    for (const variant of variants) {
      // An unguarded command has to carry its reason. This is the half that
      // keeps the table honest: a guard in front of a harmless command trains
      // the reflex that defeats every other guard, so refusing to add one has
      // to be as visible as adding one.
      if (variant.why.trim().length < 20) problems.push(`${kind}: no reason given`);
      if (variant.consequence === null) continue;
      if (!(CONFIRM_CONSEQUENCE_KEYS as readonly string[]).includes(variant.consequence)) {
        problems.push(`${kind}: ${variant.consequence} is not on CONFIRM_CONSEQUENCE_KEYS`);
      }
    }
  }
  for (const guard of AT_COMMAND_GUARDS) {
    if (!(CONFIRM_CONSEQUENCE_KEYS as readonly string[]).includes(guard.consequence)) {
      problems.push(`${guard.id}: ${guard.consequence} is not on CONFIRM_CONSEQUENCE_KEYS`);
    }
  }
  assert.deepEqual(problems, [], "a guard points at a sentence nothing checks in both languages");
});

/**
 * The seven that shared one sentence have seven sentences.
 *
 * `device.confirmDisruptive` — "This takes the module off the network.
 * Continue?" — stood in front of all of these, and it was wrong about two of
 * them: `scan_operators` does not take the module off the network, it takes
 * the radio away for three minutes and gives it back; `rotate_ip` tears the
 * data bearer down and rebuilds it. And for `restart_modem` it was not so much
 * wrong as absent: the thing worth saying is `+CFUN: 7`.
 */
test("each disruptive command has its own consequence, and restart names +CFUN: 7", () => {
  const zh = JSON.parse(readFileSync(join(root, "messages", "zh.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf8"));

  const disruptive = stringArray(readSource(CONSOLE_SOURCE), "DISRUPTIVE");
  assert.equal(disruptive.length, 7, "the danger zone is seven commands");

  const keys = disruptive.map((kind) => {
    const guard = deviceCommandGuard(kind, { enabled: false });
    assert.ok(guard.consequence, `${kind} asks nothing before it runs`);
    return guard.consequence as string;
  });
  assert.equal(new Set(keys).size, 7, "two of the seven share a sentence again");

  // And it has to be about *this* command. A per-command key holding the same
  // paragraph seven times would pass everything above.
  for (const [language, catalogue] of [["zh", zh], ["en", en]] as const) {
    const texts = keys.map((key) => String(catalogue[key]));
    assert.equal(new Set(texts).size, 7, `${language}: seven keys, fewer than seven sentences`);
  }

  const restart = deviceCommandGuard("restart_modem", {}).consequence as string;
  for (const [language, catalogue] of [["zh", zh], ["en", en]] as const) {
    assert.match(
      String(catalogue[restart]),
      /\+CFUN: 7/,
      `${language}: the one consequence that has to name the stranded state does not`,
    );
  }
});

/**
 * The free-text AT box, which had no guard at all until this card.
 *
 * Both directions, because a table that trips on everything is the same defect
 * as a table that trips on nothing: `AT+COPS=?` is slow and reversible and is
 * deliberately absent, `AT+CRSM=176,…` is what the agent itself sends on every
 * report, and `AT+CFUN=1` is the recovery. A dialog in front of any of those
 * teaches an operator to confirm without reading, which is how the eight that
 * are here stop working.
 */
test("the AT box guards the commands that cannot be undone, and only those", () => {
  const guarded: [string, string][] = [
    ['AT+QCFG="usbnet",1', "usbnet"],
    ["at+qcfg = \"usbnet\" , 0", "usbnet"],
    ["AT+CFUN=1,1", "cfun-reset"],
    ["AT+CFUN=0,1", "cfun-reset"],
    ["AT+CFUN=0", "cfun-off"],
    ["  at+cfun=4  ", "cfun-off"],
    ["AT+CFUN=7", "cfun-off"],
    ["AT+COPS=1,2,\"46001\"", "cops-manual"],
    ["AT+COPS=2", "cops-manual"],
    ["AT+CRSM=214,28589,0,0,4", "crsm-write"],
    ["AT+CRSM=219,28421", "crsm-write"],
    ["AT+CSIM=14,\"00A4040400\"", "csim"],
    ["AT+CCHO=\"A0000005591010FFFFFFFF8900000100\"", "logical-channel"],
    ["AT+CGLA=1,10,\"80CA9F7F00\"", "logical-channel"],
    ["AT+CCHC=1", "logical-channel"],
    ["AT+QPRTPARA=1", "nvram"],
  ];
  for (const [command, id] of guarded) {
    const guard = atCommandGuard(command);
    assert.equal(guard?.id, id, `${command} trips ${guard?.id ?? "nothing"}`);
  }

  const waved: string[] = [
    "AT+CSQ",
    "AT",
    "AT+COPS?",
    // 🔴 The sweep. It was in the edge panel's table for one card and was taken
    // back out: it is slow, not irreversible — the modem returns by itself with
    // nothing to undo. Guarding it is what trains the reflex.
    "AT+COPS=?",
    // The recovery from the two guarded CFUN forms.
    "AT+CFUN=1",
    "AT+COPS=0",
    // The read the agent itself sends on every report.
    "AT+CRSM=176,28589,0,0,4",
    "AT+CRSM=192,28421",
    "AT+CGDCONT?",
    "AT+QNWINFO",
  ];
  for (const command of waved) {
    assert.equal(atCommandGuard(command), null, `${command} is guarded and should not be`);
  }

  // Every entry is reachable and distinct, so an unreachable one — shadowed by
  // a broader pattern above it — is a failing test rather than dead copy.
  const ids = AT_COMMAND_GUARDS.map((guard) => guard.id);
  assert.equal(new Set(ids).size, ids.length, "two AT guards share an id");
  const tripped = new Set(guarded.map(([, id]) => id));
  assert.deepEqual(
    ids.filter((id) => !tripped.has(id)),
    [],
    "an AT guard no sample reaches: it may be shadowed by the pattern above it",
  );
});

/**
 * The panels are wired to that table, at the point of use.
 *
 * Four claims, and every one of them has been a false green somewhere on this
 * board before:
 *
 * 1. the dispatcher really asks `deviceCommandGuard`;
 * 2. the function that performs the request is reachable from `onConfirm` and
 *    from nothing that renders — no handler, no prop;
 * 3. the AT box consults `atCommandGuard` rather than only importing it;
 * 4. `window.confirm` is gone from both files, because one string is what made
 *    seven commands share a sentence in the first place.
 */
test("both panels reach the gateway only through the guard and the dialog", () => {
  for (const relative of [CONSOLE_SOURCE, ESIM_SOURCE]) {
    const source = readSource(relative);
    const code = codeOnly(source);

    assert.ok(code.includes("<ConfirmDialog"), `${relative} renders no confirmation dialog`);
    assert.ok(
      !/window\.confirm\(/.test(code),
      `${relative} is back on window.confirm, which can only show one string`,
    );

    const dispatcher = bodyOfFunction(source, "request");
    assert.ok(dispatcher, `${relative} has no request dispatcher`);
    assert.match(
      dispatcher as string,
      /deviceCommandGuard\(/,
      `${relative}: the dispatcher no longer asks what stands in front of the command`,
    );

    // The write itself. It has to be the thing that talks to the gateway, or
    // naming it proves nothing about the request.
    const write = bodyOfFunction(source, "runNow");
    assert.ok(write, `${relative} has no runNow`);
    assert.match(write as string, /fetch\(/, `${relative}: runNow no longer performs the request`);
    assert.match(write as string, /method:\s*"POST"/, `${relative}: runNow stopped posting`);

    // And it is unreachable from anything a finger can touch.
    const handlers = [
      ...handlerExpressions(source, "onClick"),
      ...handlerExpressions(source, "onSubmit"),
      ...handlerExpressions(source, "onRun"),
    ];
    assert.ok(handlers.length > 0, `${relative}: no handlers found; this check reads nothing`);
    const direct = handlers.filter((expression) => /\brunNow\b/.test(expression));
    assert.deepEqual(
      direct,
      [],
      `${relative}: a control calls the write directly, so the dialog is decoration`,
    );

    // `device-console.tsx` exports two panels and each mounts its own dialog,
    // so this is a lower bound — but every one of them has to be wired to the
    // one function that reads the pending action and sends it.
    const confirmed = handlerExpressions(source, "onConfirm");
    assert.ok(confirmed.length > 0, `${relative}: nothing is wired to onConfirm`);
    assert.deepEqual(
      confirmed.filter((expression) => !/\bproceed\b/.test(expression)),
      [],
      `${relative}: a dialog confirms into something other than the pending action`,
    );
  }

  // The AT box, which is the whole reason this card exists.
  const atBox = bodyOfFunction(readSource(CONSOLE_SOURCE), "AtConsole");
  assert.ok(atBox, "AtConsole is gone");
  assert.match(
    atBox as string,
    /atCommandGuard\(command\)/,
    "the AT box no longer asks whether what was typed is guarded",
  );
  assert.match(
    atBox as string,
    /AT_COMMAND_GUARDS\.map/,
    "the guarded shapes are no longer drawn from the table, so a new one would be invisible",
  );
});

/**
 * The USB-net switch: a guard that only sometimes applied, twice over.
 *
 * The confirmation was conditional on the mode not being rmnet, and so was the
 * red — and the red never rendered at all, because `className="risk"` is
 * declared only as `.button-row button.risk` and `.row-actions button.risk`
 * and this button sits in an inline form. A written guard that does not render
 * is worse than none: it is on the checklist.
 */
test("the usbnet switch asks every time, and its red is a variant rather than a class", () => {
  const source = readSource(CONSOLE_SOURCE);
  const body = bodyOfFunction(source, "UsbnetControls");
  assert.ok(body, "UsbnetControls is gone");

  // Both modes are confirmed, and with different sentences: rmnet keeps the
  // QMI port and finds its own way back, and saying so is what stops the other
  // dialog reading like boilerplate.
  const rmnet = deviceCommandGuard("set_usbnet_mode", { usbnet_mode: "rmnet" });
  const other = deviceCommandGuard("set_usbnet_mode", { usbnet_mode: "ecm" });
  assert.ok(rmnet.consequence, "switching to rmnet asks nothing");
  assert.ok(other.consequence, "switching away from rmnet asks nothing");
  assert.notEqual(rmnet.consequence, other.consequence, "both modes share one sentence");

  assert.match(
    body as string,
    /<Button[^>]*variant="risk"/,
    "the submit lost the red that finally renders",
  );
  assert.ok(
    !/variant=\{[^}]*\?/.test(body as string),
    "the variant is conditional again, so the warning colour is only sometimes there",
  );
  assert.deepEqual(classListsIn(source), [], "a class here cannot be checked against the build");
});

/**
 * A switch is not done because the command said so.
 *
 * `/api/esim/switch` answers `ok` in cases where the profile did not change —
 * the vowifi board is fixing that at the edge (T080) and this card may not
 * touch it, so what it owes is a console that does not repeat the claim. The
 * timestamp comparison is the whole mechanism: the reading that was already on
 * screen when the button was pressed says nothing about the switch.
 */
test("the eSIM switch is reported from a read taken after it, never from ok", () => {
  const switched = {
    kind: "switch_esim_profile",
    status: "succeeded",
    completed_at: 1000,
    payload: { modem_imei: "869123456789012", target_iccid: "8986041234567890123" },
  };
  const profile = (state: string, collectedAt: number) => ({
    iccid: "8986041234567890123",
    state,
    collectedAt,
  });

  assert.equal(esimSwitchVerdict([], []), null, "nothing switched is not the same as fine");

  // A command that only *reported* success, with no read after it.
  assert.equal(esimSwitchVerdict([switched], [])?.state, "unverified");

  // 🔴 A reading collected *before* the switch is the one that was already on
  // screen, and it proves nothing. This is the case a naive "is it enabled
  // now" would get wrong, and it is the only interesting one.
  assert.equal(
    esimSwitchVerdict([switched], [profile("enabled", 999)])?.state,
    "unverified",
    "a reading older than the switch is being used as evidence for it",
  );

  const confirmed = esimSwitchVerdict([switched], [profile("enabled", 1001)]);
  assert.equal(confirmed?.state, "confirmed");
  assert.equal(confirmed?.readAt, 1001);
  assert.equal(confirmed?.targetIccid, "8986041234567890123");

  const contradicted = esimSwitchVerdict([switched], [profile("disabled", 1001)]);
  assert.equal(contradicted?.state, "contradicted");
  assert.equal(contradicted?.observed, "disabled");

  // The newest read wins, in both directions.
  assert.equal(
    esimSwitchVerdict([switched], [profile("enabled", 1001), profile("disabled", 1002)])?.state,
    "contradicted",
  );
  // A failed switch is not a switch.
  assert.equal(
    esimSwitchVerdict([{ ...switched, status: "failed" }], [profile("enabled", 1001)]),
    null,
  );
  // Another profile's row says nothing about this one.
  assert.equal(
    esimSwitchVerdict([switched], [{ ...profile("enabled", 1001), iccid: "8986049999999999999" }])
      ?.state,
    "unverified",
  );

  // And the panel draws it, at the point of use.
  const code = codeOnly(readSource(ESIM_SOURCE));
  assert.match(code, /esimSwitchVerdict\(commands,/, "the panel no longer computes the verdict");
  assert.match(code, /<SwitchVerdict\b/, "the verdict is computed and not shown");
});

/**
 * The guards that were already right are still right.
 *
 * T021 §2 listed which of the twenty-three writes on this page already had
 * something in front of them, and a migration is exactly the kind of change
 * that quietly loses one. Checked against the table rather than against the
 * markup, so the answer does not depend on how a button is drawn.
 */
test("nothing that was guarded before this card is unguarded after it", () => {
  const stillGuarded: [string, Record<string, unknown>][] = [
    ["restart_modem", {}],
    ["reset_modem_usb", {}],
    ["scan_operators", {}],
    ["rotate_ip", {}],
    ["set_radio", { enabled: false }],
    ["set_data_network", { enabled: false }],
    ["reregister_network", {}],
    ["set_usbnet_mode", { usbnet_mode: "ecm" }],
    ["switch_esim_profile", {}],
    ["download_esim_profile", {}],
    // The four T030 found with nothing in front of them at all.
    ["select_operator", { mode: "manual" }],
    ["send_ussd", { stage: "start" }],
    ["send_ussd", { stage: "continue" }],
    ["run_at_command", { command: "AT+CFUN=0" }],
  ];
  for (const [kind, payload] of stillGuarded) {
    assert.ok(
      deviceCommandGuard(kind, payload).consequence,
      `${kind} ${JSON.stringify(payload)} now runs without asking`,
    );
  }

  // And the deliberate exceptions stay exceptions, with their reasons on file.
  const stillOpen: [string, Record<string, unknown>][] = [
    ["modem_report", {}],
    ["list_esim_profiles", {}],
    ["read_esim_info", {}],
    ["refresh_modems", {}],
    ["set_radio", { enabled: true }],
    ["set_data_network", { enabled: true }],
    ["select_operator", { mode: "automatic" }],
    ["send_ussd", { stage: "cancel" }],
    ["run_at_command", { command: "AT+CSQ" }],
  ];
  for (const [kind, payload] of stillOpen) {
    const guard = deviceCommandGuard(kind, payload);
    assert.equal(
      guard.consequence,
      null,
      `${kind} ${JSON.stringify(payload)} now asks, and a question in front of a safe command ` +
        "teaches the reflex that defeats the others",
    );
    assert.ok(guard.why.length > 20, `${kind} is unguarded with no reason on file`);
  }

  // Fail closed. A kind nobody wrote an entry for is the failure the whole
  // table exists to stop, and it must not be the one that goes straight out.
  assert.ok(
    deviceCommandGuard("a_command_nobody_listed", {}).consequence,
    "an unlisted command sends without asking",
  );
});

/**
 * The danger zone is drawn with properties this build actually sets.
 *
 * 🔴 A red border was the obvious answer and it would not have rendered:
 * `CARD.root` asks for a border width and computes to `none 0px` here, which
 * is the whole of `BORDER_WIDTH_WITHOUT_A_STYLE`. Shipping markup that reviews
 * as a warning and paints nothing is the exact defect this card was sent to fix
 * on the USB-net button, so the check is that the zone uses no border at all
 * and that what it does use generates CSS.
 */
test("the danger zone says so without a border, and the buttons in it are red", async () => {
  const classes = [CARD.dangerHeader, CARD.dangerTitle, LOG.entry]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
  const generated = await generatedClasses([...classes, "p-s4"]);
  assert.deepEqual(
    classes.filter((name) => !generated.has(name)),
    [],
    "the danger zone or the log entry asks for a class the build does not produce",
  );
  assert.ok(
    !classes.some((name) => /^-?border(-|$)/.test(name)),
    "a border here computes to 0px on this build: BORDER_WIDTH_WITHOUT_A_STYLE",
  );

  const zone = bodyOfFunction(readSource(CONSOLE_SOURCE), "DangerZone");
  assert.ok(zone, "the danger zone is gone");
  assert.match(zone as string, /CARD\.dangerHeader/, "the zone no longer reads as one");
  assert.match(zone as string, /DISRUPTIVE\.map/, "the seven are drawn from somewhere else now");
  assert.match(
    zone as string,
    /variant="risk"/,
    "the seven lost the colour that says which half of this card they are in",
  );
  // The way back is in the same card and is not one of them. It used to be two
  // plain buttons *inside* the row of seven, which is the arrangement that made
  // a dangerous action and its undo look like eight peers.
  assert.match(zone as string, /variant="ghost"/, "the recovery buttons look dangerous again");

  // And the page puts the device's removal in the same zone rather than under
  // the first table an operator sees.
  const page = codeOnly(readSource(DEVICE_PAGE));
  assert.match(page, /CARD\.dangerHeader/, "removing a device is outside the danger zone again");
  assert.match(page, /<DeviceAdmin\b/, "the admin controls are not rendered at all");
});

/**
 * Two status vocabularies, two tables.
 *
 * `failed` is a device state and also a command status, and `pending` is
 * neither — one map answering both questions is how a device that has never
 * checked in ends up wearing the colour of a command that timed out.
 */
test("a command status and a profile state get their own colours", () => {
  assert.equal(toneForCommandStatus("succeeded"), "ok");
  assert.equal(toneForCommandStatus("failed"), "bad");
  assert.equal(toneForCommandStatus("expired"), "bad");
  assert.equal(toneForCommandStatus("pending"), "warn");
  assert.equal(toneForCommandStatus("SUCCEEDED"), "ok", "the gateway's casing is not a colour");
  // Whatever a newer console or a newer edge recorded. Guessing a colour for a
  // word this build does not know is worse than not colouring it.
  assert.equal(toneForCommandStatus("quarantined"), "neutral");

  assert.equal(toneForProfileState("enabled"), "ok");
  assert.equal(toneForProfileState("deleted"), "bad");
  assert.equal(toneForProfileState("disabled"), "neutral", "inventory is not news");
  assert.equal(toneForProfileState("whatever"), "neutral");

  // The two are genuinely different, or there was no reason for two.
  assert.notEqual(toneForCommandStatus("failed"), toneForProfileState("failed"));
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
