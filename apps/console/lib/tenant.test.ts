import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TenantCache,
  TenantDirectory,
  createGatewayLookup,
  parseTenant,
  type Tenant,
} from "./tenant.ts";

const operator: Tenant = {
  tenant_id: "a0000000-0000-4000-8000-00000000000a",
  slug: "a",
  region: "cn",
  status: "active",
};

test("cache does not invent a default tenant for an unknown slug", () => {
  const cache = new TenantCache();
  cache.store(operator);
  assert.equal(cache.lookup("missing"), undefined);
  assert.equal(cache.size, 1);
});

test("cache rejects a region change for a stored slug", () => {
  const cache = new TenantCache();
  assert.equal(cache.store(operator), true);
  assert.equal(cache.store({ ...operator, region: "intl" }), false);
  assert.equal(cache.lookup("a")?.region, "cn");
});

test("directory caches a hit and never returns a default tenant on a miss", async () => {
  let calls = 0;
  const directory = new TenantDirectory(async (slug) => {
    calls += 1;
    if (slug !== "a") {
      return null;
    }
    return operator;
  });

  const first = await directory.resolve("A");
  assert.deepEqual(first, operator);
  const second = await directory.resolve("a");
  assert.deepEqual(second, operator);
  assert.equal(calls, 1);

  const missing = await directory.resolve("missing");
  assert.equal(missing, null);
  assert.equal(calls, 2);
  assert.equal(directory.cache.lookup("a")?.slug, "a");
  assert.equal(directory.cache.lookup("missing"), undefined);
});

test("directory ignores a lookup that returns a different slug", async () => {
  const directory = new TenantDirectory(async () => operator);
  assert.equal(await directory.resolve("missing"), null);
  assert.equal(directory.cache.lookup("missing"), undefined);
  assert.equal(directory.cache.lookup("a"), undefined);
});

test("gateway lookup maps HTTP 404 to unknown and does not need a live gateway", async () => {
  const lookup = createGatewayLookup({
    baseUrl: "http://gateway.test",
    fetch: async (input) => {
      const url = String(input);
      assert.equal(url, "http://gateway.test/v1/tenants/missing");
      return new Response(JSON.stringify({ error: "unknown tenant" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(await lookup("missing"), null);
});

test("gateway lookup parses a tenant body", async () => {
  const lookup = createGatewayLookup({
    baseUrl: "http://gateway.test/",
    fetch: async () =>
      new Response(JSON.stringify(operator), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.deepEqual(await lookup("a"), operator);
});

test("parseTenant requires cn or intl", () => {
  assert.equal(parseTenant({ ...operator, region: "us" }), null);
  assert.deepEqual(parseTenant(operator), operator);
});
