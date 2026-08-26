import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MISSING_KEY_PATTERN,
  catalogs,
  diffCatalogKeys,
  interpolate,
  t,
} from "./i18n.ts";

test("missing translation keys are detectable", () => {
  const missing = t("no.such.key", "zh");
  assert.match(missing, MISSING_KEY_PATTERN);
  assert.equal(missing, "⟦no.such.key⟧");
});

test("t interpolates placeholders from the active locale", () => {
  assert.equal(
    interpolate("use {slug}.{domain}", { slug: "a", domain: "vodoge.com" }),
    "use a.vodoge.com",
  );
  assert.equal(t("app.name", "en"), "VoDoge");
  assert.equal(t("nav.devices", "zh"), "设备");
});

test("diffCatalogKeys reports keys present on only one side", () => {
  const diff = diffCatalogKeys(
    { "app.name": "VoDoge", "nav.devices": "设备" },
    { "app.name": "VoDoge", "nav.login": "Log in" },
  );
  assert.deepEqual(diff.missingInRight, ["nav.devices"]);
  assert.deepEqual(diff.missingInLeft, ["nav.login"]);
});

/**
 * Every catalogue key the device page names is really in both catalogues.
 *
 * Read out of the page's source rather than restated here. A list retyped into
 * a test agrees with whatever the test's author believed, which is the failure
 * this project has already shipped once: a bundle that rendered 未读 as
 * `æœªè¯»` passed typecheck and 41 tests, because the literals in the tests
 * were the same corrupt bytes as the literals under test.
 *
 * The type gate on DeviceLabelKey covers the other direction — a control that
 * reads a label the page does not supply is a compile error. What it cannot
 * see is a key that is spelled consistently in both places and exists in
 * neither catalogue, or in only one of them. That is what this catches.
 */
test("every catalogue key the device page names resolves in both locales", () => {
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "app", "devices", "[deviceId]", "page.tsx"),
    "utf8",
  );
  const keys = [...page.matchAll(/"([a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(keys)].sort();

  // A guard against the extraction quietly stopping: if a reformat breaks the
  // pattern this test would pass by checking nothing at all.
  assert.ok(unique.length >= 60, `only extracted ${unique.length} keys from the device page`);

  const unresolved = unique.filter(
    (key) => MISSING_KEY_PATTERN.test(t(key, "zh")) || MISSING_KEY_PATTERN.test(t(key, "en")),
  );
  assert.deepEqual(unresolved, []);
});

// The seven USSD stage explanations are the ones most easily left half-done:
// they were added together, they are only ever reached through a lookup, and
// a stage nobody has seen in production renders a blank line if its string is
// missing. check-i18n proves the two locales match each other; this proves
// they are not matching by both being absent.
test("the USSD session strings exist and differ between locales", () => {
  const keys = [
    "device.ussdSession",
    "device.ussdSessionModem",
    "device.ussdReply",
    "device.ussdContinue",
    "device.ussdExpired",
    "device.ussdStageComplete",
    "device.ussdStageNeedsReply",
    "device.ussdStageTerminated",
    "device.ussdStageOtherClient",
    "device.ussdStageNotSupported",
    "device.ussdStageNetworkTimeout",
    "device.ussdStageOther",
  ];
  for (const key of keys) {
    const zh = t(key, "zh");
    const en = t(key, "en");
    assert.doesNotMatch(zh, MISSING_KEY_PATTERN, key);
    assert.doesNotMatch(en, MISSING_KEY_PATTERN, key);
    // Copying the English into zh.json is how a catalogue passes a key-parity
    // check while leaving half the panel untranslated.
    assert.notEqual(zh, en, key);
  }
});

