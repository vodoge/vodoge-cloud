import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_ADDRESS_HEADER,
  classifyHost,
  decideTenantRoute,
  forwardedClientAddress,
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

/* ── 谁在敲门 ─────────────────────────────────────────────────────────── */

/**
 * 🔴 这一组的由来：网关的登录限流按调用方地址分桶，而控制台把每一个 /v1 请求
 * 都转发给网关，于是网关看到的对端**永远**是 console 容器。修复前全平台共用
 * 一个桶 —— 任何人往 `/api/auth/login` 打五次废凭据，之后每个租户的每位运维
 * 都登不进去，一个 IP 每 12 秒补一下就能一直压着。
 */
test("经 Cloudflare 时，认的是 cf-connecting-ip 而不是 XFF 的末段", () => {
  // 🔴 2026-09-18 从 Caddy 访问日志里量到的真实形状：Cloudflare 送来
  //    cf-connecting-ip=<客户端> 和 x-forwarded-for=<客户端>，Caddy 再把
  //    自己的对端（CF 边缘节点）追加到 XFF 末尾。取末段拿到的是边缘节点，
  //    而它每个请求都不一样 —— 并发 12 次登录只限住 1 次就是这么来的。
  const throughCloudflare = new Headers({
    "cf-connecting-ip": "142.249.39.43",
    "x-forwarded-for": "142.249.39.43, 172.70.207.159",
  });
  assert.equal(forwardedClientAddress(throughCloudflare), "142.249.39.43");

  // 负面对照：如果实现退回「取末段」，上面那条会拿到边缘节点。
  assert.notEqual(forwardedClientAddress(throughCloudflare), "172.70.207.159");
});

test("没有 Cloudflare 时，取 X-Forwarded-For 的最后一段", () => {
  // 那一段是 Caddy 的对端，也就是真实客户端；前面那几段是调用方自己写的。
  assert.equal(
    forwardedClientAddress(new Headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.9" })),
    "203.0.113.9",
  );
  assert.equal(
    forwardedClientAddress(new Headers({ "x-forwarded-for": "203.0.113.9" })),
    "203.0.113.9",
  );
  // 带端口的形式也见过。
  assert.equal(
    forwardedClientAddress(new Headers({ "x-forwarded-for": "203.0.113.9:51234" })),
    "203.0.113.9",
  );
});

test("推不出地址时返回 null，而不是编一个", () => {
  assert.equal(forwardedClientAddress(new Headers()), null);
  assert.equal(forwardedClientAddress(new Headers({ "x-forwarded-for": "" })), null);
  assert.equal(forwardedClientAddress(new Headers({ "x-forwarded-for": " , " })), null);
  // 空的 cf-connecting-ip 不能顶掉 XFF —— 「有这个头」不等于「它说了什么」。
  assert.equal(
    forwardedClientAddress(
      new Headers({ "cf-connecting-ip": "  ", "x-forwarded-for": "203.0.113.9" }),
    ),
    "203.0.113.9",
  );
});

/**
 * 接线：middleware 必须先删掉调用方自带的那一份再重设。
 *
 * 🔴 单测这个函数证明不了这件事 —— 函数写对了而没人正确调用，是最容易发生的
 * 那一种退化（网关那边同一天在通知渠道上逃掉过一次）。这里读 `middleware.ts`
 * 本身：`delete` 必须在 `set` 之前，否则一个自带这个头进来的调用方就能自己
 * 挑限流桶，等于没有限流。
 */
test("middleware 先删掉调用方自带的客户端地址头，再设自己推出来的", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(join(root, "middleware.ts"), "utf8");

  const deleted = source.indexOf(`headers.delete(CLIENT_ADDRESS_HEADER)`);
  const set = source.indexOf(`headers.set(CLIENT_ADDRESS_HEADER`);
  assert.ok(deleted !== -1, "middleware 没有删掉调用方自带的客户端地址头");
  assert.ok(set !== -1, "middleware 没有设置客户端地址头");
  assert.ok(
    deleted < set,
    "先设后删：调用方自带的那一份会留下来，于是它可以自己挑限流桶",
  );
  assert.ok(
    source.includes("forwardedClientAddress(request.headers)"),
    "middleware 没有从 X-Forwarded-For 推导调用方地址",
  );
});

/**
 * 接线的另一半：登录那条服务端 fetch 必须把这个头转出去。
 *
 * 🔴 `POST /api/auth/login` 是生产上唯一到达 `/v1/auth/login` 的路 —— 它不是
 * rewrite，是路由处理器里自己写头的一次 fetch，所以 middleware 设了也不会自动
 * 跟着走。这一条漏掉的话，被共用一个桶的恰好就是登录本身。
 */
test("登录路由把客户端地址转给网关", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(join(root, "app/api/auth/login/route.ts"), "utf8");

  assert.ok(
    source.includes("clientAddressHeader(request)"),
    "登录路由没有把客户端地址转给网关：每一次登录都会落在 console 容器那一个桶里",
  );
  assert.ok(
    source.includes("forwardedClientAddress(request.headers)"),
    "转出去的地址不是从 X-Forwarded-For 推出来的",
  );
});

test("客户端地址头的名字两边一致", () => {
  assert.equal(CLIENT_ADDRESS_HEADER, "x-vodoge-client-address");
});
