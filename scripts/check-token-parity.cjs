/*
 * ============================================================================
 * The design tokens, both ends: cloud `apps/console/app/globals.css` against
 * edge `edge-panel/src/index.html`, token by token.
 *
 * WHY THIS EXISTS
 *
 * The two surfaces share a visual language, and the edge panel copies the
 * names and values by hand — it is one self-contained HTML file in a different
 * repository, with no build step and no npm, because it has to be servable by
 * a Rust binary with no toolchain on the box.
 *
 * The cost is that the two blocks drift, and the drift is silent. Neither
 * repository can read the other: each CI checks out one tree. Until T020 there
 * was no check between them at all, while five comments in four files said
 * there was — they had read "oracle ①", a board acceptance criterion judged
 * once against deployed artifacts, as the name of a running check.
 *
 * This script is the check those comments should have been describing. It is
 * the same shape as `scripts/sync-contract.sh`, and for the same reason: a
 * cross-repo invariant can only be scored where both trees are present.
 *
 * WHAT RUNS IT  (SN-T024 — this paragraph used to say nothing did)
 *
 * The `tokens` job in .github/workflows/ci.yml, on every push and pull
 * request to this repository. It clones the edge repository into a sibling
 * directory and passes both roots explicitly. Both repositories are public, so
 * no credential, deploy key or secret is involved — the same shape the edge
 * repository's own CI already uses to materialise its read-only vowifi-go
 * mirror beside $GITHUB_WORKSPACE.
 *
 * 🔴 What that job does NOT cover, so that nobody reads more into it: it fires
 * on CLOUD activity. A one-sided drift committed to the edge repository is not
 * seen until the next push here. And it reads edge `main`, so a token change
 * that has to move both ends must land on the EDGE side first — see
 * deploy/RUNBOOK.md, "Design tokens live in two repositories".
 *
 * "Nothing runs it automatically" was true from T020 until T024, and the four
 * comments quoting that sentence (globals.css, lib/tokens.ts x2,
 * lib/tokens.test.ts) are now stale in the harmless direction — they undersell
 * the coverage rather than invent it. They still need correcting.
 *
 * USAGE
 *   node scripts/check-token-parity.cjs <cloudRoot> <edgeRoot>
 *                                       [--mutate-cloud <tok>=<val>]
 *                                       [--mutate-edge  <tok>=<val>]
 *
 *   🔴 Both roots are REQUIRED. There are no defaults — see the block above
 *   the argument parsing for the false green that removing them closed.
 *
 *   --mutate-cloud / --mutate-edge are the built-in negative controls. They
 *   edit an in-memory copy of one side only, never a file, and the run must go
 *   red. One per side, so both directions can be demonstrated.
 *
 * EXIT CODES  (🔴 the 2 is load-bearing — see below)
 *   0  parity holds
 *   1  parity is broken: the two ends really disagree
 *   2  the check could not run at all (no roots given, a tree is missing, a
 *      block will not parse, the allowlist is malformed)
 *
 * 🔴 Why 1 and 2 must differ: the tool this replaces threw an uncaught ENOENT
 * and exited 1 when pointed at a missing edge tree — the same code it used for
 * real drift, so "could not run" and "the ends have drifted" were
 * indistinguishable. That is the mirror image of the trap that hid
 * `verify-vendor-mirror.sh` never running for weeks: there an exit 2 read as
 * "ran and failed", here an exit 1 read as "ran and found drift".
 * `sync-contract.sh:20-23` already had this right. Copied.
 *
 * SUPERSEDES scratchpad/sn-t001/radius-parity-sn.cjs, which is now retired and
 * exits 2 pointing here. Two comparators that can score the same oracle
 * differently must not both exist (charter). The provenance printing, the Pico
 * guard, the `canon()` form and the load-bearing positional-argument guard are
 * carried over from it verbatim or near-verbatim.
 * ============================================================================
 */
"use strict";
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");

/* ── how the two blocks are allowed to differ ───────────────────────────────
 *
 * The rule is NOT "both ends declare the same set of tokens". That criterion
 * is impossible: it would be red today with both ends correct, because each
 * surface legitimately has roles the other has no use for. A criterion that
 * cannot pass manufactures false failures just as surely as one that cannot
 * fail waves real ones through.
 *
 * The rule is: SHARED VOCABULARY = every name declared in either block, minus
 * the entries below. The vocabulary is derived from the two files on every
 * run, never hand-listed, so a token added to both ends joins it automatically
 * and a token added to one end is caught by construction.
 *
 * 🔴 Every exemption carries a reason, and the reason is checked for
 * existence. An exemption without a written reason is the next defect.
 * Exemptions are also checked for rot: one naming a token that has since
 * appeared at both ends, or vanished from both, fails. A stale exemption is a
 * hole that nobody can see.
 */