/*
 * ---------------------------------------------------------------------------
 * The language the server actually renders in.
 *
 * The bug these guard against shipped twice. A client component looked its
 * strings up with `t(key, locale)` where `locale` was
 * `useState<Locale>(DEFAULT_LOCALE)`, corrected from the cookie inside an
 * effect -- that is, after hydration. The server has no cookie state and runs
 * no effects, so the HTML it emitted said the default language (zh) for those
 * strings on every request, whatever `<html lang>` claimed and whatever the
 * visitor had chosen. The page then corrected itself in the browser, which is
 * precisely why nobody saw it: reading the live DOM shows the corrected text.
 * Only fetching the response without executing JavaScript shows what was sent.
 *
 * What is asserted here is the source-level invariant a correct server render
 * depends on -- a client component is handed its locale, it does not go
 * looking for one -- and not the rendered HTML itself. That distinction is
 * real, and the reason for it is a repository fact rather than a preference:
 * there is no way to render a component in this test suite. devDependencies
 * carry @types/node, @types/react, @types/react-dom and typescript and nothing
 * else; `node --test --experimental-strip-types` erases type annotations and
 * does not transform JSX, so a .tsx file cannot even be imported here.
 * Rendering one means adding a JSX-capable runner, which is a dependency
 * decision and not this change's to make.
 *
 * So this is a proxy, and the gap is worth being exact about. It cannot see a
 * component that is handed the right locale and then draws the wrong language
 * with it. It does see every instance of the defect that actually shipped, in
 * both panels it shipped in, and it fails on the source as it stood before
 * this fix.
 * ---------------------------------------------------------------------------
 */

/** Where a client component sources a locale instead of being handed one. */
type LocaleEscape = { line: number; rule: string };

/** One `t(...)` call site: its key where that is a literal, and its argument count. */
type TranslationCall = { line: number; key: string | null; args: number };

/**
 * The source with comment bodies blanked out, line numbers preserved.
 *
 * Necessary rather than fastidious: esim-panel.tsx documents this very defect
 * and quotes `useState(DEFAULT_LOCALE)` in its prose. A scanner that reads
 * comments would report the fix as the bug.
 */
function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    // Strings are kept whole and opaque: a quote or a slash inside one is not
    // punctuation, and the one template literal in this tree holds `path=/;`.
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        const closed = source[i] === ch;
        i += 1;
        if (closed) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The top-level arguments of the call whose `(` sits at `open`, or null if unbalanced. */
function callArguments(code: string, open: number): string[] | null {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let i = open + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === ch) break;
        j += 1;
      }
      current += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ")" && depth === 0) {
      if (current.trim() !== "" || parts.length > 0) parts.push(current);
      return parts;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  return null;
}

/** Every `t(...)` in comment-stripped source. */
function translationCalls(code: string): TranslationCall[] {
  const calls: TranslationCall[] = [];
  const opener = /(^|[^A-Za-z0-9_$.])t\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(code)) !== null) {
    const open = (match.index ?? 0) + match[0].length - 1;
    opener.lastIndex = open + 1;
    const args = callArguments(code, open);
    if (args === null) continue;
    const literal = /^\s*"([^"\\]*)"\s*$/.exec(args[0] ?? "");
    calls.push({
      line: code.slice(0, open).split("\n").length,
      key: literal ? literal[1] : null,
      args: args.length,
    });
  }
  return calls;
}

/**
 * Every place a "use client" module sources a locale from something the server
 * cannot see. Empty for a module that is not a client component.
 */
function localeEscapes(source: string): LocaleEscape[] {
  const code = withoutComments(source);
  if (!isClientModule(code)) return [];
  const found: LocaleEscape[] = [];
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;

  // The only way to hold a Locale without having been handed one.
  for (const m of code.matchAll(/\bDEFAULT_LOCALE\b/g)) {
    found.push({ line: lineOf(m.index ?? 0), rule: "names DEFAULT_LOCALE" });
  }
  // Writing it is the language switch's whole job. Reading it back to decide
  // what language to draw is the defect, because the server already read it
  // and rendered from it.
  for (const m of code.matchAll(/\bdocument\s*\.\s*cookie\b/g)) {
    const after = code.slice((m.index ?? 0) + m[0].length);
    if (/^\s*=[^=]/.test(after)) continue;
    found.push({ line: lineOf(m.index ?? 0), rule: "reads document.cookie" });
  }
  // State is by definition not available to the render the server performs.
  for (const m of code.matchAll(/\buseState\s*<\s*Locale\s*>/g)) {
    found.push({ line: lineOf(m.index ?? 0), rule: "holds the locale in state" });
  }
  // t(key) with the locale left off silently means t(key, DEFAULT_LOCALE).
  for (const call of translationCalls(code)) {
    if (call.args < 2) {
      found.push({ line: call.line, rule: "calls t() without a locale" });
    }
  }
  return found.sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule));
}

