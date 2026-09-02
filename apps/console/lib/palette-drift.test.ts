import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

/**
 * Every place the palette is copied outside the token files, and one guard
 * that makes each copy say so itself.
 *
 * ## Why this file exists
 *
 * The colours have one home — `lib/tokens.ts`, compiled into `app/globals.css`
 * and checked against it by `lib/tokens.test.ts`. Everything else that paints
 * a colour is a hand-copy, because it is somewhere Tailwind never reaches: a
 * static asset, a drawing, a rasterised bitmap. Three such copies have been
 * found on this board so far, **each one by luck**:
 *
 *  1. `public/offline.html` — six hand-typed hexes across seven paint sites.
 *     Found because somebody happened to be reading the file. Guarded since,
 *     by `OFFLINE_PALETTE` in `lib/pwa.test.ts`.
 *  2. `public/icon.svg` / `icon-maskable.svg` and their five PNG
 *     rasterisations. Found because `lib/pwa.test.ts` happened to have a test
 *     that reads actual pixels — written for a different defect entirely
 *     (icons cropped to their top-left corner by a headless viewport).
 *  3. The edge panel's favicon, `%234ade9b` inside an inline `data:` SVG.
 *     Found on a second pass, because **a `#rrggbb` sweep walks straight past
 *     a URL-encoded hex** and the first pass reported zero.
 *
 * Three accidents, three different disguises, three lucky catches. This file
 * is the fourth catch made on purpose, plus a rule general enough that the
 * fifth disguise is caught by a test rather than by a reader.
 *
 * ## What it guards: drift, not modification
 *
 * Every assertion below compares a copy against **whatever the dark theme
 * currently declares**, never against a literal typed in here. Change a token
 * properly — token file and copies together — and this file stays green.
 * Change one side only and it goes red. A guard that had to be edited on every
 * legitimate palette change would be edited straight out of the repository,
 * which is the reasoning `lib/pwa.test.ts` already wrote down for the offline
 * page and the reason this file reads `app/globals.css` rather than
 * `COLOR_TOKENS`: `lib/tokens.test.ts` owns the `tokens.ts` ⇄ `globals.css`
 * edge, and restating somebody else's check here would make a correctly
 * synchronised change red until every file involved had been touched.
 *
 * ## Note on `package.json`
 *
 * Its `test` script is a hand-written list of files, so this file had to be
 * added to it or it would never run and the pass count would not move — which
 * reads exactly like "no new tests were needed". `lib/tokens.test.ts` and
 * `lib/interpolate.test.ts` both assert that every `lib/*.test.ts` is on the
 * list, so creating this file turns those two red until it is registered.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const readBytes = (...parts: string[]) => readFileSync(join(root, ...parts));

/* ── The source of truth ─────────────────────────────────────────────── */

/**
 * One `:root` block of `app/globals.css`, as the file actually declares it.
 *
 * The dark block is `:root {`; the light one is `:root[data-theme="light"] {`
 * and does not contain that string, so the first hit is always dark. Neither
 * body holds nested braces — the values are hexes and `rgba()` — so the next
 * `}` closes it.
 */
function tokenBlock(selector: string): Map<string, string> {
  const css = readText("app", "globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `globals.css has no \`${selector}\` block — this parser is stale`);
  const body = css.slice(start + selector.length, css.indexOf("}", start));
  const values = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    values.set(name, value.trim());
  }
  // A floor, because an extractor that silently found nothing would make every
  // comparison below vacuous and this whole file would pass reading colours out
  // of an empty map. This is the failure mode the charter calls "a thing you
  // cannot see and a thing that is not there produce identical output".
  assert.ok(values.size > 10, `only ${values.size} custom properties parsed out of ${selector}`);
  return values;
}

const darkTokens = () => tokenBlock(":root {");
const lightTokens = () => tokenBlock(':root[data-theme="light"] {');

/* ── Normalising a colour so two spellings of one value compare equal ─── */

