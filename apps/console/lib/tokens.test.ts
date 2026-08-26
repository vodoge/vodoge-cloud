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

/* ── Reading app/globals.css ─────────────────────────────────── */

/**
 * Every rule in the stylesheet, as a selector head and a declaration body.
 *
 * This used to read `@layer legacy` alone, because that was the part that
 * needed watching and the rest was tokens. The layer is gone and the reading
 * widened to the whole file, which is strictly stronger: a hand-written rule
 * that comes back is now found wherever in the file somebody puts it.
 */
function rulesOf(css: string): { head: string; body: string }[] {
  const rules: { head: string; body: string }[] = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ head: match[1], body: match[2] });
  }
  return rules;
}

/** Every class name a sheet defines. */
function classNamesOf(css: string): Set<string> {
  const names = new Set<string>();
  for (const { head } of rulesOf(css)) {
    if (head.includes("@")) continue;
    for (const match of head.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(match[1]);
  }
  return names;
}

/** Every element a sheet styles by name, and the properties it sets on it. */
function elementRulesOf(css: string): Map<string, Set<string>> {
  const byElement = new Map<string, Set<string>>();
  for (const { head, body } of rulesOf(css)) {
    if (head.includes("@")) continue;
    for (const selector of head.split(",")) {
      const trimmed = selector.trim();
      if (!trimmed || /[.#[]/.test(trimmed)) continue;
      for (const part of trimmed.split(/[\s>+~]+/)) {
        const name = /^([a-z][a-z0-9]*)/.exec(part)?.[1];
        if (!name) continue;
        const properties = byElement.get(name) ?? new Set<string>();
        for (const one of body.split(";")) {
          const colon = one.indexOf(":");
          if (colon !== -1) properties.add(one.slice(0, colon).trim());
        }
        byElement.set(name, properties);
      }
    }
  }
  return byElement;
}

/**
 * The three above, pointed at `app/globals.css`.
 *
 * Thin on purpose. Each check below asserts that the real sheet gives the
 * empty answer and that a probe sheet does not, and the two claims are only
 * worth anything together if they go through the same code: a mutation that
 * broke a duplicated extractor left the probe green and the answer empty.
 */
function stylesheetRules(): { head: string; body: string }[] {
  return rulesOf(globalsCss);
}

/**
 * Every class name the stylesheet defines.
 *
 * **Empty.** `app/globals.css` is tokens, a reset and two `@tailwind`
 * directives; every class in this console comes from the Tailwind build. The
 * function is kept rather than deleted because three checks below are
 * comparisons against what it returns, and a comparison against a deleted
 * function is a check that stops running.
 */
function stylesheetClassNames(): Set<string> {
  return classNamesOf(globalsCss);
}

/**
 * Every element the stylesheet styles by *name*, and the properties it sets.
 *
 * A rule that selects by element name reaches every element of that name
 * whatever classes it carries, so no class-based check can see it and a
 * cascade layer does not hold it back — a layer only settles the properties
 * two rules both declare. That is the shape that made deleting the old
 * stylesheet a change rather than a no-op: `button, input, select, textarea`
 * had `font: inherit` by element name, nothing in any recipe replaced it, and
 * a grep for the old class names could not have found it.
 *
 * A reset is allowed to do this and is the only thing that is; the test below
 * pins exactly which elements and exactly which properties.
 */
function stylesheetElementRules(): Map<string, Set<string>> {
  return elementRulesOf(globalsCss);
}

/**
 * A sample sheet the extractors above have to find things in.
 *
 * Every assertion in this file about `stylesheetClassNames` and
 * `stylesheetElementRules` is now an assertion that they return *nothing*,
 * and an extractor that has quietly stopped working returns nothing too. So
 * each of those tests runs the same extractor over this, where the answer is
 * known and is not empty.
 */
const PROBE_SHEET = [
  "@layer legacy {",
  ".card { border: 1px solid red; }",
  ".button-row button.risk { color: red; }",
  ".card-span-all { grid-column: 1 / -1; }",
  "th, td { padding: 4px; border-bottom: 1px solid red; }",
  "}",
].join("\n");


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

/* ── Contrast: the ink against the accent it is painted on ──────────── */

/**
 * WCAG 2.x relative luminance and contrast ratio.
 *
 * Implemented here and not in `lib/tokens.ts` on purpose. That file is
 * Tailwind `content`, and `accent-*` is a live utility family here rather
 * than a hypothetical one: `FORM.checkbox` really does use `accent-accent`,
 * so `.accent-accent` is in the shipped stylesheet and the generator that put
 * it there reads every string in the file, comments included. A contrast
 * table written next to the tokens would hand that generator a page of
 * colour names to mine. This file is the one `tailwind.config.ts`
 * deliberately excludes from `content`, which is what makes it the safe place
 * to name these colours in prose.
 */
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
 * The negative control for the two tests under it.
 *
 * Without this, a `contrastRatio` that returned a large constant would
 * satisfy every threshold below and the assertions would be decorative. All
 * three of these are fixed by the specification rather than by taste: black
 * on white is exactly 21, any colour on itself is exactly 1, and `#777777`
 * on white is the published 4.478 that sits just above the body-text line.
 */
test("the contrast helper reproduces ratios the specification fixes", () => {
  assert.equal(Number(contrastRatio("#000000", "#ffffff").toFixed(3)), 21);
  assert.equal(Number(contrastRatio("#10b47a", "#10b47a").toFixed(3)), 1);
  assert.equal(Number(contrastRatio("#777777", "#ffffff").toFixed(3)), 4.478);
});

/**
 * `--accent-ink` is the only colour this design paints *on top of* the
 * accent, and it is painted on two different accents, not one.
 * `BUTTON.variant.primary` is `bg-accent` at rest and `bg-accent-strong` on
 * hover while the ink stays where it is, and `SHELL.brandMark` runs a
 * gradient between the same two. `--accent-strong` is the darker of the pair
 * in both themes, so it is the binding case — and it is the one that a check
 * of the rest state alone silently misses.
 *
 * 🔴 The light theme failed this until this card. The ink was `#ffffff`:
 * 2.681 on `--accent` and 3.596 on `--accent-strong`, so the rest state did
 * not reach even the 3:1 floor that large text gets, and the hover state did
 * not reach 4.5 either. The button's label is `text-sm`/`font-semibold`,
 * which is body text, so 4.5 is the bar for both. The fix was the ink and not
 * the accent: `#10b47a` is the brand green and stays.
 *
 * ⚠️ The direction that repairs this inverts once the ink is dark, and it is
 * the thing to get right before editing these two values again. While the ink
 * was white, a *darker* fill helped. Now that the ink is `#06251a`, contrast
 * falls monotonically as the fill darkens: `--accent` itself is 6.084, the
 * old `--accent-strong` `#0d9a68` was 4.536, and two points darker again is
 * 3.976. So the hover fill was moved *up* to `#0fa36f` (5.041) rather than
 * down. It is still darker than `--accent` — hover still reads as hover, the
 * two fills being 1.207:1 apart — but the margin over 4.5 is now half a point
 * instead of 0.036.
 *
 * That is also why this test reads the real pair out of `COLOR_TOKENS` rather
 * than restating numbers: the failure mode is somebody darkening the hover
 * fill for contrast, which is precisely backwards, and this goes red when
 * they do.
 */
const ACCENT_BACKGROUNDS = ["accent", "accent-strong"] as const;

test("--accent-ink clears 4.5:1 on every accent it is painted on, in both themes", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const failures: string[] = [];

  for (const theme of ["dark", "light"] as const) {
    const ink = colours["accent-ink"][theme];
    for (const name of ACCENT_BACKGROUNDS) {
      const background = colours[name][theme];
      const ratio = contrastRatio(ink, background);
      if (ratio < 4.5) {
        failures.push(`${theme}: ${ink} on --${name} ${background} = ${ratio.toFixed(3)}:1`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

/**
 * The two accent ratios, pinned to the digit, so that a later edit to
 * `--accent`, `--accent-strong` or either ink cannot move them at all without
 * saying so here rather than drifting quietly toward the threshold above.
 *
 * 🔴 **These were 9.49 and 7.2 until T001 took the hue out of the accent.**
 * That card is the one T052 warned was coming: the numbers below are its
 * measurements and not a relaxation, and both went *up*, because a neutral
 * accent is `--fg` inked with `--bg` and that pairing is the widest this
 * palette has. The light theme is pinned alongside them now, which it was not
 * before — it could not be while the light accent was a green with its own
 * ink, and there is no reason to leave half the table unguarded once both
 * themes are built the same way.
 */
test("the accent contrast in both themes is exactly what T001 set", () => {
  const colours = TOKENS.COLOR_TOKENS;
  const at = (theme: "dark" | "light", fill: "accent" | "accent-strong") =>
    Number(contrastRatio(colours["accent-ink"][theme], colours[fill][theme]).toFixed(2));

  assert.deepEqual(
    {
      "dark ink on accent": at("dark", "accent"),
      "dark ink on accent-strong": at("dark", "accent-strong"),
      "light ink on accent": at("light", "accent"),
      "light ink on accent-strong": at("light", "accent-strong"),
    },
    {
      "dark ink on accent": 19.14,
      "dark ink on accent-strong": 13.94,
      "light ink on accent": 19.17,
      "light ink on accent-strong": 13.97,
    },
  );
});

/* ── Contrast: the green that is read rather than filled ────────────── */

/**
 * The second green, and why the console needs two.
 *
 * T046 swept the whole lightness axis of the brand hue and found that **no
 * single green satisfies both roles in the light theme**. A green light enough
 * to carry the button's dark ink (`#06251a`) is too light to be read on white;
 * a green dark enough to be read on white cannot carry that ink. `#10b47a` is
 * 6.084 under the ink and 2.681 as text; `#0b7c54` is 5.217 as text and 3.127
 * under the ink. There is no crossing point. So the fill role keeps the brand
 * green and the text role gets its own token.
 *
 * 🔴 The name carries the distinction, and it is `--fg-accent` rather than
 * `--accent-text` for two reasons that are not taste:
 *
 * ① **The prefix is the role.** `--fg`, `--fg-muted`, `--fg-faint` are already
 *    this file's text tiers, so a fourth `--fg-*` entry is text by
 *    construction, and everything under `--accent-*` is a fill, a border or a
 *    tint. `--accent-text` would instead have sat one letter from
 *    `--accent-ink` in meaning-space — ink is what you paint *on* the accent,
 *    text is the accent *as* type — and `text-accent-text` stutters where
 *    `text-fg-accent` reads like `text-fg-muted`.
 *
 * ② **`accent-fg` would have shipped a dead rule.** `accent-<colour>` is a
 *    live utility family here (`FORM.checkbox` really uses `accent-accent`),
 *    and `fg` is a real colour key, so the bare string `accent-fg` in a
 *    `content` file is a *valid* candidate and Tailwind would have emitted
 *    `.accent-fg { accent-color: var(--fg) }` into the shipped stylesheet from
 *    the token's own key. `fg-accent` matches no utility family, so it cannot.
 *    Verified against the built sheet, not reasoned about: the class-name set
 *    is byte-identical before and after this card apart from `text-fg-accent`.
 *
 * `--ok` moved instead of gaining a sibling, because `--ok` is only ever
 * *read*: its two uses are both `text-ok`, and what sits behind it is the
 * separate `--ok-wash`. Giving it an `--ok-fg` would have left `--ok` with no
 * consumers at all.
 */
const GREEN_TEXT: RegExp = /(?:^|\s)(?:[a-z-]+:)*text-([a-z0-9-]+)/g;
/** A recipe that paints an opaque accent fill: its text is ink, tested above. */
const ACCENT_FILL: RegExp = /(?:^|\s)(?:[a-z-]+:)*(?:bg|from|to|via)-accent(?:-strong)?(?:\s|$)/;

function hueAndSaturation(hex: string): [number, number] {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return [0, 0];
  const lightness = (max + min) / 2;
  const s = lightness > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s];
}

function isGreen(hex: string): boolean {
  const [h, s] = hueAndSaturation(hex);
  return h >= 90 && h <= 200 && s >= 0.3;
}

/** Composite a translucent wash over an opaque backdrop, as a browser does. */
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

const OPAQUE_SURFACES = ["bg", "surface", "surface-raised", "surface-hover"] as const;
const WASHES = ["accent-wash", "ok-wash"] as const;

/**
 * Every backdrop a green word can end up on — deliberately a superset of the
 * sites that exist today, so a page built next month is covered without anyone
 * remembering to come back here.
 *
 * The stacked entries are not hypothetical. `components/conversation.tsx:377`
 * puts a `bg-ok-wash` delivery badge inside `INBOX.messageOut`, which is
 * `bg-accent-wash` — a green pill on a green bubble on a surface, and the
 * darkest backdrop any green word actually lands on. A green badge on a
 * *hovered* table row (`TABLE.row` is `hover:bg-surface-hover`) is the other
 * one, and both are darker than the plain white that a naive check would use.
 */
function everyBackdrop(
  colours: Record<string, { readonly dark: string; readonly light: string }>,
  theme: "dark" | "light",
  washes: readonly string[] = WASHES,
): { name: string; hex: string }[] {
  const opaque = OPAQUE_SURFACES.map((s) => ({ name: `--${s}`, hex: colours[s][theme] }));
  const washed = opaque.flatMap((base) =>
    washes.map((w) => ({ name: `--${w} over ${base.name}`, hex: over(colours[w][theme], base.hex) })),
  );
  const twice = washed.flatMap((base) =>
    washes.map((w) => ({ name: `--${w} over ${base.name}`, hex: over(colours[w][theme], base.hex) })),
  );
  return [...opaque, ...washed, ...twice];
}

/**
 * Which wash a colour's own recipes paint behind it, read out of the recipes.
 *
 * 🔴 **T049's two washes are the two a green sits on, and only those.** A warn
 * word does not land on a green tint: the tone that carries it is
 * `bg-warn-wash` with `text-warn` in the same string. Sweeping the other three
 * status colours over the green set measured them somewhere they never appear
 * — which is the same shape of mistake T049 caught T046 making about the wash
 * over white, one level further in, and it read *optimistically*: 2.47 / 3.30 /
 * 3.68 on the green set against 2.34 / 3.06 / 3.43 where they really sit.
 *
 * Derived rather than listed so a fifth tone is swept without anyone coming
 * back here, and unioned with T049's pair rather than replacing it, so the set
 * is a superset in every case and for the two greens it is byte-identical to
 * what T049 swept. Their 28 backdrops and their pinned dark 5.022 do not move.
 */
const WASH_AND_TEXT: RegExp = /(?:^|\s)(?:[a-z-]+:)*bg-([a-z0-9-]+)-wash(?=\s|$)/;

function washesForTextToken(token: string): string[] {
  const found = new Set<string>(WASHES);
  for (const recipe of everyRecipeString(TOKENS)) {
    const wash = WASH_AND_TEXT.exec(recipe);
    if (!wash) continue;
    const painted = [...recipe.matchAll(GREEN_TEXT)].map((m) => m[1]);
    if (painted.includes(token)) found.add(`${wash[1]}-wash`);
  }
  return [...found].sort();
}

/**
 * Which tokens are greens painted as text on a surface — derived from the
 * recipes rather than listed, so adding a third one puts it under the sweep
 * below instead of quietly outside it.
 *
 * A recipe that also paints an opaque accent fill is excluded: its text is
 * `--accent-ink`, which is painted on the accent and not on a surface, and
 * that pair is the test further up.
 */
function greensPaintedAsTextOnASurface(): string[] {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const found = new Set<string>();
  for (const recipe of everyRecipeString(TOKENS)) {
    if (ACCENT_FILL.test(recipe)) continue;
    for (const match of recipe.matchAll(GREEN_TEXT)) {
      const token = colours[match[1]];
      if (token && isGreen(token.dark) && isGreen(token.light)) found.add(match[1]);
    }
  }
  return [...found].sort();
}

/**
 * 🔴 **This was `["fg-accent", "ok"]` and T001 made it one.**
 *
 * Nothing was removed from the sweep. `--fg-accent` fell out of the *derived*
 * set because it stopped being green: the accent is `--fg` in both themes now,
 * so `isGreen` rejects it and the only green still painted as type is the
 * status one. Pinning the derived list is what makes that visible rather than
 * silent — a green quietly dropping out of the sweep below is exactly the
 * shape of the miss that put `--fg-faint` on the site at 3.200, and it fails
 * here instead.
 *
 * The sweep still covers `--fg-accent` at full strength: it is a neutral now,
 * so the every-text-tier-on-every-surface sweep is what governs it, and its
 * own worst backdrop is pinned two tests down.
 */
test("the green painted as text on a surface is the one T001 left with a hue", () => {
  assert.deepEqual(greensPaintedAsTextOnASurface(), ["ok"]);
  // The set is derived, so it can only shrink by a token ceasing to be green.
  // Both halves of that are stated, or a token disappearing from COLOR_TOKENS
  // would read the same as a token going neutral.
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  assert.ok(colours["fg-accent"], "--fg-accent is gone, not neutral");
  assert.equal(isGreen(colours["fg-accent"].dark), false);
  assert.equal(isGreen(colours["fg-accent"].light), false);
});

/**
 * 🔴 The bar this card exists to clear. Before it, all four sites failed:
 * `SHELL.navLinkCurrent` and `BADGE.tone.ok` at 2.440, `PAGE.link`,
 * `TABLE.cellLink` and `STAT.tone.ok` at 2.681 — and worse than the card
 * recorded, because a badge on a hovered row is 2.212 and one inside an
 * outbound bubble is 2.230.
 *
 * ⚠️ `#0b7c54`, the value T046 proposed, does **not** pass this: 4.304 on
 * `--ok-wash` over `--surface-hover` and 4.339 on the stacked bubble. T046's
 * table only ever composited a wash over white. `#0a704c` is the lightest
 * green on the brand's exact hue (158.78°) and saturation (83.7%) whose worst
 * backdrop clears 4.5 by the same half-point margin T046 itself insisted on
 * when it moved `--accent-strong` up rather than down.
 */
test("every green painted as text clears 4.5:1 on every backdrop, in both themes", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const failures: string[] = [];

  for (const token of greensPaintedAsTextOnASurface()) {
    for (const theme of ["dark", "light"] as const) {
      for (const backdrop of everyBackdrop(colours, theme)) {
        const ratio = contrastRatio(colours[token][theme], backdrop.hex);
        if (ratio < 4.5) {
          failures.push(
            `${theme}: --${token} ${colours[token][theme]} on ${backdrop.name} ` +
              `${backdrop.hex} = ${ratio.toFixed(3)}:1`,
          );
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

/**
 * The two roles must not be able to trade places, which is the failure this
 * card's naming is trying to prevent and the one a name alone cannot stop.
 *
 * Painting `--accent` as text is the defect being repaired, and painting
 * `--fg-accent` as a fill is its mirror image: at `#0a704c` the button's
 * `--accent-ink` would sit on it at 2.668, which is worse than what was there
 * before. Neither can be expressed in a recipe after this test.
 */
test("the fill green is never text and the text green is never a fill", () => {
  const offenders = everyRecipeString(TOKENS).filter(
    (recipe) =>
      /(?:^|\s)(?:[a-z-]+:)*text-accent(?:-strong)?(?:\s|$)/.test(recipe) ||
      /(?:^|\s)(?:[a-z-]+:)*(?:bg|border|ring|from|to|via|outline|divide|shadow|accent)-fg-accent(?:\s|$)/.test(
        recipe,
      ),
  );
  assert.deepEqual(offenders, []);
});

/**
 * The same two tokens, pinned to the digit across the same superset of
 * backdrops, so that a later edit to either of them or to a wash fails here
 * rather than drifting toward the threshold.
 *
 * 🔴 **Both dark figures were 5.022 before T001, and the identity that made
 * them one number is gone.** `--fg-accent` and `--ok` were both `#4ade9b`
 * then. Now `--fg-accent` follows the accent to `--fg` and `--ok` keeps the
 * hue, so they are two different colours with two different worst backdrops
 * and each gets its own number. What replaces the old shared identity is
 * stated rather than dropped: `--fg-accent` is still exactly `--accent`, and
 * `--ok` is pinned as a hex to say the status green did not move at all.
 *
 * `--ok` went 5.022 -> 5.361 because its worst backdrop is its own wash over a
 * hovered row and that row got darker, not because anything green changed.
 */
test("the dark theme's green-on-surface contrast is exactly what T001 set", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  // The readable accent is the accent, which is the text colour.
  assert.equal(colours["fg-accent"].dark, colours.accent.dark);
  assert.equal(colours["fg-accent"].dark, colours.fg.dark);
  // The status green is untouched by this card, stated as the hex because a
  // ratio can be held still by two compensating edits.
  assert.equal(colours.ok.dark, "#4ade9b");

  const worst = (token: string) =>
    Number(
      Math.min(
        ...everyBackdrop(colours, "dark").map((b) => contrastRatio(colours[token].dark, b.hex)),
      ).toFixed(3),
    );
  assert.deepEqual({ "fg-accent": worst("fg-accent"), ok: worst("ok") }, {
    "fg-accent": 8.455,
    ok: 5.361,
  });
});

/* ── Contrast: the other three status colours ────────────────────────── */

/**
 * The same defect in `--warn`, `--bad` and `--info`, and the decision T049
 * left for this card: each needed its own value on its own hue, which is a
 * choice rather than arithmetic.
 *
 * Each is now **the lightest value on its own exact hue and saturation whose
 * worst backdrop clears 4.5 by half a point** — T046's own margin rule, the
 * one it applied when it refused to ship a fill at a margin of 0.036, and the
 * rule T049 chose the second green by. Light theme only; the dark values are
 * untouched and the test below pins them.
 *
 * | | on the green set T049 swept | where it really sits | now |
 * |---|---|---|---|
 * | `--warn` | 2.47 | **2.341** | **5.012** |
 * | `--bad`  | 3.30 | **3.060** | **5.008** |
 * | `--info` | 3.68 | **3.429** | **5.048** |
 *
 * 🔴 The middle column is the reason this test is not simply the old one with
 * three numbers edited. T049 measured these over the two washes a *green* sits
 * on, and every one of the three was worse than that said. The washes
 * themselves did not move — they are literal `rgba()` and do not follow the
 * colour, exactly as `--accent-wash` did not follow the green — so the pale
 * pills behind these words look the same and only the words darkened.
 */
const STATUS_TEXT_TOKENS = ["warn", "bad", "info"] as const;

test("every status colour painted as text clears 4.5:1 on every backdrop it has, in light", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const failures: string[] = [];

  for (const token of STATUS_TEXT_TOKENS) {
    const washes = washesForTextToken(token);
    assert.ok(
      washes.includes(`${token}-wash`),
      `--${token}'s own wash is not in its backdrop set, so this is measuring the wrong place`,
    );
    for (const backdrop of everyBackdrop(colours, "light", washes)) {
      const ratio = contrastRatio(colours[token].light, backdrop.hex);
      if (ratio < 4.5) {
        failures.push(
          `light: --${token} ${colours[token].light} on ${backdrop.name} ` +
            `${backdrop.hex} = ${ratio.toFixed(3)}:1`,
        );
      }
    }
  }

  assert.deepEqual(failures, []);
});

/**
 * 🔴 **What T001 kept, and the shape of what it replaced.**
 *
 * This test used to say "this card moved no colour the dark theme already
 * had", pinning seven dark hexes so T049 could prove it repaired the light
 * theme for free. T001 is the card that *does* move them, so that claim is
 * spent and restating it would be a lie. What is worth guarding survives in a
 * stronger form:
 *
 * ① **The four status colours did not move, in either theme's dark column.**
 *    They are the only hue left in the console after this card, which makes
 *    them more load-bearing than they were, not less. Stated as hexes because
 *    a ratio can be held still by two compensating edits.
 *
 * ② **The neutral accent is four identities, not four coincidences.** A green
 *    accent needed `--fg-accent` and `--accent-edge` to be separate values in
 *    the light theme; a neutral one does not, and the risk swaps round — the
 *    next editor gives one of them a hue of its own and the console quietly
 *    grows a brand colour back. Written as equalities so that landing a hue on
 *    any of the four fails here, whatever the hue is.
 */
test("T001 kept the status four and made the accent four identities", () => {
  const colours = TOKENS.COLOR_TOKENS;

  assert.deepEqual(
    {
      ok: colours.ok.dark,
      warn: colours.warn.dark,
      bad: colours.bad.dark,
      info: colours.info.dark,
      "bad-ink": colours["bad-ink"].dark,
    },
    {
      ok: "#4ade9b",
      warn: "#f0b429",
      bad: "#f2686d",
      info: "#63a4ff",
      "bad-ink": "#52070a",
    },
  );

  for (const theme of ["dark", "light"] as const) {
    assert.equal(colours.accent[theme], colours.fg[theme], `${theme}: --accent is not --fg`);
    assert.equal(colours["fg-accent"][theme], colours.accent[theme], `${theme}: --fg-accent`);
    assert.equal(colours["accent-edge"][theme], colours.accent[theme], `${theme}: --accent-edge`);
    assert.equal(colours["accent-ink"][theme], colours.bg[theme], `${theme}: --accent-ink`);
    // A neutral has no hue to have, so this is the whole of "no brand colour".
    assert.equal(
      hueAndSaturation(colours.accent[theme])[1],
      0,
      `${theme}: the accent has grown a hue back`,
    );
  }
});

/**
 * 🔴 **Measured, not fixed, and the next card's baseline.**
 *
 * The dark theme has the same defect in two of the three, and it is out of
 * this card's scope for the reason T049 gave about the light theme: repairing
 * it means moving a dark value, and every dark value moving is a change to the
 * theme this console is looked at in for hours. The site is real and not a
 * superset artefact — `components/conversation.tsx` renders the delivery badge
 * with the tone `toneForDeliveryStatus` returns, so a failed send is a red
 * badge inside `INBOX.messageOut`, which is a green tint. `--warn` clears the
 * bar; `--bad` and `--info` do not.
 *
 * Pinned to the digit so the numbers cannot drift and so whoever fixes them
 * starts from a measurement rather than re-deriving one. If you are that card,
 * these three numbers are what you are moving — update them here.
 *
 * 🔴 **T010: read this before re-deriving anything.** These numbers are far
 * below what a sweep of the four surfaces produces, and the difference is the
 * backdrop set, not the arithmetic. `washesForTextToken` unions a token's own
 * wash with `WASHES`, which is `--accent-wash` and `--ok-wash`, and
 * `everyBackdrop` then stacks them **twice**. So the backdrop that binds
 * `--bad` is not a red pill on a surface — it is `--ok-wash` over `--ok-wash`
 * over `--surface-hover`, hex **#284f3e**, a red delivery badge inside a green
 * outbound bubble on a hovered row. That site is real:
 * `components/conversation.tsx` renders the badge with the tone
 * `toneForDeliveryStatus` returns, so a failed send puts red on green. A sweep
 * that only composites a colour over its own wash measures somewhere the
 * colour never is and reads optimistically — the exact mistake T049 caught
 * T046 making, one level further in.
 *
 * T001 moved all three *up* without touching a dark status value, purely
 * because the surfaces under those washes got darker: warn 4.632 -> 4.945,
 * bad 2.869 -> 3.062, info 3.407 -> 3.637.
 */
test("the dark theme's status contrast is recorded where it stands", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const worst = (token: string) =>
    Number(
      Math.min(
        ...everyBackdrop(colours, "dark", washesForTextToken(token)).map((b) =>
          contrastRatio(colours[token].dark, b.hex),
        ),
      ).toFixed(3),
    );
  assert.deepEqual({ warn: worst("warn"), bad: worst("bad"), info: worst("info") }, {
    warn: 4.945,
    bad: 3.062,
    info: 3.637,
  });
  // The backdrop these are measured on, named so the next card cannot re-derive
  // them against an easier one and think it found an improvement.
  const binding = everyBackdrop(colours, "dark", washesForTextToken("bad")).reduce((a, b) =>
    contrastRatio(colours.bad.dark, a.hex) <= contrastRatio(colours.bad.dark, b.hex) ? a : b,
  );
  assert.equal(binding.hex, "#284f3e");
  assert.equal(binding.name, "--ok-wash over --ok-wash over --surface-hover");
});

/* ── Contrast: the accent when it is a line ──────────────────────────── */

/**
 * The third green, and the third bar.
 *
 * 🔴 **The focus ring was the accent fill, and it was the one thing on a light
 * page not required to be visible.** `:focus-visible` draws
 * `2px solid` in `app/globals.css`, and the fill green is **2.681** on a card
 * and **2.523** on the page against the **3:1** WCAG 1.4.11 sets for a non-text
 * indicator — the same wall `ring-*`, `TABS.tabCurrent`'s rule and an input's
 * focused edge were standing at.
 *
 * ⚠️ **Not the readable green.** T049's guard below forbids painting
 * `--fg-accent` as a fill, a border or a ring, and that guard is right: this is
 * the *fill* green's role, an outline carries no ink, and reaching for a text
 * tier because its number happens to be big enough is how a role gets
 * borrowed and then forgotten. A third entry with its own bar is the honest
 * answer, chosen the way T049 chose the second: the lightest value on the
 * brand's exact hue and saturation clearing 3:1 by half a point.
 *
 * Light 2.035 -> **3.527** on the worst backdrop, 2.414-2.681 -> 4.184-4.648
 * on the four surfaces. `--accent-strong` was measured as a candidate first
 * and rejected at **3.046** on the page — a margin of 0.046, which is the
 * margin T046 refused to ship a fill at.
 */
const NON_TEXT_BAR = 3;

test("--accent-edge clears 3:1 on every backdrop, in both themes", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const failures: string[] = [];

  for (const theme of ["dark", "light"] as const) {
    for (const backdrop of everyBackdrop(colours, theme)) {
      const ratio = contrastRatio(colours["accent-edge"][theme], backdrop.hex);
      if (ratio < NON_TEXT_BAR) {
        failures.push(
          `${theme}: --accent-edge ${colours["accent-edge"][theme]} on ${backdrop.name} ` +
            `${backdrop.hex} = ${ratio.toFixed(3)}:1`,
        );
      }
    }
  }

  assert.deepEqual(failures, []);
});

/**
 * The one colour `app/globals.css` chooses rather than reads, so the only
 * place the repair above can be undone without touching a recipe.
 */
test("the focus outline is drawn in the edge green, not the fill green", () => {
  const rules = rulesOf(globalsCss).filter(({ head }) => head.includes(":focus-visible"));
  assert.equal(rules.length, 1, "expected exactly one :focus-visible rule in globals.css");
  const outline = /outline:\s*([^;]+);/.exec(rules[0].body);
  assert.notEqual(outline, null, ":focus-visible sets no outline");
  assert.match(outline![1], /var\(--accent-edge\)/);
  assert.doesNotMatch(outline![1], /var\(--accent\)/);
});

/**
 * The mirror of T049's role guard, for the role it added. `--accent-edge` is a
 * line: it is never read as type, and the bare fill green is never drawn as a
 * line again, which is the regression this whole section exists to prevent.
 */
test("the edge green is only ever a line, and no line is drawn in the fill green", () => {
  const offenders = everyRecipeString(TOKENS).filter(
    (recipe) =>
      /(?:^|\s)(?:[a-z-]+:)*text-accent-edge(?:\s|$)/.test(recipe) ||
      /(?:^|\s)(?:[a-z-]+:)*(?:bg|from|to|via)-accent-edge(?:\s|$)/.test(recipe) ||
      /(?:^|\s)(?:[a-z-]+:)*(?:border|ring|outline|divide)-accent(?:\s|$)/.test(recipe),
  );
  assert.deepEqual(offenders, []);
});

/* ── Contrast: an ink is chosen against the fill under it ────────────── */

/**
 * 🔴 **The danger button's label was plain white, and it was the only solid
 * button in this console whose ink was not chosen against its fill.**
 * 3.010:1 in the dark theme and 4.351:1 in the light one, both under the 4.5
 * its `text-sm`/`font-semibold` label asks for. T046 settled the direction on
 * the green button — keep the fill, choose an ink for it — and this is the
 * same repair on the other one: 5.006 dark, 7.122 light.
 *
 * ⚠️ **`--bad-ink` is themed where `--accent-ink` is not, and that is the
 * whole content of the decision.** The accent is a light green in both themes,
 * so one dark ink serves both. This red is pale in the dark theme and deep in
 * the light one — it has to be, because the same token is *read* on a dark
 * surface and *read* on a light one — so the ink is the opposite pole of the
 * fill in each theme. Darkening the dark red instead would have repaired the
 * button by breaking the eight places the same token is read.
 *
 * Written as a sweep over the recipes rather than as two numbers: the next
 * filled status button is covered without anyone remembering to come back.
 */
const OPAQUE_STATUS_FILLS = [
  "accent",
  "accent-strong",
  "accent-edge",
  "ok",
  "warn",
  "bad",
  "info",
] as const;
const OPAQUE_FILL: RegExp = /(?:^|\s)(?:[a-z-]+:)*bg-([a-z0-9-]+)(?=\s|$)/g;

test("a recipe that fills with a status or accent colour carries an ink chosen against it", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const pairs: { fill: string; ink: string }[] = [];

  for (const recipe of everyRecipeString(TOKENS)) {
    for (const match of recipe.matchAll(OPAQUE_FILL)) {
      const fill = match[1];
      if (!(OPAQUE_STATUS_FILLS as readonly string[]).includes(fill)) continue;
      for (const ink of [...recipe.matchAll(GREEN_TEXT)].map((m) => m[1])) {
        if (colours[ink]) pairs.push({ fill, ink });
      }
    }
  }

  // A sweep that finds nothing passes for free. Both filled buttons in this
  // console have to be in here, or the sweep has stopped seeing the recipes.
  assert.deepEqual(
    [...new Set(pairs.map((p) => `${p.ink} on ${p.fill}`))].sort(),
    ["accent-ink on accent", "accent-ink on accent-strong", "bad-ink on bad"],
  );

  const failures: string[] = [];
  for (const { fill, ink } of pairs) {
    for (const theme of ["dark", "light"] as const) {
      const ratio = contrastRatio(colours[ink][theme], colours[fill][theme]);
      if (ratio < 4.5) {
        failures.push(
          `${theme}: --${ink} ${colours[ink][theme]} on --${fill} ` +
            `${colours[fill][theme]} = ${ratio.toFixed(3)}:1`,
        );
      }
    }
  }
  assert.deepEqual(failures, []);
});

/* ── Shape: a badge has to still be a badge on a hovered row ─────────── */

/**
 * 🔴 **`BADGE.tone.neutral` was filled with a surface token, and on a hovered
 * row it stopped existing.**
 *
 * `TABLE.row` takes `--surface-hover` on hover and the grey badge *was*
 * `--surface-hover`, so the pill's fill and the row's fill were the same
 * colour: ratio exactly **1.000**. Not hard to read — not there. Both live
 * sites suppress the dot, so the fill was the whole of the shape:
 * `app/audit/page.tsx` puts one on every row of the log, and
 * `app/devices/page.tsx` puts one in the transport column.
 *
 * The repair is the category rather than the symptom, and these two tests are
 * why it had to be. A border would have drawn a line over a collision that was
 * still there — and cost two pixels on every badge in the console, because the
 * five tones have to stay one size when a setting toggles between two of them
 * (`components/settings-form.tsx` swaps the same badge between `ok` and
 * `neutral`). Moving the fill onto a line colour makes the collision
 * impossible instead: no recipe in this file paints a line colour as a
 * background, the first test derives that rather than asserting it, and a
 * translucent wash over a surface is never that surface.
 *
 * Measured: 1.000 -> **1.342** in light and **1.383** in dark against all four
 * surfaces, at or above all four tinted tones on the same hovered row
 * (1.091-1.135 and 1.211-1.352). The word went with it — the faintest tier at
 * 2.688:1 on the old fill, the plain tier at 10.895:1 on the new one, which is
 * the tier an unbadged cell would have rendered it at anyway.
 */
function badgeToneFills(): { tone: string; fill: string }[] {
  return Object.entries(TOKENS.BADGE.tone).map(([tone, recipe]) => {
    const match = /(?:^|\s)bg-([a-z0-9-]+)(?=\s|$)/.exec(recipe as string);
    assert.notEqual(match, null, `BADGE.tone.${tone} paints no background`);
    return { tone, fill: match![1] };
  });
}

test("no badge tone is filled with a colour this console paints as a surface", () => {
  const paintedAsSurface = new Set<string>();
  for (const recipe of everyRecipeString(TOKENS)) {
    for (const match of recipe.matchAll(OPAQUE_FILL)) {
      if ((OPAQUE_SURFACES as readonly string[]).includes(match[1])) paintedAsSurface.add(match[1]);
    }
  }
  // The surfaces really are painted somewhere, or the sweep below is vacuous.
  assert.deepEqual([...paintedAsSurface].sort(), ["bg", "surface", "surface-hover", "surface-raised"]);

  const offenders = badgeToneFills().filter(({ fill }) => paintedAsSurface.has(fill));
  assert.deepEqual(offenders, []);
});

test("every badge tone keeps a shape on every surface it can sit on", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const failures: string[] = [];

  for (const { tone, fill } of badgeToneFills()) {
    for (const theme of ["dark", "light"] as const) {
      const value = colours[fill][theme];
      for (const surface of OPAQUE_SURFACES) {
        const behind = colours[surface][theme];
        const pill = value.startsWith("rgba(") ? over(value, behind) : value;
        if (pill === behind) {
          failures.push(`${theme}: BADGE.tone.${tone} is ${pill} on --${surface}, which is ${behind}`);
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

/* ── Size: what a finger has to hit ──────────────────────────────────── */

/**
 * 🔴 **The language switcher opted out of this console's own touch token, and
 * nothing said why.**
 *
 * `--touch` is 44px, the AAA figure, and the console defines it precisely so
 * that "anything a finger has to hit" is one decision made once. Measured on
 * the signed-out pages the two options came out 48x32 and 62.9x32: past the AA
 * floor of 24x24, twelve pixels short of the token. The sign-in field and its
 * submit button beside them measure exactly 44.
 *
 * Three recipes sat below the token. The other two say in writing why, and
 * both reasons are the same reason: they live in a dense table row and are
 * sized to the cells around them — `FORM.selectCompact` argues it explicitly.
 * The switcher is not in a table. It sits alone in a page header, and in the
 * journal it sits above the table rather than inside it.
 *
 * The ledger below is the half that keeps this true. Without it the next
 * recipe to want a shorter control just adds one, and nothing in this file
 * would notice.
 */
test("the language switcher's options are a full touch target", () => {
  assert.match(TOKENS.SEGMENTED.option, /(^|\s)min-h-touch(\s|$)/);
});

test("the only controls shorter than the touch token are the two a table row pays for", () => {
  const short = everyRecipeString(TOKENS)
    .filter((recipe) => /(^|\s)min-h-s6(\s|$)/.test(recipe))
    .sort();
  assert.deepEqual(short, [TOKENS.BUTTON.size.sm, TOKENS.FORM.selectCompact].sort());
});

/* ── The list that decides whether any of the above runs ─────────────── */

/**
 * 🔴 **The second copy of the guard on `package.json`'s test list, and the
 * reason a second copy is not redundancy.**
 *
 * The test script is a hand-written list of files, so a test file can exist,
 * pass, and never run. `lib/interpolate.test.ts` already asserts that every
 * `lib/*.test.ts` is on it — written after `lib/i18n.test.ts` was silently
 * dropped **in a merge** and the suite reported 256 passing tests without it.
 *
 * ⚠️ **A guard in one file cannot catch that file's own removal.** Drop
 * `interpolate.test.ts` from the list and the check goes with it; nothing else
 * looks. The blind spot is badly placed, too: measured by running each file on
 * its own, `interpolate.test.ts` carries **11** tests — tied with
 * `session.test.ts` for the smallest on the list — against `tokens.test.ts`'s
 * 132. Losing it moves the suite 305 → 294, which is *smaller than the last
 * two cards each moved it on purpose*. A falling count is a tripwire, not a
 * guard, and this repository already has the rule that a test count is not
 * evidence — the name list is.
 *
 * So: the same predicate, in a second and unrelated file. Dropping either one
 * alone now goes red. **What this does and does not buy, stated plainly:** it
 * raises the bar from "one small file disappears from the list" to "two
 * unrelated files disappear from the same merge" — and nobody removes a
 * contrast-and-recipe test and an interpolation test together as duplicates.
 * If both *are* dropped, `npm test` runs neither and is still silent. The bar
 * is higher; it is not a proof.
 *
 * Deliberately duplicated rather than factored into a shared helper: a helper
 * is a third file, and a third file can be dropped too.
 */
test("every lib test file is on the hand-written list in package.json", () => {
  const pkg = JSON.parse(readSource("package.json")) as { scripts: Record<string, string> };
  const onDisk = readdirSync(join(root, "lib"))
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
  assert.ok(onDisk.length >= 10, `only found ${onDisk.length} test files in lib/`);
  const unrun = onDisk.filter((name) => !pkg.scripts.test.includes(`lib/${name}`));
  assert.deepEqual(unrun, [], `written but never run: ${unrun.join(", ")}`);
});

/**
 * The three text tiers, and where the line between them falls.
 *
 * `--fg-faint` does not clear 4.5:1 anywhere, in either theme — light is
 * 2.69-2.99 and dark is 3.20-3.89 — and that is not by itself a defect,
 * because a timestamp beside a message it belongs to is supplementary text.
 * It becomes a defect the moment the faint tier is used to label something a
 * person has to operate: an unselected segmented option is not an *inactive*
 * control, which is the only thing WCAG 1.4.3 exempts — it is the control you
 * are required to press to change the setting.
 *
 * 🔴 `SEGMENTED.option` was exactly that: the language switcher on
 * `/not-a-tenant` and `/unknown-tenant`, `text-fg-faint` on `bg-surface-hover`,
 * 3.20:1 in the dark theme that every signed-out visitor gets and 2.69:1 in
 * light. Every other interactive recipe in this file was already on
 * `--fg-muted`, so the repair was to move that one recipe up a tier rather
 * than to lift the faint token — lifting it would have closed the ~1.9:1 gap
 * between the two tiers and flattened the hierarchy everywhere to fix one
 * control.
 *
 * The rule is written as a sweep rather than a list so a recipe added later
 * is covered without anyone remembering to come back here. `placeholder:` is
 * deliberately outside it: a placeholder is a hint inside a control rather
 * than the control's own label, the value the user types is `--fg`, and
 * `FORM.input`'s placeholder is the one remaining faint-tier string that sits
 * on an interactive element (2.81:1 in light on `--bg`). That one is left
 * measured and unfixed on purpose — it is a separate decision, not this card's.
 */
const INTERACTIVE_MARKERS = ["cursor-pointer", "min-h-touch"];

function everyRecipeString(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) everyRecipeString(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) everyRecipeString(item, out);
  return out;
}

test("no recipe for something you operate labels itself with the faintest tier", () => {
  const offenders = everyRecipeString(TOKENS).filter(
    (recipe) =>
      INTERACTIVE_MARKERS.some((marker) => recipe.includes(marker)) &&
      /(^|\s)text-fg-faint(\s|$)/.test(recipe),
  );
  assert.deepEqual(offenders, []);
});

test("--fg-muted, the tier those controls use, clears 4.5:1 on every surface", () => {
  const colours: Record<string, { readonly dark: string; readonly light: string }> =
    TOKENS.COLOR_TOKENS;
  const surfaces = ["bg", "surface", "surface-raised", "surface-hover"];
  const failures: string[] = [];

  for (const theme of ["dark", "light"] as const) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(colours["fg-muted"][theme], colours[surface][theme]);
      if (ratio < 4.5) failures.push(`${theme}: --fg-muted on --${surface} = ${ratio.toFixed(3)}:1`);
    }
  }

  assert.deepEqual(failures, []);
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
 * If `@tailwind utilities` ever ends up inside a layer, the reset stops being
 * outranked by the utilities and starts painting things the recipes decided.
 * That arrangement is what the whole migration rested on while there was a
 * second stylesheet to keep away from migrated pages; it still matters with
 * one, because the reset styles `button`, `input`, `select` and `textarea` by
 * element name and a recipe's `text-sm` on a button has to win.
 *
 * 🔴 **And the layer that is *not* here is the point of this card.** The
 * 862-line hand-written stylesheet lived in `@layer legacy` in this file. It
 * is gone, and the assertion that it is gone is the measurable form of
 * criterion ①. A card that reintroduces it — under that name or any other —
 * fails here.
 */
test("the stylesheet is one layer of reset, the utilities are not layered at all", () => {
  const css = stripComments(globalsCss);
  const tokensAt = css.indexOf("@layer tokens {");
  const utilitiesAt = css.indexOf("@tailwind utilities;");

  assert.notEqual(tokensAt, -1, "the reset must stay inside @layer tokens");
  assert.notEqual(utilitiesAt, -1);
  assert.ok(utilitiesAt > tokensAt, "@tailwind utilities has to come after the reset");

  // Unlayered means: not inside any block. Every brace before it is closed.
  const before = css.slice(0, utilitiesAt);
  const depth = before.split("{").length - before.split("}").length;
  assert.equal(depth, 0, "@tailwind utilities is inside a block, so it is layered");

  // The deleted layer, by name and by shape. `legacy` is the name it had;
  // `@layer` with anything other than `tokens` is the shape, so bringing the
  // old stylesheet back under a new name does not slip past.
  const layers = [...css.matchAll(/@layer\s+([\w-]+)/g)].map((match) => match[1]);
  assert.deepEqual(layers, ["tokens"], "a second cascade layer is back in globals.css");

  // 🔴 And nothing may sit outside it. A rule written after the layer closes is
  // unlayered, which beats every utility whatever the specificity — the same
  // hazard as an unlayered preflight, arriving one rule at a time instead of
  // all at once. Only the three `@tailwind` directives are allowed out there.
  const outside: string[] = [];
  let nesting = 0;
  let head = "";
  for (const character of css) {
    if (character === "{") {
      // Everything since the last `;` — the `@tailwind` directives are
      // statements, not rules, and they sit in front of the layer's own brace.
      if (nesting === 0) outside.push((head.split(";").pop() ?? "").replace(/\s+/g, " ").trim());
      nesting += 1;
      head = "";
    } else if (character === "}") {
      nesting -= 1;
      head = "";
    } else if (nesting === 0) {
      head += character;
    }
  }
  assert.deepEqual(
    outside.filter((one) => !one.startsWith("@layer ")),
    [],
    "a rule in globals.css is outside @layer tokens, so it outranks every utility",
  );

  assert.equal(
    tailwindConfig.corePlugins?.preflight,
    false,
    "preflight is unlayered and would outrank the reset; switching it on moved 886 " +
      "elements when this card measured it, and is a decision with its own card",
  );
});

/**
 * 🔴 The stylesheet defines no class. This is criterion ① as one assertion.
 *
 * Every other check in this section is a comparison against an empty set, and
 * they are all empty *because of this*: `app/globals.css` is `:root` tokens, a
 * reset that selects `*` and a handful of element names, and two `@tailwind`
 * directives. There is nowhere for a class rule to hide, so there is no
 * collision with a utility name, no class that only works under an ancestor,
 * and no rule that only works inside a grid.
 *
 * The extractor is proved on `PROBE_SHEET` in the same test, because finding
 * nothing and being broken look identical from here.
 */
test("app/globals.css defines no class selector at all", () => {
  assert.deepEqual(
    [...stylesheetClassNames()].sort(),
    [],
    "a hand-written class rule is back in globals.css; classes come from lib/tokens.ts",
  );

  // The same extractor, on a sheet shaped like the one that was deleted.
  assert.deepEqual(
    [...classNamesOf(PROBE_SHEET)].sort(),
    ["button-row", "card", "card-span-all", "risk"],
    "the class extractor has stopped finding classes, so every check above is vacuous",
  );

  // And the sheet is not empty either: it still has to be styling something.
  assert.ok(stylesheetRules().length > 5, "globals.css has stopped containing rules");
});

/**
 * 🔴 What the stylesheet is allowed to say about a bare element, exactly.
 *
 * This is the guard that replaces the family of `the legacy layer styles
 * table / th / label by name` checks, and it is the one that matters most,
 * because an element-name rule is the leak no class-based check can see. A
 * cascade layer settles the properties two rules both declare and nothing
 * else, so a rule keyed on `input` reaches every input in the console whatever
 * classes it carries.
 *
 * Measured, not argued: deleting the old stylesheet without replacing its
 * `font: inherit` on these four elements moved 176 buttons, 78 inputs, 12
 * selects and 4 textareas across the fifteen pages, and a grep for the old
 * class names sees none of it.
 *
 * So both halves are pinned. A new element name here fails; a new *property*
 * on an element already here fails too, which is the half that catches a
 * `th, td` padding rule coming back one declaration at a time.
 */
const RESET_TYPE = [
  "font-family",
  "font-feature-settings",
  "font-variation-settings",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "padding",
];

const RESET_ELEMENTS: Record<string, string[]> = {
  // The type and box normalisation a form control does not inherit on its own.
  // Copied from what this config compiles preflight to, minus `margin: 0` —
  // the deleted stylesheet never set a margin either, and adding one moves
  // both of this console's checkboxes off the user agent's 3px.
  button: RESET_TYPE,
  input: RESET_TYPE,
  optgroup: RESET_TYPE,
  select: RESET_TYPE,
  textarea: RESET_TYPE,
  // The document.
  html: ["margin", "padding"],
  body: [
    "margin",
    "padding",
    "background",
    "color",
    "font-family",
    "font-size",
    "line-height",
    "-webkit-font-smoothing",
    "padding-bottom",
  ],
  // An anchor inherits its colour and carries no underline. This is in the
  // reset rather than in a recipe because it is a decision about every link in
  // the console, and `PAGE.link` is what a link in running text adds back.
  a: ["color", "text-decoration"],
};

test("the stylesheet styles bare elements only where a reset is allowed to", () => {
  const rules = stylesheetElementRules();
  assert.deepEqual(
    [...rules.keys()].sort(),
    Object.keys(RESET_ELEMENTS).sort(),
    "globals.css names an element nobody has said a reset may name",
  );
  for (const [element, allowed] of Object.entries(RESET_ELEMENTS)) {
    assert.deepEqual(
      [...(rules.get(element) ?? [])].sort(),
      [...allowed].sort(),
      `globals.css declares something new on bare <${element}>, and that reaches every one of them`,
    );
  }

  // The extractor finds element rules when there are element rules to find —
  // the same function, not a copy of it.
  const probe = elementRulesOf(PROBE_SHEET);
  assert.deepEqual(
    // `.button-row button.risk` is skipped on purpose: a compound carrying a
    // class is not styling the bare element, so the class goes when the rule does.
    [...probe.keys()].sort(),
    ["td", "th"],
    "the element-rule extractor has broken, so the assertions above are vacuous",
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

/**
 * The collision list is derived, not remembered — and it is now empty.
 *
 * A cascade layer settles which rule wins a property both rules declare. It
 * does nothing about the properties only the layered rule declares, and that
 * is not a subtlety: the deleted stylesheet's grid rule also set a gap and a
 * column template, Tailwind's utility of the same name sets a display and
 * nothing else, and those two declarations reached every element carrying the
 * utility for the whole of the refactor.
 *
 * The set is still recomputed from `app/globals.css` and the real Tailwind
 * build on every run, because “empty” has to keep being true rather than
 * having been true once. It is empty for a structural reason: that file
 * defines no class selector at all.
 */
test("the stylesheet collides with Tailwind on exactly the known names", async () => {
  const names = stylesheetClassNames();
  const generated = await generatedClasses([...names, "p-s4"]);
  const collisions = [...names].filter((name) => generated.has(name)).sort();
  assert.deepEqual(collisions, [...LEGACY_UTILITY_COLLISIONS].sort());

  // The derivation is the check, so it has to be able to find one. On a sheet
  // shaped like the deleted one, the same two lines produce the collision that
  // was live in this repository until this card.
  const probe = classNamesOf("@layer legacy {\n.grid { gap: 1rem; }\n.card { border: 0; }\n}");
  const probeGenerated = await generatedClasses([...probe]);
  assert.deepEqual(
    [...probe].filter((name) => probeGenerated.has(name)).sort(),
    ["grid"],
    "the collision derivation has broken, so the empty answer above means nothing",
  );
});

/**
 * No file carries a class the stylesheet defines, because it defines none.
 *
 * Kept as its own test rather than folded into the one above, because the two
 * fail for different reasons: that one fails when the stylesheet grows a rule
 * that shadows a utility, this one fails when a `.tsx` or a recipe starts
 * asking for a name only the stylesheet would answer.
 */
test("no file carries a class from the stylesheet", () => {
  const defined = stylesheetClassNames();
  for (const shared of LEGACY_UTILITY_COLLISIONS) defined.delete(shared);

  const offenders = allUsedClasses().filter((name) => defined.has(name));
  assert.deepEqual(offenders, [], `reading a hand-written rule: ${offenders.join(", ")}`);

  // Self-proof in both directions: the class extractor for `.tsx` and recipes
  // still finds classes, and the set it is filtered against is really empty.
  assert.ok(allUsedClasses().length > 50, "the class extractor has stopped finding classes");
  assert.equal(defined.size, 0, "globals.css defines a class again");
});

/**
 * The escape hatch is gone with the thing it was an escape from.
 *
 * For most of this refactor a bare grid utility was forbidden, because the
 * deleted stylesheet had a rule under the same name whose extra declarations
 * leaked through the cascade layer. The way out was a variant-prefixed name,
 * which puts a different string in the class attribute. Both the ban and the
 * hatch are now unnecessary, and the empty ban is asserted rather than
 * deleted — a card that puts a name back into
 * `FORBIDDEN_IN_MIGRATED_SOURCES` has to explain itself, and until then a
 * page card may lay something out with a grid like any other project.
 *
 * What is kept is the *check*, not the prohibition: the utilities a layout
 * needs still have to generate CSS on this closed set of scales, which is
 * where an off-token class silently produces nothing.
 */
test("a grid is available to lay something out with, and nothing is forbidden", async () => {
  assert.deepEqual(
    [...FORBIDDEN_IN_MIGRATED_SOURCES],
    [],
    "a class name is banned again; say here what rule it collides with",
  );

  const wanted = ["grid", "sm:grid", "grid-cols-3", "gap-s4", "grow"];
  const generated = await generatedClasses(wanted);
  for (const name of wanted) {
    assert.ok(generated.has(name), `${name} generates nothing, so a layout cannot ask for it`);
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
  const defined = stylesheetClassNames();
  const offenders = found
    .filter((f) => f.words.some((word) => generated.has(word) || defined.has(word)))
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
 * Every element the stylesheet names gets a class of its own in the markup.
 *
 * The deleted stylesheet styled `table`, `th`, `td`, `form`, `label`, `input`,
 * `select`, `textarea` and `button` by element name, and a page that rendered
 * a bare one of them looked correct for the wrong reason. There was no
 * assertion against it at all: a bare `<form><label><select><textarea>`
 * dropped into a migrated page passed everything and would have gone bare the
 * day the layer was deleted.
 *
 * The list the stylesheet names is now much shorter — a reset's worth — but
 * the rule is the same one and it has not been relaxed: an element the
 * stylesheet mentions is an element whose appearance is decided in two places,
 * so the markup has to say which it wants. `html` and `body` are excluded
 * because no `.tsx` here writes either of them; `a` is not excluded, and the
 * anchors in this console do all carry a class.
 */
test("a file gives every element the stylesheet names a class of its own", () => {
  const named = new Set(stylesheetElementRules().keys());
  for (const notMarkup of ["html", "body"]) named.delete(notMarkup);
  assert.ok(
    ["button", "input", "select", "textarea", "a"].every((one) => named.has(one)),
    "the element-rule extractor stopped finding the reset's own elements",
  );

  const offenders: string[] = [];
  for (const relative of MIGRATED_SOURCES) {
    for (const tag of openingTags(readSource(relative))) {
      if (!named.has(tag.name)) continue;
      if (/\bclassName\s*=/.test(tag.text)) continue;
      offenders.push(`${relative}: <${tag.name}>`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "this element is styled by the reset and by nothing else; say what it should look like",
  );
});

/**
 * And there has to be a recipe to give them — all five, not just the three
 * the reset happens to name.
 *
 * This used to derive the list from the stylesheet: whichever elements
 * `@layer legacy` styled bare were the ones that needed a recipe. That
 * derivation would now answer `input`, `select` and `textarea` and quietly
 * drop `form` and `label`, which is the wrong direction — the reason those
 * two need a recipe is precisely that **nothing** styles them any more. A
 * `<form>` with no class is a block with no gap between its fields, and a
 * `<label>` with no class is body text.
 *
 * So the list is stated, and the test that it is complete is the one above:
 * a bare form element in any file fails there.
 */
test("there is a form recipe for every form element this console renders", () => {
  const recipeFor: Record<string, string> = {
    form: "root",
    label: "label",
    input: "input",
    select: "select",
    textarea: "textarea",
  };
  const missing = Object.entries(recipeFor)
    .filter(([, key]) => typeof (FORM as Record<string, unknown>)[key] !== "string")
    .map(([element]) => element);
  assert.deepEqual(missing, [], "a page that needs one of these has nowhere to get it from");

  // And every one of them has to be a real class list, not an empty string:
  // an empty recipe passes the check above and draws nothing.
  for (const [element, key] of Object.entries(recipeFor)) {
    const recipe = (FORM as Record<string, unknown>)[key] as string;
    assert.ok(
      recipe.split(/\s+/).filter(Boolean).length > 1,
      `FORM.${key} is empty, so a bare <${element}> is what a page still gets`,
    );
  }
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

  // Nought to go, and this is the end of the ratchet rather than a step on
  // it. There is no second stylesheet left for a file to be rendered by, so a
  // name appearing here would be a claim that something outside the design
  // system is painting a page — which is the thing criterion ① says is
  // finished. Pinned exactly, not bounded.
  assert.deepEqual(
    [...UNMIGRATED_SOURCES],
    [],
    `the unmigrated list is not empty: ${[...UNMIGRATED_SOURCES].join(", ")}`,
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
 * The old `components/ui.tsx` barrel is gone, and so are its two guards.
 *
 * It was a compatibility layer over `components/ui/*`: ten pages imported a
 * prop-shaped `Card`, `StatCard`, `EmptyState` and `StateBadge` from it while
 * seven migration cards ran in parallel. Two tests stood here. One pinned the
 * set of importing pages as a *list* rather than a count — deliberately, so
 * that seven cards in seven worktrees each deleted their own line and git
 * merged the deletions, where two cards both writing `9` would have merged
 * cleanly into a wrong `9`. The other held the layer to *delegating* rather
 * than drawing, so it could not become a second empty state.
 *
 * Both read the file itself, so both went with it when the list reached empty
 * and the file was deleted. Nothing was loosened to let that happen: what
 * replaces them is resolution rather than assertion. There is no
 * `components/ui/index.tsx`, so `@/components/ui` now resolves to nothing at
 * all — a page reaching for the old names is a `tsc --noEmit` and `next build`
 * failure, which is a harder stop than either test was. The one claim here
 * that outlived the barrel, "there is one empty state in this console", is the
 * test below, and it is pinned tighter now than it was.
 */


/**
 * 🔴 One empty state. The reconciliation this card was given, stated as a test.
 *
 * `T001` renamed `EmptyState` to `CardEmpty` in `components/ui/card.tsx` and
 * left eight pages importing the old name, which is how two implementations of
 * the same thing start. The barrel carried a wrapper over the real one rather
 * than a copy, and the plan to open a third file for it was dropped — but
 * "there is one of these" was a thing somebody had to remember, and nothing
 * else says a ninth page may not quietly grow its own.
 *
 * Deleting the barrel *tightened* this test rather than retiring it: the second
 * name went with it, so claim 2 now pins a single file where it used to allow
 * two. That is the whole of what this card changed here.
 *
 * Three claims, each of which a second implementation has to break:
 *
 * 1. **One file draws it.** Exactly one `.tsx` reads `CARD.empty*`. A copy has
 *    to get its classes from somewhere, and the recipes are the only place
 *    classes are allowed to come from.
 * 2. **One file names it.** `components/ui/card.tsx` and nothing else exports
 *    an `Empty`-shaped name. While the barrel existed this was a two-element
 *    list whose second entry was allowed to delegate; with the barrel gone, a
 *    second name anywhere is a second implementation with no exception left.
 * 3. **Nobody hand-draws one from the stylesheet.** `.empty`, `.empty-title`
 *    and `.empty-desc` went with `@layer legacy`, so a page writing that markup
 *    itself now renders unstyled rather than looking perfectly right — still
 *    worth catching, and still caught here by name.
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
    ["components/ui/card.tsx"],
    "an empty state was declared somewhere new: there is meant to be exactly one name for it",
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

/**
 * The ledger has one side now, and this is what is left of the other.
 *
 * This test used to read every file on the unmigrated list and check it really
 * did still carry a class from the old stylesheet — so that a page migrated
 * without being moved across failed rather than going unchecked. The list is
 * empty, which makes the loop vacuous, so what is asserted instead is the fact
 * that made it vacuous: every `.tsx` under `app/` and `components/` is on the
 * checked side, and the number of them is pinned so that a file quietly
 * disappearing from both lists is not mistaken for progress.
 */
test("every .tsx in the console is on the checked side of the ledger", () => {
  assert.deepEqual([...UNMIGRATED_SOURCES], []);
  assert.equal(
    MIGRATED_SOURCES.length,
    44,
    `the console has ${MIGRATED_SOURCES.length} .tsx files under app/ and components/, not 44 — ` +
      "if that is right, say so here; the ledger test next door proves the list matches the directory",
  );

  // And the files really are read: a name on the list that does not exist
  // would make every check that iterates it throw, but a name that exists and
  // is empty would not.
  const empty = MIGRATED_SOURCES.filter((relative) => readSource(relative).trim().length === 0);
  assert.deepEqual(empty, [], "a listed file is empty, so every check that reads it passes on nothing");
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

test("a class in any .tsx is defined by the build, and there is nothing else", async () => {
  const asked = new Set<string>();
  for (const relative of [...MIGRATED_SOURCES, ...UNMIGRATED_SOURCES]) {
    for (const name of classesIn(classListsIn(readSource(relative)))) asked.add(name);
  }
  // Zero, and that is the milestone rather than a low number: no `.tsx` in
  // this console writes a class of its own, so the Tailwind build is the only
  // thing that has to define anything. A floor cannot tell genuinely-zero from
  // extractor-broke, so the count is pinned exactly and the extractor is proved
  // on a probe below.
  assert.equal(asked.size, 0, `a file has a class literal again: ${[...asked].join(", ")}`);

  // The extractor still works — the assertion above would also pass if it had
  // stopped finding anything at all.
  const probe = classesIn(classListsIn(`<div className="probe-a probe-b" />`));
  assert.deepEqual([...probe].sort(), ["probe-a", "probe-b"], "the class extractor has broken");

  // The second half of the old title is gone with the stylesheet: a class the
  // build does not generate is now defined by *nothing*, full stop. Recipes are
  // where every class comes from, so they are what is put to the build.
  const recipeClasses = allUsedClasses();
  const generated = await generatedClasses([...recipeClasses, "p-s4"]);
  const defined = stylesheetClassNames();
  const allowed = new Set<string>(NON_UTILITY_CLASSES);
  const dead = [...recipeClasses]
    .filter((name) => !generated.has(name) && !defined.has(name) && !allowed.has(name))
    .sort();

  assert.deepEqual(
    dead,
    [],
    "a class nothing defines: it has never rendered, and nobody would see that in review",
  );
  assert.deepEqual(
    [...CLASSES_WITH_NO_STYLESHEET],
    [],
    "the frozen list of classes nothing defines is closed at empty",
  );
});

/**
 * `.risk` was not a rule, and the button that needed it most never got it.
 *
 * The deleted stylesheet declared it only as `.button-row button.risk` and
 * `.row-actions button.risk`, so it coloured a button in those two containers
 * and did nothing anywhere else. `device-console.tsx:663` — the USB-net mode
 * switch, which takes a module out of the device list — sat in a form whose
 * class was `inline-form`, and its warning colour was never once drawn. A
 * written guard that does not render is worse than none: it is on the
 * checklist.
 *
 * Both halves are still derived rather than remembered. The stylesheet is read
 * for the claim — which now finds nothing, because there is no class rule left
 * in it to hide under an ancestor — and the replacement is put to the real
 * Tailwind build standing on its own, with no ancestor at all. The second half
 * is the part that has to keep working: `BUTTON.variant.risk` is what a
 * dangerous button is coloured by today, on every page.
 */
test("a class that needs an ancestor has a variant that does not", async () => {
  // Derived: every class name the stylesheet declares *only* in a compound or
  // descendant selector, never as a rule of its own.
  const alone = new Set<string>();
  const under = new Set<string>();
  for (const { head } of stylesheetRules()) {
    if (head.includes("@")) continue;
    for (const selector of head.split(",")) {
      const trimmed = selector.trim();
      for (const match of trimmed.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
        (trimmed === `.${match[1]}` ? alone : under).add(match[1]);
      }
    }
  }
  const ancestorOnly = [...under].filter((name) => !alone.has(name)).sort();
  assert.deepEqual(
    ancestorOnly,
    [...CLASSES_NEEDING_AN_ANCESTOR].sort(),
    "a class in globals.css only bites under an ancestor, which is a guard that may not render",
  );

  // The derivation has to be able to find one, or the empty answer is noise.
  const probeAlone = new Set<string>();
  const probeUnder = new Set<string>();
  for (const { head } of rulesOf(PROBE_SHEET)) {
    if (head.includes("@")) continue;
    for (const selector of head.split(",")) {
      const trimmed = selector.trim();
      for (const match of trimmed.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
        (trimmed === `.${match[1]}` ? probeAlone : probeUnder).add(match[1]);
      }
    }
  }
  assert.deepEqual(
    [...probeUnder].filter((name) => !probeAlone.has(name)).sort(),
    ["button-row", "risk"],
    "the ancestor-only derivation has broken, so the empty answer above means nothing",
  );

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
 * one of them. `lib/tokens.ts` is Tailwind content, so its comments compile.
 *
 * **Four entries came off under T018 and the reason is worth keeping.** They
 * were not prose: `grow` and `sr-only` were spelled out in
 * `FORBIDDEN_IN_MIGRATED_SOURCES` and `LEGACY_UTILITY_COLLISIONS`, and
 * `sm:grid` and `max-sm:grid` were the documented escape hatch from the
 * collision those lists existed for. The rules were built out of the ledger
 * that existed to forbid them. Both ledgers are pinned empty now and the
 * escape hatch has nothing to escape, so the four rules stopped being
 * generated — which is the list shrinking for the right reason rather than
 * somebody deleting a name to quieten a test.
 *
 * `grid` stayed, and it is no longer a ledger that keeps it: six comments in
 * `lib/tokens.ts` use the word in ordinary English — three about tables, and
 * three about this deletion itself.
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
  // Ordinary English in six comments in `lib/tokens.ts`: three about tables (a
  // wide one scrolls sideways in its card, and a definition list is not one),
  // three about the stylesheet this deletion removed. Prose, not a ledger.
  "grid",
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
    "source.consoleLicense",
    "source.consoleLicenseUrl",
  ]) {
    assert.ok(code.includes(`"${key}"`), `the footer no longer renders ${key}`);
  }
  assert.equal(
    (code.match(/target="_blank"/g) ?? []).length,
    4,
    "four source links: console, console licensing, edge, edge licensing",
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
 * The reset that stands in for Tailwind's preflight, read out of the sheet.
 *
 * Returned as a selector *and* a declaration map, because both halves have been
 * wrong: for the whole of this refactor the block said `box-sizing` and nothing
 * else, and it selected `*` without the two pseudo-elements preflight also
 * covers.
 */
function preflightStandIn(): { selector: string; declarations: Record<string, string> } {
  const css = stripComments(globalsCss);
  const at = css.indexOf("box-sizing: border-box");
  assert.notEqual(at, -1, "globals.css no longer carries a box-sizing reset at all");
  const open = css.lastIndexOf("{", at);
  const close = css.indexOf("}", at);
  const previous = Math.max(css.lastIndexOf("}", open), css.lastIndexOf("{", open - 1));
  const declarations: Record<string, string> = {};
  for (const one of css.slice(open + 1, close).split(";")) {
    const colon = one.indexOf(":");
    if (colon === -1) continue;
    declarations[one.slice(0, colon).trim()] = one.slice(colon + 1).trim();
  }
  return { selector: css.slice(previous + 1, open).replace(/\s+/g, " ").trim(), declarations };
}

/**
 * Recipes that ask for a border width and never say what kind of border.
 *
 * **Empty, and it is the reset in `app/globals.css` that keeps it empty.** That
 * is the whole of this check, so the reset is asserted here rather than
 * assumed. Preflight is off; a Tailwind border-*width* utility draws nothing
 * unless something has set a style, because `border-style` starts at `none` and
 * a `none` border has no width whatever the width utility says.
 *
 * For most of this refactor the stand-in reset was `box-sizing` alone, and
 * measured at 390x844 against the real build:
 *
 * | recipe | element | asked for | computed, then |
 * |---|---|---|---|
 * | `CARD.root` | `section` | a 1px outline | 0px — no card had a border |
 * | `TABLE.row` | `tr` | a bottom rule | 0px |
 * | `CENTERED.card` / `SHELL.navGroup` / `SHELL.tenant` | | | 0px |
 * | `BUTTON.base` | `button` | a 1px outline | 1px — from `@layer legacy` |
 * | `FORM.input` | `input` | a 1px outline | 1px — from `@layer legacy` |
 * | `TABLE.headerCell` | `th` | a bottom rule | 1px — from `@layer legacy` |
 *
 * The second half is the dangerous one and it is why this check is about the
 * reset rather than about a list of recipes: those three looked right only
 * because the legacy layer hands `button`, `input` and `th, td` a border
 * shorthand **by element name**, and that layer is deleted when the last page
 * is migrated. Built with it emptied and measured: `th` fell to 0px, and
 * `button` and `input` fell back to the user agent's 3D bevels in the colour
 * the recipe asked for. One recipe, two elements is how T010 first tripped over
 * it — `TABS.tab` renders `<a>` or `<button>` and only the `<button>` drew.
 *
 * The colour is checked against `borderColor.DEFAULT` in `tailwind.config.ts`
 * because that is what Tailwind compiles its own preflight to on this config.
 * Built both ways and compared element by element: with all four declarations
 * every specimen computes exactly what the real preflight computes, so the day
 * T018 deletes the legacy layer and switches preflight on is a day nothing
 * about borders changes. Drop the colour and a bare width with no colour class
 * moves from the text colour to the line colour on that day instead.
 */
const BORDER_WIDTH_WITHOUT_A_STYLE: string[] = [];

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
  // And it has to be finding recipes that say nothing about style, or the
  // assertions below are about a case that no longer occurs in this file.
  assert.ok(
    found.length > 10,
    "almost every recipe states a width without a style; if that stopped being " +
      "true the reset below stopped being what makes them draw",
  );

  const reset = preflightStandIn();
  // Preflight covers the two pseudo-elements as well, and this stand-in has to
  // cover what it covers or switching over is not a no-op.
  for (const part of ["*", "*::before", "*::after"]) {
    assert.ok(
      reset.selector.split(",").some((one) => one.trim() === part),
      `the stand-in reset does not cover ${part}, and preflight does`,
    );
  }
  assert.equal(reset.declarations["box-sizing"], "border-box");
  assert.equal(
    reset.declarations["border-style"],
    "solid",
    "without this every border width in every recipe above computes to 0px",
  );
  assert.equal(
    reset.declarations["border-width"],
    "0",
    "turning the style on turns all four sides on, and the initial width is `medium` — 3px",
  );
  const theme = tailwindConfig.theme as Record<string, unknown>;
  const extend = (theme.extend ?? {}) as Record<string, unknown>;
  const configured = (extend.borderColor as Record<string, unknown> | undefined)?.DEFAULT;
  assert.equal(
    reset.declarations["border-color"],
    configured,
    "the reset and borderColor.DEFAULT disagree, so preflight would recolour bare borders",
  );

  // In `@layer tokens`, never in `@layer legacy` and never unlayered. A later
  // layer wins whatever the specificity: the reset has to stay below the legacy
  // stylesheet so the page still rendering from it is untouched, and the whole
  // of `@tailwind utilities` is unlayered and outranks both.
  const css = stripComments(globalsCss);
  const resetAt = css.indexOf("box-sizing: border-box");
  assert.ok(
    css.lastIndexOf("@layer tokens {", resetAt) !== -1,
    "the reset is no longer inside @layer tokens",
  );
  assert.equal(
    css.lastIndexOf("@layer legacy {", resetAt),
    -1,
    "the reset moved into @layer legacy, which is the layer T018 deletes",
  );

  assert.deepEqual(
    BORDER_WIDTH_WITHOUT_A_STYLE,
    [],
    "this list is closed at empty: the reset is what supplies the style now",
  );
});

/**
 * 🔴 The other half of the reset, and the values, not only the property names.
 *
 * The test above pins which elements `app/globals.css` may name and which
 * properties it may set on them. That is what stops a hand-written rule coming
 * back. It says nothing about what the declarations are *worth*, and a form
 * control reset whose values were wrong would pass it: `font-family: Arial`
 * has the same property name as `font-family: inherit`.
 *
 * These are Tailwind's own preflight declarations for these elements, and
 * copying them rather than inventing them is the point — preflight is off, is
 * unlayered, and outranks this block the day it is switched on. Any value here
 * that is not preflight's is a value that silently changes on that day.
 *
 * `margin: 0` is preflight's and is deliberately **not** here. The stylesheet
 * this replaced never set a margin either, so both of this console's
 * checkboxes still carry the user agent's `margin: 3px 3px 3px 4px`; stating
 * it would have moved them, which is the one thing deleting a stylesheet is
 * not allowed to do. It is asserted absent so that adding it is a decision
 * somebody makes on purpose.
 */
test("the form-control reset says what preflight says, in preflight's values", () => {
  const css = stripComments(globalsCss);
  const at = css.indexOf("button,");
  assert.notEqual(at, -1, "globals.css no longer resets form controls at all");
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  const selector = css.slice(at, open).replace(/\s+/g, " ").trim();
  assert.equal(
    selector,
    "button, input, optgroup, select, textarea",
    "preflight covers these five; a reset that covers fewer leaves one of them to the user agent",
  );

  const declarations: Record<string, string> = {};
  for (const one of css.slice(open + 1, close).split(";")) {
    const colon = one.indexOf(":");
    if (colon === -1) continue;
    declarations[one.slice(0, colon).trim()] = one.slice(colon + 1).trim();
  }

  assert.deepEqual(declarations, {
    "font-family": "inherit",
    "font-feature-settings": "inherit",
    "font-variation-settings": "inherit",
    "font-size": "100%",
    "font-weight": "inherit",
    "line-height": "inherit",
    "letter-spacing": "inherit",
    color: "inherit",
    padding: "0",
  });

  assert.ok(!("margin" in declarations), "margin: 0 moves both checkboxes; see the note above");

  // In the layer, like the border half: a later layer wins whatever the
  // specificity, and this rule is one element name against a utility's class.
  assert.ok(css.lastIndexOf("@layer tokens {", at) !== -1, "the form reset left @layer tokens");
});

/**
 * A recipe that says `border-solid` states a width for all four sides.
 *
 * 🔴 This is the other half of the pair, and the reason preflight is two
 * declarations rather than one. Turning `border-style` on turns it on for all
 * four sides, and the initial `border-*-width` is `medium` — 3px. Measured on
 * the tab strip: the first version of that fix said `border-solid` alone and
 * put a 3px rule along the top of a strip that had asked for one along the
 * bottom.
 *
 * The reset now sets the width to zero globally, so a recipe cannot reach that
 * state through the stand-in. It can still reach it two other ways, which is
 * why this stays: a `border-solid` written into a `style=` attribute or a raw
 * `className`, and the day preflight is switched on with the reset removed and
 * one of them typed by hand. The check is cheap and the failure it names is
 * three pixels of rule down the wrong edge of a card.
 */
test("a recipe that says border-solid states a width for all four sides", () => {
  const width = /^(-?border)(-[xytrbl])?(-\d+)?$/;
  const table = TOKENS as unknown as Record<string, unknown>;
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
  let seen = 0;
  const walkStyles = (value: unknown, path: string) => {
    if (typeof value === "string") {
      const words = value.split(/\s+/).filter(Boolean);
      if (!words.includes("border-solid")) return;
      seen += 1;
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
  // Derived, not remembered: if nothing says `border-solid` any more, the
  // assertion under this is vacuous and has to say so.
  assert.ok(
    seen > 0,
    "no recipe says border-solid at all; this check is measuring nothing",
  );
  assert.deepEqual(
    partial,
    [],
    "a side with no width stated renders at the initial `medium`, which is 3px",
  );
});

/**
 * No border in this console is drawn by `app/globals.css` on a bare element.
 *
 * 🔴 **This was the precondition for deleting the old stylesheet, and it is
 * now the receipt for it.** That stylesheet styled `button`, `input`,
 * `select`, `textarea` and `th, td` by element name, so five recipes looked
 * correct while the thing painting them was the layer being removed. T035
 * measured it with the layer emptied: `th` fell to `none 0px`, and `button`
 * and `input` kept the width and colour their recipes asked for but fell back
 * to the user agent's 3D bevels. It then gave the reset the border style, the
 * zero width and the colour, so all five drew from their own recipes.
 *
 * The layer is gone. Measured across the fifteen pages at 390px and 1100px in
 * both themes, the only border that changed is the one on 40 `<td>` elements,
 * which `TABLE.row` had been sharing a pixel with under `border-collapse` —
 * no row changed height. The derivation is kept and inverted: the answer has
 * to be *nothing*, and a bare-element border added to `globals.css` tomorrow
 * fails here rather than repainting a page nobody is looking at.
 *
 * A declaration that *removes* a border does not count, and neither does the
 * reset's `border-width: 0` — that is the whole point of it.
 */
const LEGACY_BORDERED_ELEMENTS: Record<string, string> = {};

/** The border-giving extractor, over any sheet. */
function borderedElements(rules: { head: string; body: string }[]): Set<string> {
  const BORDER = /^border(-(top|right|bottom|left))?(-(width|style|color))?$/;
  const drawn = new Set<string>();
  for (const { head, body } of rules) {
    if (head.includes("@")) continue;
    const gives = body.split(";").some((one: string) => {
      const colon = one.indexOf(":");
      if (colon === -1) return false;
      const name = one.slice(0, colon).trim();
      const value = one.slice(colon + 1).trim();
      return BORDER.test(name) && value !== "none" && value !== "0" && !/^0\b/.test(value);
    });
    if (!gives) continue;
    for (const selector of head.split(",")) {
      const trimmed = selector.trim();
      // A compound carrying a class, an id or an attribute is not styling the
      // bare element, and `*` is the reset rather than an element.
      if (!trimmed || /[.#[*]/.test(trimmed)) continue;
      const last = trimmed.split(/[\s>+~]+/).pop() ?? "";
      const name = /^([a-z][a-z0-9]*)/.exec(last)?.[1];
      if (name) drawn.add(name);
    }
  }
  return drawn;
}

test("no border in this console is drawn by the stylesheet on a bare element", () => {
  assert.deepEqual(
    [...borderedElements(stylesheetRules())].sort(),
    Object.keys(LEGACY_BORDERED_ELEMENTS).sort(),
    "globals.css gives a bare element a border again, which reaches every one of them",
  );

  // The extractor finds one when there is one to find. Without this, the
  // assertion above passes on a broken regex.
  assert.deepEqual(
    [...borderedElements(rulesOf(PROBE_SHEET))].sort(),
    ["td", "th"],
    "the bare-element border extractor has broken, so the empty answer means nothing",
  );

  // And the five recipes that used to be propped up by it still ask for their
  // own border, which is what makes the empty answer above safe rather than
  // merely true. Each is a path into the recipe table, read here.
  const width = /^(-?border)(-[xytrbl])?(-\d+)?$/;
  const table = TOKENS as unknown as Record<string, unknown>;
  const orphans: string[] = [];
  const drawnByRecipe: Record<string, string> = {
    button: "BUTTON.base",
    input: "FORM.input",
    select: "FORM.select",
    textarea: "FORM.textarea",
    th: "TABLE.headerCell",
    // The cell rule drew the line between rows for this console's whole life.
    // `TABLE.row` draws it now, and it is the only thing drawing it.
    td: "TABLE.row",
  };
  for (const [element, path] of Object.entries(drawnByRecipe)) {
    const recipe = path.split(".").reduce<unknown>((value, key) => {
      return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    }, table);
    if (typeof recipe !== "string") {
      orphans.push(`${element}: ${path} is not a recipe string`);
      continue;
    }
    const words = recipe.split(/\s+/).filter(Boolean);
    if (!words.some((word) => width.test(word) && !/-0$/.test(word))) {
      orphans.push(`${element}: ${path} asks for no border of its own`);
    }
  }
  assert.deepEqual(
    orphans,
    [],
    "this element had its border taken over by a recipe when the stylesheet went; the recipe has stopped asking for it",
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
 * 🔴 T012 called this a third kind of dead class and neither ledger could see
 * it. `card-grid` was a name **no stylesheet defined**. `.risk` was a name
 * declared **only under an ancestor**. `card-span-all` was neither:
 * `.card-span-all { grid-column: 1 / -1 }` was a real, unconditional rule, and
 * it did nothing because every container it was put in was `display: block`.
 *
 * **The ruling this card was asked for, with the geometry behind it.** The
 * claim “it does nothing” is a claim about every container in the console, not
 * only about the pages that carried it, so it was measured that way: under the
 * stylesheet that still had the rule, the class was put on **every element of
 * all fifteen pages**, one class at a time, and every box compared. Nothing
 * moved, at 390px or 1100px. 56 of the 78 class names in that stylesheet did
 * move something under the same treatment, which is what makes the zero a
 * measurement rather than a broken probe. And the direct fact underneath it:
 * across the fifteen pages at both widths there are **0 grid containers**, so
 * `grid-column` had nothing to place.
 *
 * It had referrers to the end — comments in three files and the assertion
 * below — but no element carried it, so it counted as zero-consumer and went
 * with the rest.
 *
 * Derived from the stylesheet rather than listed, so the next rule of this
 * shape is covered the day it is written. It now finds nothing, and the probe
 * underneath is what says so honestly.
 */
/** Class names whose whole rule is grid placement, over any sheet. */
function gridOnlyClasses(rules: { head: string; body: string }[]): Set<string> {
  const names = new Set<string>();
  for (const { head, body } of rules) {
    const declarations = body
      .split(";")
      .map((one: string) => one.trim())
      .filter(Boolean);
    if (declarations.length === 0) continue;
    if (!declarations.every((one: string) => /^grid-(column|row|area)\s*:/.test(one))) continue;
    for (const name of head.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(name[1]);
  }
  return names;
}

test("no file uses a class that only works inside a grid", () => {
  const names = gridOnlyClasses(stylesheetRules());
  assert.deepEqual(
    [...names].sort(),
    [],
    "globals.css has a grid-placement rule again; nothing in this console is a grid container",
  );

  // Derived, not remembered: on a sheet shaped like the deleted one, the same
  // extractor finds the instance it was written for.
  assert.deepEqual(
    [...gridOnlyClasses(rulesOf(PROBE_SHEET))].sort(),
    ["card-span-all"],
    "the grid-only-rule extractor found nothing; every assertion under it is vacuous",
  );

  // The ratchet is kept pointing at both places a class name can come from:
  // a `className` in a `.tsx`, and a recipe in `lib/tokens.ts` that reaches
  // every file using it.
  const offenders: string[] = [];
  for (const relative of MIGRATED_SOURCES) {
    for (const used of classesIn(classListsIn(readSource(relative)))) {
      if (names.has(used)) offenders.push(`${relative}: ${used}`);
    }
  }
  const table = TOKENS as unknown as Record<string, unknown>;
  const inRecipes: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      for (const used of value.split(/\s+/).filter(Boolean)) {
        if (names.has(used.replace(/^[a-z-]+:/, ""))) inRecipes.push(`${path}: ${used}`);
      }
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    }
  };
  for (const name of recipeNames()) walk(table[name], name);

  assert.deepEqual(
    [...offenders, ...inRecipes],
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
 * The danger zone is drawn with a wash and a red heading, not with a border.
 *
 * 🔴 When this was written a red border would not have rendered at all —
 * `CARD.root` asked for a border width and computed to `none 0px`, and shipping
 * markup that reviews as a warning and paints nothing was the exact defect the
 * card was sent to fix on the USB-net button. **That reason has since been
 * removed**: the reset in `app/globals.css` now carries the style, and a border
 * here would draw.
 *
 * The rule stays because the second reason always was the stronger one. What is
 * inside this zone is a row of buttons carrying their own red, and a red field
 * behind red outlines reads as one block of noise. So the check is unchanged
 * and its justification is not: no border here, and everything it does use has
 * to generate CSS.
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
    "a red outline behind a row of red buttons reads as one block of noise",
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

/* ── The status bar and the background it claims to match (T048) ──────── */

// Line endings here are CRLF; every pattern below is written against LF.
const layoutSource = readSource("app/layout.tsx").replace(/\r/g, "");
const themeToggleSource = readSource("components/theme-toggle.tsx").replace(/\r/g, "");

/**
 * The premise the single status bar colour rests on.
 *
 * A served page is dark whatever the reader's system says, because the only
 * route to the light palette is an attribute set by script. The moment this
 * stops being true — someone adds a `prefers-color-scheme` block meaning to be
 * helpful — a served page could be light while `viewport.themeColor` still
 * says dark, and the mismatch T048 removed comes back by a different door. It
 * would show up only on a phone, which is where the last one hid for months.
 */
test("only data-theme reaches the light palette, which is what makes one status bar colour right", () => {
  assert.ok(
    !globalsCss.includes("prefers-color-scheme"),
    "the stylesheet now picks a theme from the system preference, so the served page may be light while app/layout.tsx still declares a dark status bar",
  );
  assert.ok(
    globalsCss.includes(':root[data-theme="light"]'),
    "the light palette lost its attribute selector; nothing can reach it",
  );
});

/**
 * `viewport` is one value, and it is the background that is really painted.
 *
 * It used to be a pair keyed on `prefers-color-scheme`, which described the
 * reader's phone rather than the document: measured in a browser, a light
 * phone got #f7f8fa over the dark login page, and a signed-in reader whose
 * stored choice disagreed with their system got the mismatch the other way
 * round. Read from the token table so a palette change cannot leave a hex
 * behind here.
 */
test("the status bar names the background the server actually paints", () => {
  const viewportBlock = /export const viewport: Viewport = \{[\s\S]*?\n\};/.exec(layoutSource)?.[0];
  assert.ok(viewportBlock, "could not find the viewport export in app/layout.tsx");
  assert.ok(
    !viewportBlock.includes("prefers-color-scheme"),
    "the status bar is keyed on the system preference again, but the stylesheet never is",
  );
  assert.match(
    viewportBlock,
    /themeColor:\s*COLOR_TOKENS\.bg\.dark/,
    "the status bar must be the dark background, the one painted before any script runs",
  );
  for (const hex of [TOKENS.COLOR_TOKENS.bg.dark, TOKENS.COLOR_TOKENS.bg.light]) {
    assert.ok(
      !viewportBlock.includes(hex),
      `${hex} is typed into the viewport instead of read from the token table`,
    );
  }
});

/**
 * The bar has to move when the background does.
 *
 * A static value can only ever describe the served document; the toggle is the
 * one place that knows a reader changed their mind. It reads the colour back
 * out of the stylesheet, so `--bg` keeps a single definition and the bar cannot
 * be left a palette behind.
 */
test("flipping the theme repoints the status bar at the new background", () => {
  const applyEffect = /useEffect\(\(\) => \{\s*if \(!theme\) return;[\s\S]*?\n {2}\}, \[theme\]\);/.exec(
    themeToggleSource,
  )?.[0];
  assert.ok(applyEffect, "could not find the effect that applies the theme");
  assert.match(applyEffect, /dataset\.theme = theme/, "the effect no longer applies the theme");
  assert.match(
    applyEffect,
    /paintStatusBar\(/,
    "the theme changes but the status bar is left on the old background",
  );

  const helper = /function paintStatusBar\([\s\S]*?\n\}/.exec(themeToggleSource)?.[0];
  assert.ok(helper, "paintStatusBar is gone");
  assert.match(helper, /meta\[name="theme-color"\]/, "nothing selects the status bar meta");
  assert.match(
    helper,
    /getPropertyValue\("--bg"\)/,
    "the colour must be read from the stylesheet, not decided here",
  );
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(helper),
    "a hex written into the toggle is another copy of --bg to keep in step",
  );
});