const ONE_SIDED = {
  "--rail": {
    side: "edge",
    reason:
      "panel-only geometry: width of the fixed left rail. The panel is a three-column deck with fixed rails so the middle column is the one that gives; the console has no such layout.",
  },
  "--logs": {
    side: "edge",
    reason:
      "panel-only geometry: width of the log column, the last column to collapse because it is the one the operator is watching.",
  },
  "--bar": {
    side: "edge",
    reason: "panel-only geometry: height of the panel status bar. The console has no equivalent surface.",
  },
  "--font-eyebrow": {
    side: "edge",
    reason:
      "panel-only: a monospace stack with CJK fallbacks for the eyebrow labels. The console sets eyebrow type through Tailwind recipes instead of a token.",
  },
  "--fg-accent": {
    side: "cloud",
    reason:
      "console-only role: the accent when it is being read as text rather than filled. The panel never reads its accent as text.",
  },
  "--accent-edge": {
    side: "cloud",
    reason:
      "console-only role: the accent as a non-text edge, held to the 3:1 bar WCAG 1.4.11 sets rather than to a text tier.",
  },
  "--bad-ink": {
    side: "cloud",
    reason:
      "console-only role: the ink on the one solid button filled with the status red. The panel has no filled-red control.",
  },
};

/* Names that MUST be present at both ends. This is a floor, not the set being
 * checked — the shared vocabulary above is derived, and these names are
 * already in it. The floor exists so that an extraction which silently
 * returned an empty map cannot pass vacuously: with no floor, "every shared
 * name agrees" is trivially true of nothing at all. */
const MUST_EXIST = [
  "--radius-base", "--radius", "--radius-md", "--radius-lg", "--radius-pill",
  "--touch",
];

/* ── arguments ─────────────────────────────────────────────────────────────*/
const argv = process.argv.slice(2);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
const MUTATE_EDGE = flagValue("--mutate-edge");
const MUTATE_CLOUD = flagValue("--mutate-cloud");

/* 🔴 Carried over from the retired tool, where it was load-bearing and had
 * already caused one silent misread. A flag's VALUE is a positional-looking
 * token: without excluding both the flag and the value, `--mutate-edge x=y`
 * with no paths leaves `x=y` as argv[0] and it becomes the cloud root. The
 * index guards must tolerate "flag absent" (indexOf -> -1) without excluding
 * argv[0], which is why each is written as `i < 0 || ...` rather than relying
 * on arithmetic against -1. */
const excluded = new Set();
for (const f of ["--mutate-edge", "--mutate-cloud"]) {
  const i = argv.indexOf(f);
  if (i >= 0) { excluded.add(i); excluded.add(i + 1); }
}
const positional = argv.filter((a, i) => !a.startsWith("--") && !excluded.has(i));

/** Could not run. Distinct from "ran and found drift". */
function cannotRun(msg) {
  console.error(`cannot run: ${msg}`);
  console.error("");
  console.error("usage: node scripts/check-token-parity.cjs <cloudRoot> <edgeRoot>");
  console.error("       both roots are required; there are no defaults");
  process.exit(2);
}

/* 🔴 BOTH ROOTS ARE REQUIRED. (SN-T024)
 *
 * Two hardcoded absolute paths used to sit here as defaults, naming one
 * workstation's two main trees. They were a false-green generator, and they
 * failed in both directions at once:
 *
 *   · anywhere those paths do not exist — every Linux runner — the script
 *     exited 2 on the first read. In that form it had never once run.
 *   · on the machine where they did exist it ran from ANY directory and
 *     silently scored the two MAIN trees. Measured: a throwaway copy with
 *     `--touch` genuinely broken at one end scored PARITY OK, exit 0, because
 *     the copy was never what it read. This repository has 30 worktrees and
 *     every one of them inherited that.
 *
 * 🔴 The worse half is what the defaults did to evidence. Someone who ran the
 * no-argument form while editing the main trees got correct answers — by luck,
 * not by design, and with nothing in the output to tell the two apart. That is
 * this board's recurring shape: a probe returning a perfect pass on the wrong
 * object. The fix is the same one the board keeps arriving at — make the tool
 * name what it read, and refuse to guess.
 *
 * ⚠️ `--edge <path>` is not accepted and never was, though a card recommended
 * it: `--edge` is dropped by the `startsWith("--")` filter and its value falls
 * through as positional[0], i.e. it would have set the CLOUD root and left the
 * edge on the default. That form now exits 2 instead of scoring the wrong pair.
 */
if (positional.length !== 2) {
  cannotRun(
    positional.length === 0
      ? "no roots given. Pass both explicitly; there are no default paths.\n" +
          "            A default scores whichever trees it was written for, not the ones you are in."
      : `expected exactly 2 roots, got ${positional.length}: ${JSON.stringify(positional)}`,
  );
}