/**
 * The board's own normalisation, and the reason it is not a string compare.
 *
 * Two files spell the same colour differently and always have — `rgba(74, 222,
 * 155, 0.14)` against `rgba(74,222,155,.14)` — so whitespace and a leading zero
 * cannot be allowed to read as drift. Hex case is normalised for the same
 * reason. Nothing else is touched: a real difference in any channel still
 * compares unequal, which is the only property this needs to have.
 */
function normalise(value: string): string {
  let out = value.trim().toLowerCase().replace(/\s+/g, "");
  out = out.replace(/(^|[^0-9])\.(\d)/g, "$10.$2");
  // `#4a9` and `#44aa99` are the same colour to a browser, so they are the same
  // colour here. Without this a shorthand copy would read as a value no token
  // declares and the failure would name the wrong problem.
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(out);
  if (short) out = `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return out;
}

/* ── Copy #2: the icon drawings ──────────────────────────────────────────
 *
 * `lib/pwa.test.ts` reads the five PNG rasterisations and checks their pixels
 * against `COLOR_TOKENS`. It does not check the SVGs the PNGs were rendered
 * from: it uses each SVG only for its *geometry*, to measure where the mark
 * sits. So an SVG whose colour is edited without the PNGs being regenerated
 * passes every test on the board today — and both SVGs ship, `/icon.svg` is
 * in the manifest with `sizes: "any"`, so a browser that prefers vector art
 * would show one palette while a browser that takes the bitmap shows another.
 *
 * `where` is what a failure prints: somewhere a reader can open, rather than a
 * line number that moves the first time the file is edited.
 */
const ICON_PAINT: { file: string; where: string; token: string; read: (svg: string) => string }[] = [
  {
    file: "icon.svg",
    where: "icon.svg <rect fill>",
    token: "--bg",
    read: (svg) => attribute(svg, "rect", "fill"),
  },
  {
    file: "icon.svg",
    where: "icon.svg <path stroke>",
    token: "--brand",
    read: (svg) => attribute(svg, "path", "stroke"),
  },
  {
    file: "icon-maskable.svg",
    where: "icon-maskable.svg <rect fill>",
    token: "--bg",
    read: (svg) => attribute(svg, "rect", "fill"),
  },
  {
    file: "icon-maskable.svg",
    where: "icon-maskable.svg <path stroke>",
    token: "--brand",
    read: (svg) => attribute(svg, "path", "stroke"),
  },
];

/** One attribute off the first element of a kind. Anchored on the tag name so
 *  `stroke-width` cannot answer for `stroke`. */
function attribute(svg: string, tag: string, name: string): string {
  const element = new RegExp(`<${tag}\\b[^>]*>`).exec(svg);
  assert.ok(element, `no <${tag}> in this drawing — this parser is stale`);
  const found = new RegExp(`\\s${name}="([^"]*)"`).exec(element[0]);
  assert.ok(found, `<${tag}> no longer sets \`${name}\` — this parser is stale`);
  return found[1];
}

test("the icon drawings paint with the dark tokens they copy", () => {
  const dark = darkTokens();
  const drifted: string[] = [];
  for (const paint of ICON_PAINT) {
    const declared = dark.get(paint.token);
    assert.ok(declared, `globals.css :root no longer declares ${paint.token}`);
    const painted = paint.read(readText("public", paint.file));
    if (normalise(painted) !== normalise(declared)) {
      drifted.push(`${paint.where} paints ${painted}, but ${paint.token} is now ${declared}`);
    }
  }
  // Listed rather than asserted one at a time, so a palette change that missed
  // several shows all of them in one run.
  assert.deepEqual(
    drifted,
    [],
    "the dark theme moved and the icon drawings did not follow — they are hand-copies, so they have to be edited by hand (and the PNGs regenerated after)",
  );
});

