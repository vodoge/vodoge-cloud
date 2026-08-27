'use strict';
/*
 * SN-T031 : lone-CR guard.
 *
 * A "lone CR" is a 0x0D byte that is NOT immediately followed by 0x0A.
 * This guard fails if any TRACKED TEXT FILE in the given repositories
 * contains one that has not been explicitly and defensibly exempted.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE BYTE IS WORTH A GUARD
 * ---------------------------------------------------------------------------
 * Proven by controlled A/B in SN-T025. Under Windows git with
 * core.autocrlf=true, a single lone CR anywhere in a file does three things at
 * once:
 *
 *   1. It silently switches OFF end-of-line normalisation for the WHOLE file.
 *      Same content, same config, the only variable a single \r:
 *        A  CRLF worktree, cr=0  ->  blob is LF        (normalisation ON)
 *        B  CRLF worktree, cr=1  ->  blob is CRLF      (normalisation OFF)
 *   2. It makes git classify the file as BINARY (`i/-text w/-text`), so
 *      `git diff` degrades to "Binary files differ".
 *   3. Nothing reports any of this. `git status` stays clean.
 *
 * Observed cost: commit 62f4b6dd wrote a 7428-line diff of which only 116
 * lines were semantic -- 7312 lines were end-of-line churn only. Both parents
 * were normalised LF blobs; the merge itself wrote the un-normalised content.
 * The seed was one stray \r after an array bracket.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARD CANNOT SEE -- READ THIS BEFORE TRUSTING IT
 * ---------------------------------------------------------------------------
 * This guard detects lone CR bytes in the WORKING TREE. There is an entire
 * class of end-of-line damage it does NOT detect, and that no commit-level
 * detector can detect. It is not a gap in this implementation; it is a
 * property of the configuration.
 *
 *   Running `sed -i` (or any LF-rewriting tool) on a CRLF file that has NO
 *   lone CR converts the working tree to LF and produces a BYTE-IDENTICAL
 *   BLOB and an EMPTY `git status`.
 *
 * Measured (SN-T025, two arms):
 *
 *   arm                sed -i result    blob before   blob after    oid moved?
 *   no lone CR         worktree LF      7a0cc4e4b8    7a0cc4e4b8    NO
 *   has lone CR        worktree MIXED   4b8fd93580    03c4dd7f46    yes
 *
 * Consequences you must not talk yourself out of:
 *
 *   - A GREEN result from this guard does NOT mean "no end-of-line conversion
 *     happened". It means "no unexempted lone CR is present right now".
 *   - `git status` being clean is NOT evidence that a file was not converted.
 *     It is guaranteed to be clean in exactly this case.
 *   - Scanning history cannot recover these events. They left no trace to find.
 *
 * What this guard DOES buy: the invisible class above is self-limiting,
 * because it is precisely the class that leaves the repository normalised.
 * The damaging class -- the one that turns normalisation off, flips a file to
 * binary, and lets thousands of lines of churn ride into a merge -- is exactly
 * the class that requires a lone CR. This guard closes that one. It closes it
 * completely and it closes nothing else.
 *
 * ---------------------------------------------------------------------------
 * EXEMPTIONS -- BECAUSE A LONE CR IS NOT ALWAYS DAMAGE
 * ---------------------------------------------------------------------------
 * At least one file in this project holds lone CRs that are the SUBJECT MATTER
 * rather than the defect: a note pasting captured terminal output in which
 * bash and dash echo the offending CR back as the subject of the message --
 *
 *     verify-vendor-mirror.sh: 31: <CR>: not found
 *     ... line 75: `elif [ -d "$mirror_root/vowifi-go.git" ]; then<CR>'
 *
 * Delete those bytes and the first message loses its subject entirely, and the
 * second quotes a line whose syntax error now has no visible cause. That is
 * not a repair, it is fabricating output no shell ever produced.
 *
 * So the criterion is not "no lone CR". It is "no lone CR that nobody has
 * given a reason for". A file declares its own exemption, in itself:
 *
 *     lone-cr-exemption: begin          <- must be alone on a line, column 0
 *     reason: <at least MIN_REASON characters saying why deleting would destroy
 *       something, continued on indented lines as needed>
 *     exempt-line: <the exact text of the line the CR sits on, with each
 *       lone CR written as the four characters <CR>>
 *     lone-cr-exemption: end
 *
 * Four properties make this an exemption rather than a hole, and each one is
 * covered by a --self-test case:
 *
 *   1. IT IS A PROPERTY OF THE FILE, NOT A PATH IN THIS SCRIPT. The next
 *      transcript that legitimately captures control bytes declares itself and
 *      needs no edit here. Nothing in this file names any repository path.
 *   2. IT IS PER LINE, NOT PER FILE. An exemption is one exact line and one
 *      stated reason. A NEW stray CR in an already-exempted file still fails,
 *      because it will not match a declared line. (Same shape as
 *      RADIUS_EXEMPTIONS in apps/console/lib/contrast.test.ts.)
 *   3. IT CANNOT OUTLIVE WHAT IT EXEMPTS. If a declared line no longer holds a
 *      lone CR -- someone "fixed" it -- the guard goes RED and says so. An
 *      exemption that survives its defect is the next lie: it reads as a
 *      considered decision while protecting nothing, and it teaches the next
 *      reader that the bytes were never important.
 *   4. IT MUST CARRY A REASON. A declaration with a missing or perfunctory
 *      reason is rejected outright. An exemption without a reason is next
 *      quarter's defect.
 *
 * A malformed block declaring nothing is simply not an exemption, so the lone
 * CRs it failed to cover stay violations. The failure direction is red.
 *
 * FOOTGUN, AND IT HAS ALREADY FIRED ONCE: a document that QUOTES this syntax
 * is parsed as declaring an exemption. There is no way to tell an example from
 * the real thing by looking at the text -- that is the price of a marker any
 * file may carry. The begin marker must be alone on a line at column 0, so
 * INDENTING the example by one space makes it inert. This is not hypothetical:
 * SN-T031's own note tripped it within a minute of being written, and the
 * guard named the offending line. Loud and self-explaining is the direction to
 * fail in, but the next person deserves the warning.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A .cjs AND NOT A .sh
 * ---------------------------------------------------------------------------
 * A shell guard is vulnerable to the very defect class it inspects. A CRLF
 * `.sh` behaves three different ways depending on how it is invoked, and one
 * of them is green:
 *
 *   /bin/sh (dash)        exit 2,   function body never ran
 *   direct (shebang)      exit 126, bad interpreter: /bin/sh^M
 *   /bin/bash             exit 0,   AND THE BODY RAN, with `set -eu` silently
 *                                   disabled -- so mid-script failures do not
 *                                   abort it
 *
 * Two edge guards in this project were dead for weeks for this reason and
 * nobody noticed, because on Windows/Git Bash they always looked green.
 * A `.cjs` has no shebang interpreter line to poison. Do not port this to sh.
 *
 * Do not use `sed`, `cat -A`, `grep`, or `tr` to answer questions about CR
 * bytes under Git Bash -- they eat the CR before you see it. Read bytes.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE OF THE CLASSIFIER BELOW -- IT IS A COPY, AND THAT IS A TRADE-OFF
 * ---------------------------------------------------------------------------
 * The byte classifier between the BEGIN/END VERBATIM COPY markers was not
 * written here. It is a byte-exact copy of the function block in
 *
 *     scratchpad/sn-t025/tools/eol-bytes.cjs        (SN-T025, agent `eol`)
 *     sha256 of that whole source file at copy time:
 *         3281c57a8f05637bce0ca365af78d64a1c2f1eed2d27ff9021bde2ee53cd0540
 *     sha256 of the copied region alone, CRLF-normalised to LF first:
 *         53ba9e22d9f706e6f642a174fb1dde5b2f7a1e0065a40823178a9050e90b5d22
 *
 * The region sha is taken AFTER normalising CRLF to LF on both sides, because
 * this file gets checked out with different line endings on different machines
 * while the scratchpad original never does. Comparing raw bytes across that
 * boundary reports a byte-identical copy as changed.
 *
 * WHY A COPY AND NOT A require():
 *   The original lives in a scratchpad directory that is not part of any
 *   repository. Requiring across that boundary works on the one workstation
 *   where the two happen to sit side by side, and fails with MODULE_NOT_FOUND
 *   on a CI runner, which checks out this repo alone. A guard that cannot run
 *   where it is meant to gate is not a guard. The other option -- copying
 *   eol-bytes.cjs into scripts/ as a second file -- needs a second entry on
 *   the card, and a verbal expansion is not an expansion.
 *
 * WHY THE COPY IS A REAL RISK, AND WHAT IS ACTUALLY DONE ABOUT IT:
 *   Two comparators pointing at one oracle can drift apart and start scoring
 *   differently; the standing rule here is to parameterise, not duplicate.
 *   That rule cannot be obeyed across a repo boundary, so the risk is bounded
 *   instead of pretended away:
 *     - the copy is byte-exact and delimited, so any drift is a diff rather
 *       than a reading exercise across two files;
 *     - `--self-test` carries the acceptance cases WITH the copy, so a
 *       divergence that changes behaviour fails here, in this repo;
 *     - CI runs `--self-test` BEFORE the scan, so every green scan is preceded
 *       by a live demonstration that this classifier can still go red. A scan
 *       reporting "none found" that has never been shown able to find one is
 *       not evidence.
 *   NOT CLAIMED: nothing here notices a change made only to the scratchpad
 *   original. If that file is edited, this copy keeps the old behaviour, and
 *   the only thing that says so is the recorded sha256 above.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY
 * ---------------------------------------------------------------------------
 * These trees are written by several agents at once. A single read of a live
 * file can catch a half-written state and manufacture a violation that never
 * existed. Every candidate is therefore re-read STABLE_READS times and only
 * reported if the sha256 is identical every time. An unstable candidate is
 * reported as INCONCLUSIVE, never as a violation.
 *
 * ---------------------------------------------------------------------------
 * EXIT CODES
 * ---------------------------------------------------------------------------
 *   0  scanned a non-zero number of text files, no unexempted lone CR
 *   1  at least one confirmed violation: an unexempted lone CR, an exemption
 *      pointing at bytes that are gone, or an exemption with no real reason.
 *      Also a failed --self-test case.
 *   2  the scan could not be trusted (zero files scanned, no repo given, or a
 *      structurally invalid self-test). An empty set satisfies every universal
 *      claim, so "no violations found" over zero files is failure, not success.
 *
 * USAGE
 *   node scripts/check-lone-cr.cjs <repoRoot>... [--json]
 *   node scripts/check-lone-cr.cjs --self-test
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ==== BEGIN VERBATIM COPY: scratchpad/sn-t025/tools/eol-bytes.cjs ====
// Do not edit inside these markers. Re-copy from the source instead, and
// update both sha256 values in the provenance block above when you do.
/** Count CRLF pairs, lone LF, lone CR over the WHOLE buffer. */
function profile(buf) {
  let crlf = 0, loneLf = 0, loneCr = 0, nul = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x00) { nul++; continue; }
    if (b === 0x0d) {
      if (i + 1 < buf.length && buf[i + 1] === 0x0a) { crlf++; i++; }
      else loneCr++;
    } else if (b === 0x0a) {
      loneLf++;
    }
  }
  return { crlf, loneLf, loneCr, nul };
}