function isClientModule(code: string): boolean {
  return /^\s*["']use client["']/.test(code);
}

const CONSOLE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every .tsx under app/ and components/, as [console-relative path, source]. */
function componentSources(): [string, string][] {
  const out: [string, string][] = [];
  for (const dir of ["app", "components"]) {
    const base = join(CONSOLE_ROOT, dir);
    for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
      const full = join(entry.parentPath ?? base, entry.name);
      out.push([relative(CONSOLE_ROOT, full).split(sep).join("/"), readFileSync(full, "utf8")]);
    }
  }
  return out.sort(([left], [right]) => left.localeCompare(right));
}

test("no client component sources its own locale", () => {
  const sources = componentSources();
  const clients = sources.filter(([, source]) => isClientModule(withoutComments(source)));

  // Without a floor, this test passes loudest when the walk finds nothing.
  assert.ok(sources.length >= 20, `only walked ${sources.length} .tsx files`);
  assert.ok(clients.length >= 10, `only found ${clients.length} client components`);

  const offences = sources.flatMap(([path, source]) =>
    localeEscapes(source).map((escape) => `${path}:${escape.line} ${escape.rule}`),
  );
  assert.deepEqual(offences, []);
});

test("the locale scanner still recognises the defect it was written for", () => {
  // The shape components/device-console.tsx had before this fix. Kept as a
  // fixture because the scan above goes quiet once the tree is clean, and a
  // guard that cannot be shown to fire is not a guard.
  const before = [
    '"use client";',
    'import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, t, type Locale } from "@/lib/i18n";',
    "export function Panel() {",
    "  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);",
    "  useEffect(() => { setLocale(localeFromCookie(document.cookie)); }, []);",
    '  return <p>{t("role.readOnlyDevice", locale)}</p>;',
    "}",
  ].join("\n");
  assert.deepEqual(localeEscapes(before), [
    { line: 2, rule: "names DEFAULT_LOCALE" },
    { line: 4, rule: "holds the locale in state" },
    { line: 4, rule: "names DEFAULT_LOCALE" },
    { line: 5, rule: "reads document.cookie" },
  ]);

  // A locale that arrived as a prop is the entire point, and must stay quiet.
  const after = [
    '"use client";',
    'import { t, type Locale } from "@/lib/i18n";',
    "export function Panel({ locale }: { locale: Locale }) {",
    '  return <p>{t("role.readOnlyDevice", locale)}</p>;',
    "}",
  ].join("\n");
  assert.deepEqual(localeEscapes(after), []);

  // Writing the cookie is what the language switch is for; that is not a read.
  const writer = [
    '"use client";',
    'import { LOCALE_COOKIE, t, type Locale } from "@/lib/i18n";',
    "export function Switch({ locale }: { locale: Locale }) {",
    "  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/`;",
    '  return <span>{t("header.language", locale)}</span>;',
    "}",
  ].join("\n");
  assert.deepEqual(localeEscapes(writer), []);

  // t(key) with no second argument resolves to DEFAULT_LOCALE inside t().
  assert.deepEqual(
    localeEscapes(['"use client";', 'export const x = () => t("app.name");'].join("\n")),
    [{ line: 2, rule: "calls t() without a locale" }],
  );

  // A server component may do as it likes: it has the request in hand.
  assert.deepEqual(localeEscapes('export const x = () => t("app.name");'), []);

  // Prose about the defect is not the defect. esim-panel.tsx quotes it.
  assert.deepEqual(
    localeEscapes(
      ['"use client";', "/* was useState(DEFAULT_LOCALE), read from document.cookie */"].join("\n"),
    ),
    [],
  );
});