/* ── Copy #4, the one nothing was looking at: the install screenshots ────
 *
 * `public/screenshot-mobile.png` and `public/screenshot-wide.png` are declared
 * in the manifest (`lib/pwa.ts`) and are what Chromium's rich install dialog
 * shows. They are not photographs of anything: `lib/pwa.ts` says outright that
 * they are "rendered from this design system's own tokens with demo data" —
 * which makes them a copy of the entire palette, thirteen values deep, in the
 * one encoding a text scan cannot read at all.
 *
 * What guarded them before this file: `pwa.test.ts`'s "the install dialog has
 * a screenshot of each shape" checks `pngSize` and the aspect ratio. Nothing
 * read a pixel. The five icons are covered by that file's `ICON_SOURCES` map;
 * these two are not in it, and they carry six times as much of the palette as
 * an icon does — an icon is two colours, these are the whole surface ladder,
 * all four text tiers and three of the four status colours.
 *
 * Left alone, a palette change ships an install dialog still advertising the
 * old design, and every test on the board stays green.
 */

/** Full 8-bit PNG decode. Non-interlaced, colour types 0/2/3/4/6. */
function pngPixels(bytes: Buffer): {
  width: number;
  height: number;
  at(x: number, y: number): [number, number, number, number];
} {
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", "not a PNG");
  const chunks: { type: string; data: Buffer }[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    chunks.push({ type: bytes.toString("ascii", at + 4, at + 8), data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  const ihdr = chunks.find((c) => c.type === "IHDR")?.data;
  assert.ok(ihdr, "no IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.equal(ihdr[8], 8, "only 8-bit PNGs are read here");
  assert.equal(ihdr[12], 0, "interlaced PNG");
  const colour = ihdr[9];
  const samples = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
  assert.ok(samples, `unsupported colour type ${colour}`);
  const plte = chunks.find((c) => c.type === "PLTE")?.data;
  const trns = chunks.find((c) => c.type === "tRNS")?.data;

  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * samples;
  const out = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = raw.subarray(read, read + stride);
    read += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= samples ? row[x - samples] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= samples ? prev[x - samples] : 0;
      const v = line[x];
      row[x] =
        (filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c)) & 0xff;
    }
  }
  return {
    width,
    height,
    at(x, y) {
      const i = y * stride + x * samples;
      if (colour === 2) return [out[i], out[i + 1], out[i + 2], 255];
      if (colour === 6) return [out[i], out[i + 1], out[i + 2], out[i + 3]];
      if (colour === 0) return [out[i], out[i], out[i], 255];
      if (colour === 4) return [out[i], out[i], out[i], out[i + 1]];
      const k = out[i];
      assert.ok(plte, "indexed PNG with no palette");
      return [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], trns ? (trns[k] ?? 255) : 255];
    },
  };
}

/** How many pixels of each exact colour a bitmap contains. Opaque pixels only:
 *  a fully transparent one carries no colour to compare against anything. */
function histogram(name: string): Map<string, number> {
  const image = pngPixels(readBytes("public", name));
  const counts = new Map<string, number>();
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b, a] = image.at(x, y);
      if (a === 0) continue;
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  // A decoder that produced one colour, or none, would satisfy nothing below
  // while looking like agreement. These are screenshots of a real interface;
  // they have hundreds of antialiased shades.
  assert.ok(counts.size > 100, `${name} decoded to ${counts.size} distinct colours — the decoder is broken`);
  return counts;
}

const SCREENSHOTS = ["screenshot-mobile.png", "screenshot-wide.png"];