function classify(p, size) {
  if (p.nul > 0) return 'BINARY';
  const total = p.crlf + p.loneLf + p.loneCr;
  if (total === 0) return size === 0 ? 'EMPTY' : 'NONE';
  const kinds = (p.crlf > 0 ? 1 : 0) + (p.loneLf > 0 ? 1 : 0) + (p.loneCr > 0 ? 1 : 0);
  if (kinds > 1) return 'MIXED';
  if (p.crlf > 0) return 'CRLF';
  if (p.loneLf > 0) return 'LF';
  return 'CR';
}

/** Normalise CRLF -> LF only. Does NOT touch other whitespace, does NOT
 *  touch lone CR. This is deliberately narrower than `git diff -w`. */
function normalizeCrlf(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) continue;
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function inspectBuffer(buf) {
  const p = profile(buf);
  return {
    size: buf.length,
    sha256: sha256(buf),
    normSha256: sha256(normalizeCrlf(buf)),
    crlf: p.crlf, loneLf: p.loneLf, loneCr: p.loneCr, nul: p.nul,
    lines: p.crlf + p.loneLf + p.loneCr,
    cls: classify(p, buf.length),
  };
}

function inspectFile(path) {
  const buf = fs.readFileSync(path);
  return inspectBuffer(buf);
}
// ==== END VERBATIM COPY ====

