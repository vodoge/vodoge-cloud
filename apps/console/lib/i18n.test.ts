import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MISSING_KEY_PATTERN,
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