/* Absolute and normalised, so the banner names the real tree rather than
 * whatever relative form the caller typed. `$GITHUB_WORKSPACE/../vodoge-edge`
 * and `.` are both legitimate to pass, and neither is legible in a CI log. */
const CLOUD_ROOT = path.resolve(positional[0]);
const EDGE_ROOT = path.resolve(positional[1]);

const CLOUD = path.join(CLOUD_ROOT, "apps/console/app/globals.css");
const EDGE = path.join(EDGE_ROOT, "edge-panel/src/index.html");

/* ── provenance ────────────────────────────────────────────────────────────
 * A linked worktree has a .git FILE, the main worktree a .git DIRECTORY. That
 * distinction needs no git call, so it still works from WSL, where `git -C` on
 * a .wt-* dir exits 128 because the .git file holds a Windows absolute path.
 * The git calls are best-effort and never fatal. */
function provenance(root) {
  let kind = "unknown";
  try {
    kind = fs.statSync(path.join(root, ".git")).isDirectory() ? "MAIN TREE" : "LINKED WORKTREE";
  } catch { /* not a git root at all */ }
  let head = "";
  try {
    const q = (a) =>
      cp.execSync(`git -C "${root}" ${a}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    head = `  HEAD ${q("rev-parse --short HEAD")} [${q("rev-parse --abbrev-ref HEAD")}]`;
  } catch { head = "  (git could not be queried from here)"; }
  const warn =
    kind === "LINKED WORKTREE"
      ? "\n       ⚠️  this is a pinned worktree, NOT main — confirm it is the tree you meant"
      : "";
  return `${kind}${head}${warn}`;
}

/* ── parsing ───────────────────────────────────────────────────────────────*/

/* Canonical form, carried over verbatim from the retired comparator so that
 * retiring it cannot change any score: strip whitespace, .14 -> 0.14, hex
 * lowercased, trailing zeros inside rgba() trimmed so 0.140 == 0.14. Stripping
 * all whitespace is also what makes the multi-line font stacks compare equal
 * despite differing continuation indents. */
const canon = (v) =>
  v.toLowerCase().replace(/\s+/g, "")
    .replace(/(^|[(,])\./g, "$10.")
    .replace(/([\d.]+)0+(?=[,)])/g, (m, d) => (d.includes(".") ? d.replace(/0+$/, "").replace(/\.$/, "") : m));

/* 🔴 Comments are stripped before declarations are read. The blocks at both
 * ends carry long prose comments that mention token names, and this file's own
 * card rewrote several of them. A comment that happened to contain
 * `--name: value;` would otherwise be parsed as a declaration — a phantom
 * token, present at one end only, failing a check for a token nobody
 * declared. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** Custom properties declared in one block, first declaration wins. */
function declarations(body) {
  const out = new Map();
  for (const m of stripComments(body).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const name = m[1].trim();
    if (!out.has(name)) out.set(name, m[2].trim().replace(/\s+/g, " "));
  }
  return out;
}

function cloudDarkRoot(text) {
  const start = text.indexOf(":root {");
  const end = text.indexOf(':root[data-theme="light"]');
  if (start < 0 || end < 0) cannotRun(`cannot find the cloud dark :root block in ${CLOUD}`);
  return declarations(text.slice(start, end));
}

function edgeRoot(text) {
  /* The VoDoge token block, not Pico's. Pico is inlined and minified above it
   * and declares a --pico-border-radius of its own; picking that up by mistake
   * would compare this console against a vendored framework. */
  const start = text.search(/:root\s*\{[^}]*--bg\s*:/);
  if (start < 0) cannotRun(`cannot find the edge VoDoge :root block in ${EDGE}`);
  const end = text.indexOf("}", start);
  const found = declarations(text.slice(start, end));
  const pico = [...found.keys()].filter((n) => n.startsWith("--pico-"));
  if (pico.length > 0) cannotRun(`parsed Pico's block by mistake: ${pico.slice(0, 3).join(" ")}`);
  return found;
}

/* ── provenance, printed BEFORE anything is read ───────────────────────────
 * 🔴 SN-T024: this block used to sit after both files had been read and
 * parsed, which meant the one run that needs it most — the run that cannot
 * happen at all — never reached it. Two absolute paths and two HEADs, first,
 * always. When the next line says `cannot run`, you can still see which pair
 * of trees the answer was about.
 *
 * This is the only thing that ever caught the old defaults, and it is the same
 * rule this board applies to browser probes: make the instrument assert what
 * it is pointed at, in its own output. */
console.log(`cloud  ${CLOUD}`);
console.log(`       ${provenance(CLOUD_ROOT)}`);
console.log(`edge   ${EDGE}`);
console.log(`       ${provenance(EDGE_ROOT)}`);
console.log("");

/* ── read both trees ───────────────────────────────────────────────────────*/
function readOrDie(p, what) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    cannotRun(`${what} not readable at ${p}\n            (${err.code || err.message})`);
  }
}

