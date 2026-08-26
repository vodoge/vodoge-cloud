import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { interpolate as interpolateViaI18n } from "./i18n.ts";
import { interpolate } from "./interpolate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...parts: string[]): string =>
  readFileSync(join(root, ...parts), "utf8");

/**
 * What this file is defending, in one number.
 *
 * `lib/i18n.ts` imports both catalogues at the top level as real runtime
 * values. Any client component that imported anything from it used to drag all
 * 632 x 2 strings — one webpack chunk, 74.6 kB raw, 26.5 kB gzipped — into
 * that route's First Load JS, whether or not it ever called `t()`.
 *
 * Measured on this tree with `next build`, `.next` deleted before each run:
 *
 *   route             before   after
 *   /proxy            148 kB   121 kB
 *   /inbox            149 kB   122 kB
 *   /inbox/[peer]     149 kB   122 kB
 *
 * Two changes were needed and neither works alone — each was built on its own
 * and each left every number in that table unchanged:
 *
 *   1. `interpolate` in its own catalogue-free module, re-exported from
 *      `lib/i18n.ts`, so webpack can follow the specifier past the catalogues;
 *   2. `"sideEffects"` in `package.json`, so webpack is allowed to drop the two
 *      JSON modules once nothing reaches them.
 *
 * Both are one line, and both are the kind of line a later edit removes without
 * noticing, because nothing in the app stops working when they go — the bytes
 * just come back. That is what the source assertions below are for.
 */

test("interpolate fills placeholders from the variables it is given", () => {
  assert.equal(
    interpolate("use {slug}.{domain}", { slug: "a", domain: "vodoge.com" }),
    "use a.vodoge.com",
  );
  assert.equal(interpolate("no placeholders", { slug: "a" }), "no placeholders");
  assert.equal(interpolate("{a} {a}", { a: "twice" }), "twice twice");
});

test("interpolate with no variables returns the template unchanged", () => {
  assert.equal(interpolate("{name} will be removed"), "{name} will be removed");
});

/**
 * The consequence sentences on destructive controls are the reason this
 * function exists: they name the row the operator clicked. A placeholder with
 * nothing to fill it therefore has to stay visible rather than blank out, or a
 * sentence that lost its object ("this removes  from the tenant") reads as
 * finished while saying less than its author wrote.
 */
test("an unfilled placeholder stays visible instead of blanking out", () => {
  assert.equal(interpolate("removes {name}", {}), "removes {name}");
  assert.equal(interpolate("removes {name}", { other: "x" }), "removes {name}");
  assert.equal(
    interpolate("removes {name}", { name: undefined as unknown as string }),
    "removes {name}",
  );
});

test("zero and the empty string are values, not absences", () => {
  assert.equal(interpolate("{count} left", { count: 0 }), "0 left");
  assert.equal(interpolate("[{name}]", { name: "" }), "[]");
});

/**
 * The re-export has to be the same function, not a copy.
 *
 * `components/conversation.tsx`, `components/proxy-manager.tsx` and
 * `components/send-sms.tsx` write `import { interpolate } from "@/lib/i18n"`
 * today. If the re-export were ever replaced by a second implementation kept
 * in `lib/i18n.ts`, both spellings would still compile and still pass their own
 * tests while drifting apart on escaping — this repo has already paid once for
 * a second implementation of something it already had.
 */
test("the interpolate reached through lib/i18n.ts is this same function", () => {
  assert.equal(interpolateViaI18n, interpolate);
});

test("lib/interpolate.ts reaches no catalogue, directly or through i18n", () => {
  // The comments in that file discuss `messages/zh.json` and `lib/i18n.ts` at
  // length, which is why they say what the module is for. Only the code is
  // scanned, or this test would be a rule against explaining the rule.
  const code = read("lib", "interpolate.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");

  const specifiers = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    specifiers,
    [],
    `lib/interpolate.ts must import nothing; it imports ${specifiers.join(", ")}`,
  );
  for (const forbidden of ["messages/", "i18n", "import(", "require("]) {
    assert.ok(
      !code.includes(forbidden),
      `lib/interpolate.ts reaches "${forbidden}"; the split it exists for is gone`,
    );
  }
});

/**
 * The three client components that ask `lib/i18n.ts` for interpolation only.
 *
 * Adding `t` to any of these imports is legal and is sometimes right, but it
 * puts the 26.5 kB catalogue chunk back into that component's route. That is a
 * decision worth 27 kB on `/proxy` and on both `/inbox` routes, so it should be
 * made against this number rather than found in a build table months later.
 */