const STABLE_READS = 3;

/* Long enough that "legacy" or "wontfix" cannot be typed into it. Matches the
 * threshold RADIUS_EXEMPTIONS uses in apps/console/lib/contrast.test.ts. */
const MIN_REASON = 40;

/* Assigned, never written at column 0, so that this file -- which is itself
 * scanned by this guard -- does not read as declaring an exemption. */
const EX_BEGIN = 'lone-cr-exemption: begin';
const EX_END = 'lone-cr-exemption: end';

/*
 * Binary detection is by CONTENT (a NUL byte), never by git's own opinion.
 * That is deliberate: a lone CR is what MAKES git call a file binary, so
 * filtering on `git ls-files --eol` would skip exactly the files this guard
 * exists to catch. Asking git here would be circular.
 */
function isBinary(r) { return r.nul > 0; }

/* Split on LF, keeping bytes. The CR immediately before an LF is the first
 * half of a CRLF terminator, so it is dropped; every CR that survives is a
 * lone CR. This matches profile() exactly -- same rule, applied per line.
 *
 * The trailing chunk of a file that does not end in LF keeps ALL its bytes.
 * Stripping a trailing CR there unconditionally is wrong and it is not a
 * theoretical mistake: the first version of this function did exactly that and
 * silently swallowed "lone CR as the final byte of the file", which is
 * self-test case 5. The suite caught it. */
