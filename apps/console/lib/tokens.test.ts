import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import tailwindConfig from "../tailwind.config.ts";
import { cn } from "./cn.ts";
import {
  BADGE,
  BUTTON,
  CARD,
  FORBIDDEN_IN_MIGRATED_SOURCES,
  LEGACY_UTILITY_COLLISIONS,
  MIGRATED_SOURCES,
  NON_UTILITY_CLASSES,
  PAGE,
  TABLE,
  TAILWIND_BORDER_RADIUS,
  TAILWIND_BOX_SHADOW,
  TAILWIND_COLORS,
  TAILWIND_FONT_FAMILY,
  TAILWIND_FONT_SIZE,
  TAILWIND_SPACING,
  badgeClass,
  buttonClass,
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
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const globalsCss = readFileSync(join(root, "app", "globals.css"), "utf8");

/* ── Reading CSS ─────────────────────────────────────────────────────── */

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
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

/** String literals inside a balanced `(`…`)` or `{`…`}` starting at `open`. */
function literalsInBalanced(source: string, open: number, closer: string): string[] {
  const opener = source[open];
  const literals: string[] = [];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const end = source.indexOf(ch, i + 1);
      if (end === -1) break;
      literals.push(source.slice(i + 1, end));
      i = end;
    }
  }
  return literals;
}

/**
 * Class lists written into a `.tsx`.
 *
 * Two shapes only: `className="…"`, and a string passed straight to `cn(…)`.
 * Anything else — a message key, a URL — is not a class list, and guessing
 * would make this check noisy enough to be switched off.
 */
function classListsIn(source: string): string[] {
  const lists: string[] = [];
  for (const match of source.matchAll(/className\s*=\s*"([^"]*)"/g)) lists.push(match[1]);
  for (const match of source.matchAll(/\bcn\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    lists.push(...literalsInBalanced(source, open, ")"));
  }
  return lists;
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

/** Every class the recipes and the migrated files between them ask for. */
function allUsedClasses(): string[] {
  const lists: string[] = [
    ...Object.values(PAGE),
    ...Object.values(CARD),
    ...Object.values(TABLE),
    BUTTON.base,
    ...Object.values(BUTTON.variant),
    ...Object.values(BUTTON.size),
    BADGE.base,
    BADGE.dot,
    ...Object.values(BADGE.tone),
  ];
  for (const relative of MIGRATED_SOURCES) lists.push(...classListsIn(readSource(relative)));
  return classesIn(lists);
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
  const legacy = blockBody(stripComments(globalsCss), "@layer legacy {");
  const names = new Set<string>();
  for (const chunk of legacy.matchAll(/([^{}]+)\{/g)) {
    for (const match of chunk[1].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(match[1]);
  }
  assert.ok(names.size > 40, `only ${names.size} legacy classes found — the extractor is broken`);

  const generated = await generatedClasses([...names]);
  const collisions = [...names].filter((name) => generated.has(name)).sort();
  assert.deepEqual(collisions, [...LEGACY_UTILITY_COLLISIONS].sort());
});

test("migrated files carry no class from the old stylesheet", () => {
  const legacy = blockBody(stripComments(globalsCss), "@layer legacy {");
  const legacyNames = new Set<string>();
  for (const chunk of legacy.matchAll(/([^{}]+)\{/g)) {
    for (const match of chunk[1].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) legacyNames.add(match[1]);
  }
  // The three names Tailwind also generates are utilities in a migrated file,
  // not legacy classes; the dangerous two are rejected by their own test.
  for (const shared of LEGACY_UTILITY_COLLISIONS) legacyNames.delete(shared);

  const offenders = allUsedClasses().filter((name) => legacyNames.has(name));
  assert.deepEqual(offenders, [], `still reading the old stylesheet: ${offenders.join(", ")}`);
});

test("the shared components hold no class strings of their own", () => {
  for (const relative of MIGRATED_SOURCES) {
    if (!relative.startsWith("components/ui/")) continue;
    const source = readSource(relative);
    assert.ok(
      !/className\s*=\s*"/.test(source),
      `${relative} writes a class inline; it belongs in lib/tokens.ts where it can be tested`,
    );
    assert.match(source, /from "@\/lib\/tokens"/, `${relative} does not read the recipes`);
  }
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
