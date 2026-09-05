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

// ⚠️ 这条改成显式开启。默认不信任那个头的理由见文件末尾那条断言 ——
// 一句话：邻居容器能靠它伪造租户，而这套部署根本用不到它。
test("requestHost prefers the first X-Forwarded-Host label when trusted", () => {
  const headers = new Headers({
    host: "127.0.0.1:18080",
    "x-forwarded-host": "a.vodoge.com, localhost",
  });
  assert.equal(requestHost(headers, { trustForwarded: true }), "a.vodoge.com");
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

// 🔴 默认**不信任** X-Forwarded-Host。
//
// 2026-09-05 实测：从 trek_default 上的任意容器直连
// http://vodoge-cloud-console-1:3000/login，带上
// `Host: vodoge.com` + `X-Forwarded-Host: a.vodoge.com`，拿到的是租户 a 的
// 页面（15579 字节，和真实 a.vodoge.com 逐字节同长），而不带那个头拿到的是
// apex 页面（13840 字节）。也就是说：**邻居容器可以伪造租户**。
//
// 经 Caddy 是安全的（实测：伪造与不伪造的响应逐字节相同，Caddy 覆盖了那个
// 头），但 console 在 backend / edge / trek_default 三个网络上都能被直连，
// 而 trek_default 上跑着第三方镜像（trek / anki / rustdesk）。
//
// 这个偏好原本是为「上游把 Host 改写成 IP」的部署加的（见下面那条测试里的
// `host: 127.0.0.1:18080`）。这套部署里 Caddy **不**改写 Host，所以那条路径
// 用不到它 —— 于是它默认关掉，需要的人显式打开。
test("X-Forwarded-Host is not trusted unless the deployment opts in", () => {
  const headers = new Headers({
    host: "vodoge.com",
    "x-forwarded-host": "a.vodoge.com",
  });
  assert.equal(requestHost(headers), "vodoge.com");
});

// 显式打开时照旧 —— 那条部署路径没有被拿掉，只是不再是默认。
test("an opted-in deployment still reads X-Forwarded-Host", () => {
  const headers = new Headers({
    host: "127.0.0.1:18080",
    "x-forwarded-host": "a.vodoge.com, localhost",
  });
  assert.equal(requestHost(headers, { trustForwarded: true }), "a.vodoge.com");
});
