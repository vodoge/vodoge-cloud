import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bearerHeader,
  clearedSessionCookie,
  isPublicPath,
  loginRedirect,
  safeNext,
  sessionCookie,
  SESSION_COOKIE,
} from "./session.ts";

test("only whole public segments are reachable without a session", () => {
  assert.equal(isPublicPath("/login"), true);
  assert.equal(isPublicPath("/login/reset"), true);
  assert.equal(isPublicPath("/unknown-tenant"), true);
  assert.equal(isPublicPath("/"), false);
  assert.equal(isPublicPath("/inbox"), false);
  // A prefix match would let this through as if it were the login page.
  assert.equal(isPublicPath("/loginsomething"), false);
});

test("the session cookie is not readable by page scripts", () => {
  const expires = new Date("2026-01-01T00:00:00Z");
  const cookie = sessionCookie("tok", expires, { secure: true });
  assert.equal(cookie.name, SESSION_COOKIE);
  assert.equal(cookie.value, "tok");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "lax");
  assert.equal(cookie.secure, true);
  assert.equal(cookie.path, "/");
  assert.deepEqual(cookie.expires, expires);
});

// A cookie marked secure is not sent back over http://, so local development
// over plain HTTP would look like the session silently failing.
test("the cookie drops secure only when asked", () => {
  assert.equal(sessionCookie("tok", new Date(), { secure: false }).secure, false);
  assert.equal(clearedSessionCookie({ secure: true }).secure, true);
});

test("clearing the session sends an immediately expired cookie", () => {
  const cookie = clearedSessionCookie({ secure: true });
  assert.equal(cookie.value, "");
  assert.equal(cookie.maxAge, 0);
  assert.equal(cookie.httpOnly, true);
});

test("bearerHeader is empty without a token", () => {
  assert.deepEqual(bearerHeader("tok"), { authorization: "Bearer tok" });
  assert.deepEqual(bearerHeader("  tok  "), { authorization: "Bearer tok" });
  assert.deepEqual(bearerHeader(undefined), {});
  assert.deepEqual(bearerHeader(""), {});
  assert.deepEqual(bearerHeader("   "), {});
});

test("the login redirect keeps where the visitor was going", () => {
  assert.equal(loginRedirect("/inbox"), "/login?next=%2Finbox");
  assert.equal(loginRedirect("/"), "/login");
  assert.equal(loginRedirect("/login"), "/login");
});

// Carrying an absolute URL through would make the login page an open redirect.
test("the login redirect refuses a destination off this site", () => {
  assert.equal(loginRedirect("https://evil.example/x"), "/login");
  assert.equal(loginRedirect("//evil.example/x"), "/login");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
  assert.equal(safeNext("/inbox"), "/inbox");
  assert.equal(safeNext(null), "/");
});

// Gating the sign-in endpoint sends the login request to the login page, and
// there is then no way to ever obtain a session.
test("the sign-in and sign-out endpoints are reachable without a session", () => {
  assert.equal(isPublicPath("/api/auth/login"), true);
  assert.equal(isPublicPath("/api/auth/logout"), true);
  // Everything else under /api stays gated.
  assert.equal(isPublicPath("/api/devices"), false);
  assert.equal(isPublicPath("/api"), false);
});