function splitLines(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      let end = i;
      if (end > start && buf[end - 1] === 0x0d) end--;   // CRLF terminator
      out.push(buf.subarray(start, end));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));   // unterminated tail
  return out;
}

/* A line, with every lone CR made visible and typeable. Nothing else is
 * altered, so a declaration can be produced by copying what the guard prints.
 *
 * The non-CR runs are decoded as UTF-8. Walking the buffer byte by byte and
 * calling String.fromCharCode on each one mangles every non-ASCII line, which
 * would make a declaration for such a line impossible to type by hand. */
function renderLine(lineBuf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < lineBuf.length; i++) {
    if (lineBuf[i] === 0x0d) { parts.push(lineBuf.subarray(start, i).toString('utf8')); start = i + 1; }
  }
  parts.push(lineBuf.subarray(start).toString('utf8'));
  return parts.join('<CR>');
}

/*
 * Parse a file's own exemption declaration. Returns null when the file does
 * not declare one -- including when a block is malformed, because a block that
 * exempts nothing must not be able to suppress anything. The failure direction
 * is always red.
 */
function parseExemption(buf) {
  const lines = splitLines(buf).map(renderLine);
  const b = lines.findIndex((l) => l === EX_BEGIN);
  if (b < 0) return null;
  const e = lines.findIndex((l, i) => i > b && l === EX_END);
  if (e < 0) return null;

  const body = lines.slice(b + 1, e);
  const declared = [];
  const reasonParts = [];
  let inReason = false;
  for (const l of body) {
    if (l.startsWith('exempt-line: ')) { inReason = false; declared.push(l.slice('exempt-line: '.length)); continue; }
    if (l.startsWith('reason:')) { inReason = true; reasonParts.push(l.slice('reason:'.length).trim()); continue; }
    if (inReason && l.trim()) { reasonParts.push(l.trim()); continue; }
    inReason = false;
  }
  if (!declared.length) return null;   // declares nothing => not an exemption
  return { reason: reasonParts.join(' ').trim(), declared };
}

/*
 * The single verdict function. scanRepo() and --self-test both call THIS, so
 * they cannot be two implementations of one rule that quietly disagree.
 *
 * Returns { problems, exempted } -- problems is empty for a clean file.
 */
function assess(buf) {
  const problems = [];
  const exempted = [];

  const lines = splitLines(buf);
  const withLoneCr = [];
  for (const l of lines) if (l.includes(0x0d)) withLoneCr.push(renderLine(l));

  const ex = parseExemption(buf);

  if (!ex) {
    for (const l of withLoneCr) problems.push({ kind: 'LONE_CR', line: l });
    return { problems, exempted };
  }

  // 4. A reason is mandatory, and must say something.
  if (ex.reason.length < MIN_REASON) {
    problems.push({
      kind: 'EXEMPTION_WITHOUT_REASON',
      line: `reason is ${ex.reason.length} characters, minimum is ${MIN_REASON}`,
    });
  }

  // 3. Anti-rot: an exemption may not outlive what it exempts.
  const present = new Set(withLoneCr);
  for (const d of ex.declared) {
    if (!present.has(d)) problems.push({ kind: 'EXEMPTION_POINTS_AT_NOTHING', line: d });
  }

  // 2. Per line, not per file: an undeclared lone CR still fails.
  const allowed = new Set(ex.declared);
  for (const l of withLoneCr) {
    if (allowed.has(l)) exempted.push(l);
    else problems.push({ kind: 'LONE_CR', line: l });
  }

  return { problems, exempted };
}

