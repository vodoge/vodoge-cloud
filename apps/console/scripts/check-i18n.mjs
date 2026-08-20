import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCatalog(name) {
  return JSON.parse(readFileSync(join(root, "messages", name), "utf8"));
}

test("zh and en message keys are identical", () => {
  const zh = loadCatalog("zh.json");
  const en = loadCatalog("en.json");
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();

  const missingInEn = zhKeys.filter((key) => !Object.hasOwn(en, key));
  const missingInZh = enKeys.filter((key) => !Object.hasOwn(zh, key));

  assert.deepEqual(
    { missingInEn, missingInZh },
    { missingInEn: [], missingInZh: [] },
    `i18n key mismatch: missingInEn=${missingInEn.join(", ") || "∅"} missingInZh=${missingInZh.join(", ") || "∅"}`,
  );
  assert.deepEqual(zhKeys, enKeys);

  for (const key of zhKeys) {
    assert.equal(typeof zh[key], "string", `zh.${key}`);
    assert.equal(typeof en[key], "string", `en.${key}`);
    assert.notEqual(zh[key].trim(), "", `zh.${key} is empty`);
    assert.notEqual(en[key].trim(), "", `en.${key} is empty`);
  }
});