test("every catalogue key a component asks t() for exists in both locales", () => {
  const asked = new Map<string, string>();
  for (const [path, source] of componentSources()) {
    for (const call of translationCalls(withoutComments(source))) {
      if (call.key !== null) asked.set(call.key, `${path}:${call.line}`);
    }
  }

  // The device page test above reads quoted literals out of one file. This
  // reads call sites across every component, which is the only thing that says
  // the panels -- where the strings actually are -- can resolve what they ask
  // for. The floor is here for the same reason it is there: a reformat that
  // breaks the extraction would otherwise turn this into an empty assertion.
  assert.ok(asked.size >= 150, `only extracted ${asked.size} keys from the components`);

  const unresolved = [...asked]
    .filter(([key]) => MISSING_KEY_PATTERN.test(t(key, "zh")) || MISSING_KEY_PATTERN.test(t(key, "en")))
    .map(([key, where]) => `${where} ${key}`)
    .sort();
  assert.deepEqual(unresolved, []);
});

/*
 * ---------------------------------------------------------------------------
 * Keeping the catalogue off every route.
 *
 * `app/layout.tsx` wraps every page, so whatever its client components import,
 * every page downloads. Three of them used to call `t()`, which put
 * `lib/i18n.ts` — and both message catalogues welded to it, one chunk of
 * 27.7 kB gzipped — into the layout's client graph. Measured on this tree:
 * /audit's real cost was 150.2 kB gzipped while `next build` reported 102 kB,
 * because that column omits the root layout's chunks.
 *
 * The repair is that those three take finished strings as props. What follows
 * is what stops it from being undone by an import that looks harmless.
 * ---------------------------------------------------------------------------
 */

/** The client components `app/layout.tsx` mounts on every route. */
const LAYOUT_CLIENT_COMPONENTS = [
  join("components", "connection-status.tsx"),
  join("components", "pwa.tsx"),
  join("components", "locale-switch.tsx"),
];

/** Import lines that reach the catalogue-bearing module, comments excluded. */
function catalogueImportLines(source: string): string[] {
  return withoutComments(source)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^import\b[^;]*from\s+"@\/lib\/i18n"/.test(line));
}