function isViolation(buf) { return assess(buf).problems.length > 0; }

/* File list is derived from git, not hand-written. A hand-kept list of paths
 * is the recurring failure mode in this repo: it silently stops covering
 * things. `git ls-files` is the tree's own answer to "what is tracked". */
function trackedFiles(repo) {
  const out = execFileSync('git', ['-C', repo, 'ls-files', '-z'], {
    encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function scanRepo(repo) {
  const res = {
    repo, scanned: 0, text: 0, binary: 0, missing: 0,
    violations: [], exempt: [], inconclusive: [],
  };
  for (const rel of trackedFiles(repo)) {
    const abs = path.join(repo, rel);
    let buf, r;
    try { buf = fs.readFileSync(abs); r = inspectBuffer(buf); }
    catch (e) { res.missing++; continue; }   // in index, absent from worktree
    res.scanned++;
    if (isBinary(r)) { res.binary++; continue; }
    res.text++;

    const a = assess(buf);
    if (!a.problems.length) {
      if (a.exempted.length) {
        res.exempt.push({ rel, lines: a.exempted, loneCr: r.loneCr, crlf: r.crlf, loneLf: r.loneLf, bytes: r.size, sha: r.sha256 });
      }
      continue;
    }

    // Candidate. Re-read until we are sure we are not racing another agent.
    const reads = [r];
    for (let i = 1; i < STABLE_READS; i++) {
      try { reads.push(inspectBuffer(fs.readFileSync(abs))); } catch (e) { reads.push(null); }
    }
    const shas = [...new Set(reads.map((x) => (x ? x.sha256 : 'ERR')))];
    const rec = {
      rel, loneCr: r.loneCr, crlf: r.crlf, loneLf: r.loneLf,
      bytes: r.size, cls: r.cls, shas, problems: a.problems,
      offsets: loneCrOffsets(buf),
    };
    if (shas.length === 1) res.violations.push(rec);
    else res.inconclusive.push(rec);
  }
  return res;
}

/* Byte offsets + 1-based line numbers of each lone CR, so a human can go fix
 * it without having to rediscover where it is. */
function loneCrOffsets(buf) {
  const hits = [];
  let line = 1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      if (i + 1 < buf.length && buf[i + 1] === 0x0a) { i++; line++; continue; }
      hits.push({ offset: i, line });
    } else if (buf[i] === 0x0a) line++;
  }
  return hits;
}

/* ---------------------------------------------------------------------------
 * SELF-TEST
 * ---------------------------------------------------------------------------
 * Twelve cases, both directions, run through assess() -- the same function
 * scanRepo() uses, not a parallel statement of the rule.
 *
 * Case 3 is the load-bearing negative. SN-T025 found 7 files with MIXED line
 * endings and only 1 with a lone CR, so a guard conflating the two fires on 6
 * innocent files and gets switched off inside a day. The negative control that
 * matters is the one that looks most like a positive.
 *
 * Case 7 is the circularity trap: a lone CR is what makes git call a file
 * binary, so "binary" is decided by a NUL byte in the content. A guard that
 * asked git instead would skip every file it exists to catch.
 *
 * Cases 8-12 are the exemption mechanism, and 9, 10 and 12 are the ones that
 * keep it from being a hole: a declaration that has stopped matching fails, a
 * declaration whose bytes were "fixed" fails, and a second stray CR in an
 * already-exempted file still fails.
 *
 * This covers the VERDICT. It does not cover the git file listing or the
 * 3-read stability gate; those need a real repository and are exercised by the
 * out-of-tree control that first proved this guard.
 * ------------------------------------------------------------------------- */
function selfTestCases() {
  const B = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))));
  const CR = Buffer.from([0x0d]);
  const LF = Buffer.from([0x0a]);
  const CRLF = Buffer.from([0x0d, 0x0a]);
  const NUL = Buffer.from([0x00]);
  const GOOD_REASON = 'these bytes are captured shell output and deleting them would forge a message no shell prints';

  const block = (reason, ...declared) =>
    B(EX_BEGIN, LF, 'reason: ', reason, LF, ...declared.flatMap((d) => ['exempt-line: ', d, LF]), EX_END, LF);

  return [
    { name: '1-pure-lf', expect: false, why: 'pure LF, no CR at all',
      buf: B('const a = 1;', LF, 'const b = 2;', LF) },
    { name: '2-pure-crlf', expect: false, why: 'pure CRLF, every CR followed by LF',
      buf: B('const a = 1;', CRLF, 'const b = 2;', CRLF) },
    { name: '3-mixed-no-lonecr', expect: false, why: 'MIXED endings, no lone CR -- must NOT fire (6 of 7 real mixed files look like this)',
      buf: B('const a = 1;', CRLF, 'const b = 2;', LF, 'const c = 3;', CRLF) },
    { name: '4-lonecr-midline', expect: true, why: 'stray CR after a bracket -- the exact shape that seeded 62f4b6dd',
      buf: B('const XS = [', CR, '  "a.tsx",', CRLF, '];', CRLF) },
    { name: '5-lonecr-at-eof', expect: true, why: 'lone CR as the final byte, nothing follows it',
      buf: B('const a = 1;', CRLF, 'const b = 2;', CR) },
    { name: '6-lonecr-in-string', expect: true, why: 'lone CR hidden inside a string literal',
      buf: B('const s = "before', CR, 'after";', CRLF) },
    { name: '7-binary-with-cr', expect: false, why: 'has NUL -> binary by content; handled before assess(), see scanRepo',
      buf: B(NUL, 'PNGish', CR, 'tail', NUL, CR), binary: true },

    { name: '8-exempt-valid', expect: false, why: 'lone CR declared by the file itself, with a real reason -- the legitimate case',
      buf: B('31: ', CR, ': not found', LF, block(GOOD_REASON, '31: <CR>: not found')) },
    { name: '9-exempt-stale-line', expect: true, why: 'ANTI-ROT: declaration no longer matches any line -- the bytes moved or changed',
      buf: B('31: ', CR, ': not found', LF, block(GOOD_REASON, '99: <CR>: something else')) },
    { name: '10-exempt-outlived-defect', expect: true, why: 'ANTI-ROT: someone "fixed" the bytes; the exemption now protects nothing and must not survive them',
      buf: B('31: : not found', LF, block(GOOD_REASON, '31: <CR>: not found')) },
    { name: '11-exempt-no-reason', expect: true, why: 'declaration with a perfunctory reason is rejected -- an exemption without a reason is next quarter\'s defect',
      buf: B('31: ', CR, ': not found', LF, block('legacy', '31: <CR>: not found')) },
    { name: '12-exempt-does-not-cover-new-cr', expect: true, why: 'PER LINE, NOT PER FILE: a second, undeclared stray CR in an exempted file still fails',
      buf: B('31: ', CR, ': not found', LF, 'const XS = [', CR, '];', LF, block(GOOD_REASON, '31: <CR>: not found')) },
  ];
}