test("the install screenshots are painted on the dark theme's current canvas", () => {
  const dark = darkTokens();
  const wanted = ["--bg", "--surface"].map((token) => {
    const value = dark.get(token);
    assert.ok(value, `globals.css :root no longer declares ${token}`);
    return normalise(value);
  });

  const stale: string[] = [];
  for (const name of SCREENSHOTS) {
    const counts = histogram(name);
    // The two flat fills that cover the whole interface. In both files they are
    // 61% and 28-32% of the image against 1.7% for the next colour down, so
    // "the largest two" is not a close call that antialiasing could tip — and
    // it is the claim worth making, because those two are the canvas and the
    // card, the design's whole first impression.
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([hex]) => normalise(hex))
      .sort();
    if (JSON.stringify(top) !== JSON.stringify([...wanted].sort())) {
      stale.push(`${name} is mostly ${top.join(" and ")}, but --bg/--surface are now ${wanted.join(" and ")}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    "the palette moved and public/screenshot-*.png did not — these are rasterised, so they have to be re-rendered, and until they are the install dialog advertises the old design",
  );
});

test("the install screenshots still carry the rest of the dark ramp", () => {
  const dark = darkTokens();
  // Everything below covers at least 599 pixels in both files today; a floor of
  // 100 leaves the tightest of them a factor of six. `--surface-raised` is
  // deliberately absent: it is 23 pixels in one file and none in the other, so
  // pinning it would be pinning noise. Measured, not assumed —
  // `scratchpad/t012/png-report.json` has the counts.
  const FLOOR = 100;
  const missing: string[] = [];
  for (const name of SCREENSHOTS) {
    const counts = histogram(name);
    for (const token of ["--line", "--fg", "--fg-muted", "--brand"]) {
      const value = dark.get(token);
      assert.ok(value, `globals.css :root no longer declares ${token}`);
      const seen = counts.get(normalise(value)) ?? 0;
      if (seen < FLOOR) missing.push(`${name} has ${seen}px of ${token} (${value}), needs ${FLOOR}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "a colour the dark theme declares has gone missing from the install screenshots — re-render them",
  );
});

/* ── The general rule, so the fifth disguise is caught by a test ─────────
 *
 * Everything above names a copy. Naming copies is how the first three were
 * handled and it is why each took an accident to find: the list only ever
 * contains what somebody already knew about.
 *
 * This is the sweep instead. Every shipped source file under `app/`,
 * `components/` and `public/` is read, every colour literal in it is pulled
 * out in **any** encoding, and each one has to be a value the theme currently
 * declares. A copy added tomorrow, in a file nobody thought of, is covered
 * without anyone remembering to come back here.
 *
 * ## The encodings, and why the list is this long
 *
 * A `#rrggbb` sweep is what walked past the edge favicon twice. `%234ade9b` is
 * the same colour and shares no substring with it. So are `&#35;4ade9b`,
 * `\23 4ade9b`, `rgb(74 222 155)`, `oklch(...)`, `hsl(...)` and `0x4ade9b`.
 * Each form here was proved visible against a fixture containing a known
 * specimen of it before being trusted to report zero — a scan that cannot see
 * a form and a repository that does not contain it produce identical output.
 *
 * ## What is excluded, and why each one is not a hole
 *
 *  - `app/globals.css` is the source of truth, not a copy of it.
 *  - `lib/` is not swept at all: `lib/tokens.ts` is the other half of the
 *    source of truth, and `lib/tokens.test.ts` and this file have to be able
 *    to write colours down in order to reject them — the same reason
 *    `tailwind.config.ts` names `./lib/tokens.ts` instead of globbing `./lib`.
 *  - Nothing else. `public/offline.html` is swept even though
 *    `lib/pwa.test.ts` owns its named paint sites, because that file strips
 *    comments before its multiset check and this one does not.
 */

const SWEPT_EXTENSIONS = [".ts", ".tsx", ".css", ".svg", ".html", ".js"];
const NOT_A_COPY = ["app/globals.css"];

/** Every shipped source file that could hold a hand-typed colour. */
function sweptFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (SWEPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(path);
    }
  };
  for (const dir of ["app", "components", "public"]) walk(dir);
  return out.filter((path) => !NOT_A_COPY.includes(path));
}

/**
 * Every colour literal in a piece of text, in every encoding one can wear.
 *
 * `%23` is decoded rather than matched separately so that a `data:` URI is
 * read as the markup it is; that single substitution is what the edge favicon
 * needed and did not have.
 */
function colourLiterals(text: string): string[] {
  const decoded = text
    .replace(/%23/gi, "#")
    .replace(/&#(?:35|x23);/gi, "#")
    .replace(/\\0{0,4}23\s/g, "#");
  const forms = [
    // Six and eight digits are unambiguous. Three digits are not: `*#100#` is
    // a USSD code, and this repository has real ones. A three-digit run is
    // only read as a colour when nothing on either side marks it as a dialled
    // string — no `*` in front, no `#` or further digit behind. That was found
    // by the negative control below going red, not reasoned about in advance.
    /#(?:[0-9a-f]{8}|[0-9a-f]{6})\b/gi,
    /(?<![*\d])#[0-9a-f]{3}(?![#\d0-9a-f])/gi,
    /\brgba?\([^)]{1,80}\)/gi,
    /\b(?:oklch|oklab|hsla?|lab|lch|hwb)\([^)]{1,80}\)/gi,
    /\bcolor-mix\([^)]{1,120}\)/gi,
    /\b0x[0-9a-f]{6}\b/gi,
  ];
  const out: string[] = [];
  for (const form of forms) for (const match of decoded.matchAll(form)) out.push(match[0]);
  return out;
}