let cloudText = readOrDie(CLOUD, "the cloud stylesheet");
let edgeText = readOrDie(EDGE, "the edge panel");

/** In-memory only. Never writes a file. */
function applyMutation(text, spec, label) {
  const eq = spec.indexOf("=");
  if (eq < 0) cannotRun(`${label} needs <token>=<value>, got "${spec}"`);
  const tok = spec.slice(0, eq);
  const val = spec.slice(eq + 1);
  const re = new RegExp(`(${tok}\\s*:\\s*)([^;]+)(;)`);
  if (!re.test(text)) cannotRun(`${label} could not find ${tok}`);
  console.log(`[negative control] ${label} ${tok} forced to ${val} — in memory only, no file written`);
  return text.replace(re, `$1${val}$3`);
}
if (MUTATE_CLOUD) cloudText = applyMutation(cloudText, MUTATE_CLOUD, "cloud");
if (MUTATE_EDGE) edgeText = applyMutation(edgeText, MUTATE_EDGE, "edge");
if (MUTATE_CLOUD || MUTATE_EDGE) console.log("");

const cloud = cloudDarkRoot(cloudText);
const edge = edgeRoot(edgeText);

console.log(`cloud  ${cloud.size} custom properties in the dark :root`);
console.log(`edge   ${edge.size} custom properties in the VoDoge :root`);
console.log("");

/* ── scoring ───────────────────────────────────────────────────────────────*/
const failures = [];

/* (0) the floor. */
for (const name of MUST_EXIST) {
  if (!cloud.has(name)) failures.push(`FLOOR          ${name} is not declared in the cloud block at all`);
  if (!edge.has(name)) failures.push(`FLOOR          ${name} is not declared in the edge block at all`);
}

/* (1) exemptions must be justified, and must not have rotted. */
for (const [name, entry] of Object.entries(ONE_SIDED)) {
  if (!entry || typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
    failures.push(`EXEMPT-NO-REASON  ${name}: an exemption without a written reason is the next defect`);
    continue;
  }
  if (entry.side !== "cloud" && entry.side !== "edge") {
    failures.push(`EXEMPT-BAD-SIDE   ${name}: side must be "cloud" or "edge", got ${JSON.stringify(entry.side)}`);
    continue;
  }
  const inCloud = cloud.has(name);
  const inEdge = edge.has(name);
  if (inCloud && inEdge) {
    failures.push(`EXEMPT-STALE      ${name}: now declared at BOTH ends — delete the exemption so it is checked`);
  } else if (!inCloud && !inEdge) {
    failures.push(`EXEMPT-DEAD       ${name}: declared at NEITHER end — delete the exemption`);
  } else {
    const actual = inCloud ? "cloud" : "edge";
    if (entry.side !== actual) {
      failures.push(`EXEMPT-WRONG-SIDE ${name}: exemption says ${entry.side}, but it is declared only in ${actual}`);
    }
  }
}

/* (2) the derived shared vocabulary must agree at both ends. */
const sharedVocab = [...new Set([...cloud.keys(), ...edge.keys()])]
  .filter((n) => !(n in ONE_SIDED))
  .sort();

let exact = 0;
let normalised = 0;
for (const name of sharedVocab) {
  const inCloud = cloud.has(name);
  const inEdge = edge.has(name);
  if (!inCloud) {
    failures.push(
      `MISSING-IN-CLOUD  ${name}: declared in the edge panel only. Add it to the cloud block, or exempt it with a reason.`,
    );
    continue;
  }
  if (!inEdge) {
    failures.push(
      `MISSING-IN-EDGE   ${name}: declared in the cloud console only. Add it to the edge block, or exempt it with a reason.`,
    );
    continue;
  }
  const a = cloud.get(name);
  const b = edge.get(name);
  if (a === b) exact++;
  else if (canon(a) === canon(b)) normalised++;
  else failures.push(`VALUE-DRIFT       ${name}: cloud "${a}" vs edge "${b}"`);
}

console.log(`shared vocabulary: ${sharedVocab.length} names, derived from both blocks`);
console.log(`  identical .................... ${exact}`);
console.log(`  equal after normalising ...... ${normalised}   (the edge writes .14 where the cloud writes 0.14)`);
console.log(`exempt as one-sided: ${Object.keys(ONE_SIDED).length}   (each with a written reason, each re-checked above)`);
console.log("");

if (failures.length === 0) {
  console.log("PARITY OK — every shared token is declared at both ends with the same value.");
  process.exit(0);
}
console.log(`PARITY FAILED — ${failures.length} problem(s):`);
for (const f of failures) console.log(`  🔴 ${f}`);
process.exit(1);