function selfTest() {
  const cases = selfTestCases();
  console.log('lone-CR guard self-test -- the verdict, both directions\n');
  console.log('EXPECT  ACTUAL  VERDICT   CASE                          WHY');
  let fails = 0;
  for (const c of cases) {
    // Case 7 is filtered out by isBinary() before assess() ever sees it, which
    // is where the real guard makes that decision too.
    const r = inspectBuffer(c.buf);
    const actual = isBinary(r) ? false : isViolation(c.buf);
    const ok = actual === c.expect;
    if (!ok) fails++;
    console.log(
      `${(c.expect ? 'FLAG' : 'pass').padEnd(8)}${(actual ? 'FLAG' : 'pass').padEnd(8)}` +
      `${(ok ? 'ok' : 'MISMATCH').padEnd(10)}${c.name.padEnd(32)}${c.why}`
    );
  }
  const pos = cases.filter((c) => c.expect).length;
  const neg = cases.length - pos;

  // A suite with no positives can never go red; a suite with no negatives
  // cannot tell a guard from a rubber stamp. Both are structural failures.
  if (pos === 0 || neg === 0) {
    console.error(`\nFAIL(2): self-test is structurally invalid -- ${pos} positive(s), ${neg} negative(s). Both must be > 0.`);
    return 2;
  }
  if (fails) {
    console.error(`\nFAIL(1): ${fails} of ${cases.length} self-test case(s) mismatched. This guard no longer behaves as specified.`);
    return 1;
  }
  console.log(`\nPASS(0): ${cases.length}/${cases.length} cases correct (${pos} positive, ${neg} negative). This guard can still go red.`);
  return 0;
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();

  const repos = argv.filter((a) => !a.startsWith('--'));
  const asJson = argv.includes('--json');
  if (!repos.length) {
    console.error('usage: node check-lone-cr.cjs <repoRoot>... [--json]');
    console.error('       node check-lone-cr.cjs --self-test');
    return 2;
  }

  const results = repos.map(scanRepo);
  const totalText = results.reduce((n, r) => n + r.text, 0);
  const totalScanned = results.reduce((n, r) => n + r.scanned, 0);
  const violations = results.reduce((n, r) => n + r.violations.length, 0);
  const exempt = results.reduce((n, r) => n + r.exempt.length, 0);
  const inconclusive = results.reduce((n, r) => n + r.inconclusive.length, 0);

  if (asJson) {
    console.log(JSON.stringify({ results, totalScanned, totalText, violations, exempt, inconclusive }, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n== ${r.repo}`);
      console.log(`   tracked scanned=${r.scanned}  text=${r.text}  binary(NUL)=${r.binary}  absent-from-worktree=${r.missing}`);
      for (const v of r.violations) {
        console.log(`   VIOLATION  ${v.rel}`);
        console.log(`      loneCR=${v.loneCr} crlf=${v.crlf} loneLF=${v.loneLf} bytes=${v.bytes} cls=${v.cls}`);
        console.log(`      sha256 stable over ${STABLE_READS} reads: ${v.shas[0]}`);
        for (const p of v.problems) console.log(`      ${p.kind}: ${p.line}`);
        if (v.problems.some((p) => p.kind === 'EXEMPTION_POINTS_AT_NOTHING') && v.loneCr === 0) {
          console.log('      -> this file declares an exemption but holds no lone CR at all.');
          console.log('         Either the bytes it protected were deleted (restore them, or drop the');
          console.log('         declaration), or this is documentation quoting the syntax -- in which');
          console.log('         case indent the example so the begin marker is not at column 0.');
        }
        console.log(`      lone CR at: ${v.offsets.map((o) => `line ${o.line} (byte ${o.offset})`).join(', ')}`);
      }
      // Exempt files are ALWAYS printed. An exemption nobody can see is an
      // exemption nobody will re-examine.
      for (const x of r.exempt) {
        console.log(`   EXEMPT (declared in the file itself, with a reason)  ${x.rel}`);
        console.log(`      loneCR=${x.loneCr} crlf=${x.crlf} loneLF=${x.loneLf} bytes=${x.bytes}`);
        for (const l of x.lines) console.log(`      allowed: ${l}`);
      }
      for (const u of r.inconclusive) {
        console.log(`   INCONCLUSIVE (file changed while reading, NOT counted as a violation)  ${u.rel}`);
        console.log(`      sha256 differed across reads: ${u.shas.join(' != ')}`);
      }
      if (!r.violations.length && !r.exempt.length && !r.inconclusive.length) console.log('   ok, no lone CR');
    }
  }

  // Non-emptiness. An empty set satisfies every universal claim.
  if (totalText === 0) {
    console.error(`\nFAIL(2): scanned ${totalScanned} tracked files but 0 of them were text. ` +
      `A "no violations" verdict over an empty set proves nothing.`);
    return 2;
  }
  if (violations > 0) {
    console.error(`\nFAIL(1): ${violations} file(s) failed. ` +
      `Scanned ${totalText} text files across ${repos.length} repo(s).`);
    if (inconclusive) console.error(`         (${inconclusive} further candidate(s) inconclusive -- re-run when the tree is quiet.)`);
    return 1;
  }
  console.log(`\nPASS(0): 0 unexempted lone CR in ${totalText} tracked text files across ${repos.length} repo(s) ` +
    `(non-emptiness: ${totalText} > 0; ${exempt} file(s) exempt by their own declaration).`);
  if (inconclusive) { console.error(`WARN: ${inconclusive} candidate(s) inconclusive -- re-run when the tree is quiet.`); }
  console.log('NOTE: green here does NOT mean "no EOL conversion happened" -- see the boundary block at the top of this file.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { scanRepo, loneCrOffsets, isBinary, assess, isViolation, parseExemption, renderLine, splitLines, selfTest };
