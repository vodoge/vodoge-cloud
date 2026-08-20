import assert from "node:assert/strict";
import { test } from "node:test";
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
