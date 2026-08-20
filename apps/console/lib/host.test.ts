import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyHost,
  decideTenantRoute,
  requestHost,
  slugFromHost,
} from "./host.ts";

test("slugFromHost extracts a single-label tenant subdomain", () => {
  const cases: Array<{
    host: string;
    base?: string;
    slug: string;
    ok: boolean;
  }> = [
    { host: "a.vodoge.com", slug: "a", ok: true },
    { host: "A.VoDoge.COM", slug: "a", ok: true },
    { host: "a.vodoge.com:443", slug: "a", ok: true },
    { host: "b.vodoge.com", slug: "b", ok: true },
    { host: "vodoge.com", slug: "", ok: false },
    { host: "www.vodoge.com", slug: "", ok: false },
    { host: "foo.bar.vodoge.com", slug: "", ok: false },
    { host: "a.example.com", slug: "", ok: false },
    { host: "a.vodoge.com.evil.com", slug: "", ok: false },
    { host: "", slug: "", ok: false },
    { host: "a.localhost", base: "localhost", slug: "a", ok: true },
  ];

  for (const tc of cases) {
    const got = slugFromHost(tc.host, tc.base);
    assert.equal(got.ok, tc.ok, tc.host);
    assert.equal(got.slug, tc.slug, tc.host);
  }
});

test("classifyHost treats apex and www as not a tenant", () => {
  assert.deepEqual(classifyHost("vodoge.com"), { kind: "apex", host: "vodoge.com" });
  assert.deepEqual(classifyHost("www.vodoge.com"), {
    kind: "apex",
    host: "www.vodoge.com",
  });
  assert.deepEqual(classifyHost("a.vodoge.com"), {
    kind: "tenant",
    host: "a.vodoge.com",
    slug: "a",
  });
  assert.equal(classifyHost("unknown.example.net").kind, "unknown");
});

test("requestHost prefers the first X-Forwarded-Host label", () => {
  const headers = new Headers({
    host: "127.0.0.1:18080",
    "x-forwarded-host": "a.vodoge.com, localhost",
  });
  assert.equal(requestHost(headers), "a.vodoge.com");
});

test("unknown slug does not fall back to operator tenant a", () => {
  const classification = classifyHost("missing.vodoge.com");
  assert.equal(classification.kind, "tenant");
  if (classification.kind !== "tenant") {
    return;
  }
  assert.equal(classification.slug, "missing");

  assert.equal(decideTenantRoute(classification, null), "not-found");
  assert.equal(decideTenantRoute(classification, { slug: "a" }), "not-found");
});

test("decideTenantRoute continues only when the lookup slug matches the host", () => {
  const classification = classifyHost("a.vodoge.com");
  assert.equal(decideTenantRoute(classification, { slug: "a" }), "tenant");
  assert.equal(decideTenantRoute({ kind: "apex", host: "vodoge.com" }, null), "apex");
  assert.equal(
    decideTenantRoute({ kind: "unknown", host: "evil.example" }, { slug: "a" }),
    "not-found",
  );
});