test("nothing the root layout mounts on the client imports the catalogue module", () => {
  const offenders: string[] = [];
  for (const file of LAYOUT_CLIENT_COMPONENTS) {
    const source = readFileSync(join(CONSOLE_ROOT, file), "utf8");
    // If one of these stops being a client component the rule still holds, but
    // it is no longer the rule this test was written for, and silence would be
    // the wrong answer.
    assert.ok(
      isClientModule(withoutComments(source)),
      `${file} is no longer a client module; this guard is aimed at the wrong file`,
    );
    for (const line of catalogueImportLines(source)) offenders.push(`${file}: ${line}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these put both catalogues back on every route in the console: ${offenders.join(" | ")}`,
  );

  // Negative control. A reader that only ever says yes proves nothing, so the
  // same function must find the defect in a file shaped like the old ones, and
  // must not be fooled by the prose in the real files, which discusses
  // `@/lib/i18n` at length precisely because that import is what they avoid.
  assert.deepEqual(
    catalogueImportLines('"use client";\nimport { t, type Locale } from "@/lib/i18n";'),
    ['import { t, type Locale } from "@/lib/i18n";'],
  );
  assert.deepEqual(
    catalogueImportLines('"use client";\n// import { t } from "@/lib/i18n";'),
    [],
  );
  assert.deepEqual(
    catalogueImportLines('"use client";\nimport { LOCALE_COOKIE } from "@/lib/locale";'),
    [],
  );
});

/**
 * `lib/locale.ts` is only worth having while it stays empty of catalogue.
 *
 * It exists because webpack ties the catalogues to the *module* that imports
 * them, not to the exports that read them: while `LOCALE_COOKIE` and
 * `htmlLang` were declared in `lib/i18n.ts`, a client component that wanted
 * the cookie's name downloaded both catalogues to get it. Measured: taking
 * `t()` out of all three layout client components moved /audit by 0.1 kB;
 * moving those two declarations into this module moved it by 27.7 kB.
 *
 * An import of anything at all here can reconnect that edge, so the rule is
 * the same one `lib/interpolate.ts` lives under.
 */
test("lib/locale.ts reaches no catalogue, directly or through i18n", () => {
  const code = readFileSync(join(CONSOLE_ROOT, "lib", "locale.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");

  const specifiers = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    specifiers,
    [],
    `lib/locale.ts must import nothing; it imports ${specifiers.join(", ")}`,
  );
  for (const forbidden of ["messages/", "i18n", "import(", "require("]) {
    assert.ok(
      !code.includes(forbidden),
      `lib/locale.ts reaches "${forbidden}"; the split it exists for is gone`,
    );
  }
});

/**
 * Nothing was deleted to make the bundle smaller.
 *
 * This is the assertion that would have caught the cheap version of this
 * change. Shortening the banners, merging the two install wordings into one,
 * or dropping the consequence sentence from a confirmation would all shrink
 * the payload, and all of them are the wrong trade: those sentences are the
 * safety design. The keys are read out of the catalogue by prefix rather than
 * listed here, so a key added to a catalogue is covered the day it is added
 * and nobody has to remember to update a list.
 */
test("every string the layout's client components show is still rendered somewhere", () => {
  const prefixes = ["connection.", "pwa.install.", "header.lang"];
  const owed = Object.keys(catalogs.zh as Record<string, string>)
    .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
    .sort();
  // A floor, because this test passes loudest if the prefixes stop matching.
  assert.ok(owed.length >= 12, `only ${owed.length} keys matched ${prefixes.join(", ")}`);

  const asked = new Set<string>();
  for (const [, source] of componentSources()) {
    for (const call of translationCalls(withoutComments(source))) {
      if (call.key !== null) asked.add(call.key);
    }
  }

  const dropped = owed.filter((key) => !asked.has(key));
  assert.deepEqual(
    dropped,
    [],
    `in the catalogue but nothing renders them any more: ${dropped.join(", ")}`,
  );

  // Negative control: the same lookup must be able to report a key as gone.
  assert.deepEqual(
    ["connection.thisKeyDoesNotExist"].filter((key) => !asked.has(key)),
    ["connection.thisKeyDoesNotExist"],
  );
});

/*
 * ---------------------------------------------------------------------------
 * The source link.
 *
 * T091 licensed the edge repository and T038 licensed this one; nothing said
 * so on the page anyone actually visits. The links added to the shell are the
 * whole of that change, which makes it exactly the kind of change that rots
 * quietly: a string in a catalogue nobody renders, a URL that was translated,
 * or a licence link that points at the wrong repository.
 *
 * Both tests read the catalogue rather than restating it. A list of keys
 * retyped here would agree with whatever its author believed, which is the
 * failure this repository has already shipped once.
 * ---------------------------------------------------------------------------
 */

/** Every source.* key, taken from the catalogue rather than named here. */
function sourceKeys(): string[] {
  return Object.keys(catalogs.zh as Record<string, string>)
    .filter((key) => key.startsWith("source."))
    .sort();
}

test("the source URLs are one URL, not one per locale", () => {
  const zh = catalogs.zh as Record<string, string>;
  const en = catalogs.en as Record<string, string>;
  const urlKeys = sourceKeys().filter((key) => key.endsWith("Url"));

  // Without a floor this passes loudest when the keys are gone.
  assert.ok(urlKeys.length >= 4, `only found ${urlKeys.length} source URL keys`);

  // A URL is not prose. Holding it in the catalogue is how it stays out of the
  // markup, but it also means two copies of it -- and a typo in the locale the
  // people who wrote it do not read is a dead link nobody here would ever see.
  // check-i18n compares keys, never values, so it cannot catch this.
  const faults: string[] = [];
  for (const key of urlKeys) {
    if (zh[key] !== en[key]) {
      faults.push(`${key}: zh has ${zh[key]}, en has ${en[key]}`);
    }
    // Parsed, not pattern-matched. new URL() normalises, so a stray space or
    // a missing scheme comes back as a different string than the catalogue
    // holds, and a relative href never parses at all.
    let parsed: URL | null = null;
    try {
      parsed = new URL(zh[key] ?? "");
    } catch {
      parsed = null;
    }
    if (parsed === null || parsed.protocol !== "https:" || parsed.href !== zh[key]) {
      faults.push(`${key}: not an absolute https URL: ${JSON.stringify(zh[key])}`);
    }
  }
  assert.deepEqual(faults, []);
});

test("a server component renders every source.* string, so JavaScript-off sees the link", () => {
  const keys = new Set(sourceKeys());
  assert.ok(keys.size >= 9, `only found ${keys.size} source keys`);

  // Two failures at once. A string that no component asks for is a link that
  // exists only in a JSON file; a string asked for only by a "use client"
  // module is a link that needs hydration to appear, and the deployed-page
  // check for this card is a fetch that runs no JavaScript. Where the link is
  // rendered is therefore part of what was asked for, not an implementation
  // detail.
  const renderedBy = new Map<string, string[]>();
  for (const [file, source] of componentSources()) {
    const code = withoutComments(source);
    const kind = isClientModule(code) ? "client" : "server";
    for (const call of translationCalls(code)) {
      if (call.key === null || !keys.has(call.key)) continue;
      renderedBy.set(call.key, [...(renderedBy.get(call.key) ?? []), `${file} (${kind})`]);
    }
  }

  const missing = [...keys]
    .filter((key) => !(renderedBy.get(key) ?? []).some((where) => where.endsWith("(server)")))
    .map((key) => `${key} -> ${(renderedBy.get(key) ?? ["nowhere"]).join(", ")}`)
    .sort();
  assert.deepEqual(missing, []);
});

/**
 * Every repository the footer names links its own terms, inside itself.
 *
 * The first version of this footer linked one licence -- the edge
 * repository's -- because at the time this repository declared none. That is
 * no longer true, and what it leaves behind fails silently in both
 * directions. A repository that is linked with no licence beside it reads as
 * "nobody has said", which is now wrong. A licence URL copied from the
 * neighbouring pair reads as a confident wrong answer, and every test above
 * passes it: source.consoleLicenseUrl pointing at vodoge-edge's LICENSE is
 * absolute https, byte-identical across locales, and server-rendered. It
 * would simply tell every visitor the wrong terms -- and the two repositories
 * genuinely differ, so being wrong about which one you are reading is not a
 * cosmetic error.
 *
 * The pairing is derived from the catalogue rather than restated here:
 * source.<name>Url is a repository, and source.<name>LicenseUrl has to live
 * under that repository.
 */
test("every repository the footer links states its own terms, in its own repository", () => {
  const zh = catalogs.zh as Record<string, string>;
  const urlKeys = sourceKeys().filter((key) => key.endsWith("Url"));
  const repoKeys = urlKeys.filter((key) => !key.endsWith("LicenseUrl"));

  // Two repositories are linked: this one and the edge. Without a floor this
  // passes loudest when the pairs have been deleted.
  assert.ok(repoKeys.length >= 2, `only found ${repoKeys.length} repository URL keys`);

  const faults: string[] = [];
  for (const repoKey of repoKeys) {
    const licenceKey = `${repoKey.slice(0, -"Url".length)}LicenseUrl`;
    const repoUrl = zh[repoKey];
    const licenceUrl = zh[licenceKey];
    if (licenceUrl === undefined) {
      faults.push(`${repoKey} is linked, but ${licenceKey} does not exist`);
      continue;
    }
    if (!licenceUrl.startsWith(`${repoUrl}/`)) {
      faults.push(`${licenceKey} (${licenceUrl}) is not inside ${repoKey} (${repoUrl})`);
    }
  }
  assert.deepEqual(faults, []);
});
