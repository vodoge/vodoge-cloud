import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SMS_BLOCKED_MODULES, blockedSendModules, sendHold } from "./sms-safety.ts";

/**
 * What the inbox refuses to do, tested where a test can reach it.
 *
 * These moved out of `lib/tokens.test.ts` with the data they check. Note that
 * `package.json`'s test script is a hand-written list of files: a test file
 * that is not named there never runs and the pass count does not move, which
 * reads exactly like "no new tests were needed". This one is on the list.
 *
 * The structural guards — is the refusal on the button *and* in the handler, is
 * the write reachable only from a confirmation, is the send form behind the
 * role gate — stayed in `lib/tokens.test.ts`, because the source scanner they
 * are built on lives there and copying it would give this repository two of
 * them to keep in step.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function catalogue(name: string): Record<string, string> {
  return JSON.parse(readFileSync(join(root, "messages", `${name}.json`), "utf8"));
}

const CATALOGUES = [
  ["zh", catalogue("zh")],
  ["en", catalogue("en")],
] as const;

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
  // as "checked and clean" here. `sendHold` below is where the two are told
  // apart, because this function cannot tell.
  assert.deepEqual(blockedSendModules([], "edge-a"), []);
});

test("the blocked module says what it costs, and never that the message failed", () => {
  const entries = Object.entries(SMS_BLOCKED_MODULES);
  assert.ok(entries.length > 0, "an empty block list checks nothing");

  for (const [imei, keys] of entries) {
    assert.match(imei, /^\d{15}$/, "keyed by IMEI, because the card in it can be moved");

    for (const [language, messages] of CATALOGUES) {
      const why = messages[keys.why];
      const cost = messages[keys.cost];
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

/* ── An unreadable module list holds the send ────────────────────────────
 *
 * This is the behaviour T032 reversed, so it is the assertion that has to be
 * hard to delete by accident. Until this card a failed `GET /v1/modems` left
 * the send button live under a note saying nothing had been checked.
 *
 * The argument for the old way was real — one gateway wobble should not switch
 * off messaging for a whole fleet — and it lost anyway. The module list is read
 * in order to stop a send that takes a module off the USB bus, on hardware
 * nobody can walk over to. Not knowing which modules are banned is not a reason
 * to allow the dangerous half of the choice.
 */

test("a module list that could not be read holds the send", () => {
  assert.equal(
    sendHold({ modemsKnown: false, blocked: [] }),
    "modules-unknown",
    "a failed module read let the send through: this is the fail-open T032 removed",
  );
});

test("a readable module list with nothing against the device sends", () => {
  assert.equal(
    sendHold({ modemsKnown: true, blocked: [] }),
    null,
    "a checked, clean device cannot send — the hold has stopped being about knowing",
  );
});

test("the module beats the unread list, because it is the sentence with the IMEI in it", () => {
  const blocked = blockedSendModules([{ deviceId: "edge-a", imei: "867018069509705" }], "edge-a");
  assert.equal(sendHold({ modemsKnown: true, blocked }), "blocked-module");
  // The two cannot really co-occur — with no list there is nothing to match
  // against — but a stale list beside a fresh failure must still name it.
  assert.equal(sendHold({ modemsKnown: false, blocked }), "blocked-module");
});

/**
 * 🔴 The copy for a held send must not read as a send that failed.
 *
 * They are different events with different responses. A failure invites the
 * operator to send again, and sending again on this fleet is what costs a
 * module. The strings therefore have to name *what could not be read*, and must
 * not repeat either of the two outcome sentences this form has — the failure or
 * the queued acknowledgement — because nothing was attempted at all.
 *
 * The two phrases are taken from the catalogue rather than written here, so
 * this cannot drift into checking words that stopped being used.
 */
test("the held send says the module list could not be read, not that sending failed", () => {
  const NAMES_THE_LIST = { zh: "模组清单", en: "module list" } as const;

  for (const [language, messages] of CATALOGUES) {
    const title = messages["inbox.smsModemsUnknownTitle"];
    const body = messages["inbox.smsModemsUnknown"];
    assert.equal(typeof title, "string", `${language} has no title for a held send`);
    assert.equal(typeof body, "string", `${language} has no explanation for a held send`);

    assert.ok(
      body.includes(NAMES_THE_LIST[language]),
      `${language} inbox.smsModemsUnknown no longer says what could not be read`,
    );

    // Neither outcome was reached, so neither may be claimed. Trailing
    // punctuation differs between the two catalogues; the claim does not.
    for (const key of ["inbox.sendFailed", "inbox.queued"]) {
      const claim = messages[key].replace(/[.。!！]+\s*$/, "");
      assert.ok(claim.length > 0, `${language} ${key} is empty, so this check is vacuous`);
      for (const [where, text] of [["title", title], ["body", body]] as const) {
        assert.ok(
          !text.includes(claim),
          `${language} inbox.smsModemsUnknown ${where} claims "${claim}": ` +
            "nothing was sent, and a message that says otherwise gets the operator to retry",
        );
      }
    }
  }
});

/**
 * The read-only note has to say which of the three it takes away.
 *
 * "You are read-only" alone leaves an operator looking for the Delete button
 * that is simply not there any more. All three verbs disappear together, so all
 * three are named.
 */
test("the read-only note names what is gone from the inbox", () => {
  const VERBS = {
    zh: ["发短信", "删除", "改名"],
    en: ["Sending", "deleting", "renaming"],
  } as const;

  for (const [language, messages] of CATALOGUES) {
    const note = messages["role.readOnlyInbox"];
    assert.equal(typeof note, "string", `${language} has no read-only note for the inbox`);
    for (const verb of VERBS[language]) {
      assert.ok(note.includes(verb), `${language} role.readOnlyInbox stopped naming ${verb}`);
    }
  }
});