test("no colour is written into a shipped file that the theme does not declare", () => {
  const declared = new Set<string>();
  for (const block of [darkTokens(), lightTokens()]) {
    for (const value of block.values()) declared.add(normalise(value));
  }
  // Both themes, because a copy is allowed to be either one's colour; and
  // `--shadow`'s `rgba(0, 0, 0, 0.35)` is in here too, which is correct — a
  // shadow is a colour decision like any other.
  assert.ok(declared.size > 20, `only ${declared.size} distinct token values — the extractor broke`);

  const files = sweptFiles();
  // A walk that returned nothing, or only the files with no colour in them,
  // would pass this test while measuring nothing.
  assert.ok(files.length >= 20, `only ${files.length} files swept — the walk is broken`);

  const foreign: string[] = [];
  let examined = 0;
  for (const path of files) {
    for (const literal of colourLiterals(readText(...path.split("/")))) {
      examined++;
      if (!declared.has(normalise(literal))) foreign.push(`${path}: ${literal}`);
    }
  }
  // The sweep has to actually be finding colours. Today it reads 17 of them
  // across offline.html, the two drawings and one prose comment; if a refactor
  // moved every one of those the sweep would go quiet and keep passing.
  assert.ok(examined >= 10, `the sweep found only ${examined} colour literals — it has gone blind`);

  assert.deepEqual(
    foreign,
    [],
    "a colour is written down somewhere that ships, and it is not one app/globals.css declares — either the theme moved and this copy did not follow, or a new hand-copy was added with nothing keeping it honest",
  );
});

/**
 * The sweep is only worth its comment if it can see each disguise. This proves
 * it against specimens, in the same code path, so that the zero above means
 * "there are none" rather than "the scan is blind".
 */
test("the sweep can see a colour in every encoding it claims to cover", () => {
  const specimens: [string, string][] = [
    ["bare hex", "background: #4ade9b;"],
    ["uppercase hex", "background: #4ADE9B;"],
    ["shorthand hex", "background: #4a9;"],
    ["url-encoded hex, the one that got past two passes", "href=\"data:image/svg+xml,%3Crect%20fill%3D'%234ade9b'/%3E\""],
    ["html entity hex", '<rect fill="&#35;4ade9b"/>'],
    ["css escape hex", 'content: "\\23 4ade9b";'],
    ["rgba, spaced", "--x: rgba(74, 222, 155, 0.14);"],
    ["rgba, tight", "--x: rgba(74,222,155,.14);"],
    ["oklch", "--x: oklch(0.82 0.15 158);"],
    ["hsl", "--x: hsl(152, 68%, 58%);"],
    ["color-mix", "--x: color-mix(in srgb, #4ade9b 14%, transparent);"],
    ["packed hex integer", "const accent = 0x4ade9b;"],
  ];
  const blind = specimens.filter(([, text]) => colourLiterals(text).length === 0).map(([name]) => name);
  assert.deepEqual(blind, [], "the sweep reports zero on these because it cannot see them, not because they are absent");

  // The negative half. A "scanner" that returned a hit for everything would
  // pass the line above and be worthless; these carry no colour and must come
  // back empty. `*#100#` is a real USSD code in `lib/catalog.test.ts` and the
  // shape a careless three-digit-hex rule reports as a colour.
  const notColours = ['code: "*#100#"', "const at = [1, 3, 5];", "// the transition is green", "#region", "id=\"#top\""];
  const overeager = notColours.filter((text) => colourLiterals(text).length > 0);
  assert.deepEqual(overeager, [], "the sweep is reporting colours in text that has none");
});