test("the interpolate-only client components stay interpolate-only", () => {
  const interpolateOnly = [
    join("components", "conversation.tsx"),
    join("components", "proxy-manager.tsx"),
    join("components", "send-sms.tsx"),
  ];
  const offenders: string[] = [];
  for (const file of interpolateOnly) {
    const source = readFileSync(join(root, file), "utf8");
    const line = source
      .split("\n")
      .find((candidate) => candidate.includes('from "@/lib/i18n"'));
    assert.ok(line, `${file} no longer imports from @/lib/i18n at all`);
    const bindings = (line.match(/\{([^}]*)\}/)?.[1] ?? "")
      .split(",")
      .map((binding) => binding.trim())
      .filter(Boolean);
    if (bindings.join(",") !== "interpolate") {
      offenders.push(`${file}: ${bindings.join(", ") || line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these now pull the whole catalogue into their route: ${offenders.join(" | ")}`,
  );
});

/**
 * `sideEffects` is half the fix, and it is the half with no visible symptom.
 *
 * Without it webpack keeps both JSON modules in every chunk that touches
 * `lib/i18n.ts`, even when nothing reads them: measured on this tree, dropping
 * this field alone put `/proxy` back from 121 kB to 148 kB with nothing else
 * changed and no test failing.
 *
 * Only stylesheets may be listed. `app/globals.css` is imported for its effect
 * and nothing imports a binding from it, so a bare `false` here would let
 * webpack drop the console's entire stylesheet.
 */
test("package.json still lets webpack drop the unreached catalogues", () => {
  const pkg = JSON.parse(read("package.json")) as { sideEffects?: unknown };
  assert.ok(
    Array.isArray(pkg.sideEffects),
    "package.json must declare sideEffects as an array; without it both message catalogues return to every route that touches lib/i18n.ts (+27 kB on /proxy and /inbox, measured)",
  );
  const entries = pkg.sideEffects as string[];
  assert.ok(entries.length > 0, "sideEffects: [] would drop app/globals.css");
  assert.deepEqual(
    entries.filter((entry) => !entry.endsWith(".css")),
    [],
    "only stylesheets belong in sideEffects; a .ts entry here re-imports the catalogues",
  );
});

/**
 * The test script is a hand-written list of files, so a test file can exist,
 * pass, and never run.
 *
 * That is not hypothetical. `lib/i18n.test.ts` — ten tests, including the one
 * that checks every catalogue key the device page names — was written, was
 * green, and was missing from the list. The suite reported 256 passing tests
 * without it. This assertion is what keeps the next one from hiding.
 */
test("every lib/*.test.ts file is actually in the test script", () => {
  const pkg = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.test;
  const onDisk = readdirSync(join(root, "lib"))
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
  assert.ok(onDisk.length >= 10, `only found ${onDisk.length} test files in lib/`);
  const unrun = onDisk.filter((name) => !script.includes(`lib/${name}`));
  assert.deepEqual(unrun, [], `written but never run: ${unrun.join(", ")}`);
});

/**
 * `MessageKey` is an intersection, and it has to stay one.
 *
 * `keyof typeof zh & keyof typeof en` is what stops a key added to one
 * catalogue alone from widening the type, so the first `t("...")` naming it is
 * a compile error rather than a `⟦key⟧` an English-speaking operator finds in
 * production. A union, or `string`, would type-check every call site and check
 * nothing.
 *
 * Proven by mutation rather than by belief: `scratchpad/t039/`'s
 * `messagekey-mutation.cjs` copies both catalogues, adds a key to the zh copy
 * only, and runs `tsc --noEmit` over a copy of this module. It fails with the
 * intersection and passes once the intersection is relaxed to a union.
 */
test("lib/i18n.ts still declares MessageKey as an intersection", () => {
  const declares = (source: string): boolean =>
    /type\s+MessageKey\s*=\s*keyof\s+typeof\s+(?:zh|en)\s*&\s*keyof\s+typeof\s+(?:zh|en)\s*;/.test(
      source,
    );

  assert.ok(
    declares(read("lib", "i18n.ts")),
    "MessageKey is no longer an intersection of both catalogues",
  );

  // Negative control: the same reader has to reject the defect it exists for.
  assert.equal(
    declares("export type MessageKey = keyof typeof zh | keyof typeof en;"),
    false,
    "the reader accepts a union, so it would not have caught the real defect",
  );
  assert.equal(
    declares("export type MessageKey = string;"),
    false,
    "the reader accepts string, so it would not have caught the real defect",
  );
});

/**
 * Nothing shrank the copy to save bytes.
 *
 * This card exists because two catalogues cost 26.5 kB gzipped on the client,
 * and the cheapest way to make that number smaller is to shorten the forty
 * per-action consequence sentences T011 wrote. Those sentences are the safety
 * design; how they are transported is what this card was allowed to change.
 *
 * The floors below are the sizes at the moment the transport was fixed. They
 * may be lowered — a page really does get deleted sometimes — but only on
 * purpose and with the reason written down, which is the whole point of their
 * being here rather than nowhere.
 */
test("neither catalogue lost keys or characters", () => {
  const floors: Record<string, { keys: number; chars: number }> = {
    "zh.json": { keys: 632, chars: 9152 },
    "en.json": { keys: 632, chars: 24916 },
  };
  for (const [file, floor] of Object.entries(floors)) {
    const catalog = JSON.parse(read("messages", file)) as Record<string, string>;
    const keys = Object.keys(catalog).length;
    const chars = Object.values(catalog).join("").length;
    assert.ok(
      keys >= floor.keys,
      `${file} has ${keys} keys, down from ${floor.keys}: a key was deleted`,
    );
    assert.ok(
      chars >= floor.chars,
      `${file} holds ${chars} characters of copy, down from ${floor.chars}: text was shortened or removed`,
    );
  }
});
