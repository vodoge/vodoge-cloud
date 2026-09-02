import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { LOCALE_COOKIE } from "./i18n.ts";
import {
  INSTALL_DISMISSED_KEY,
  LOST_AFTER_FAILURES,
  MIDDLEWARE_MATCHER,
  PROBE_INTERVAL_MS,
  PROBE_PATH,
  STANDALONE_QUERIES,
  connectionView,
  consoleManifest,
  createConnectionMonitor,
  detectPlatform,
  formatClock,
  installState,
  isConnectionFailure,
  isStandalone,
  isWatchedRequest,
  middlewareRunsOn,
  requestUrl,
  type ConnectionHost,
  type FetchLike,
} from "./pwa.ts";
import * as ALL_TOKENS from "./tokens.ts";
import { COLOR_TOKENS, PWA, SAFE_AREA } from "./tokens.ts";

/**
 * The PWA checklist, as assertions.
 *
 * `goal.md` defines "perfect PWA support" as a list rather than a score —
 * Lighthouse v12 removed the PWA category outright, so there is no number left
 * to chase — and the list is only worth anything if the items are checked
 * somewhere other than a reviewer's memory. Everything here is checked against
 * a file on disk or a pure function, because that is all this app can run: it
 * has no jsdom, no testing-library, no vitest and no jest, so a `.tsx` cannot
 * be rendered in a test at all.
 *
 * Note also that `package.json`'s `test` script is a hand-written list of
 * files. This file had to be added to it; without that it would never run and
 * the pass count would not move, which reads exactly like "no new tests were
 * needed". T023 flagged that trap and it is real.
 *
 * ## Nothing here may import from `app/`
 *
 * `node --test` resolves module specifiers itself and does not read
 * `tsconfig.json`, so the `@/` alias every file under `app/` uses is not a
 * package it can find. An earlier revision imported `app/manifest.ts` for the
 * manifest object; the moment that file gained one `@/lib/tokens` import the
 * run failed with `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'` — at
 * import time, so all 35 tests below disappeared at once and the summary said
 * "1 fail" rather than "35 fewer". The manifest now lives in `lib/pwa.ts` and
 * `app/manifest.ts` is checked as *text*, below.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readPublic = (name: string) => readFileSync(join(root, "public", name));
const readText = (name: string) => readFileSync(join(root, name), "utf8");

/* ── Installing ──────────────────────────────────────────────────────── */

test("an iPad that claims to be a Mac is still an iPad", () => {
  const iPhone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const iPadOld =
    "Mozilla/5.0 (iPad; CPU OS 12_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1";
  // iPadOS 13+ sends this. There is no "iPad" anywhere in it, and a real Mac
  // sends the same string; only the touch points differ.
  const iPadModern =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  const android =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  const windows =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  assert.equal(detectPlatform(iPhone), "ios");
  assert.equal(detectPlatform(iPadOld), "ios");
  assert.equal(detectPlatform(iPadModern, 5), "ios");
  // The same string with no touch points is a Mac, and a Mac gets the prompt.
  assert.equal(detectPlatform(iPadModern, 0), "other");
  assert.equal(detectPlatform(android), "android");
  assert.equal(detectPlatform(windows), "other");
  assert.equal(detectPlatform(""), "other");
});

test("standalone is either display-mode or Safari's own flag", () => {
  const none = () => false;
  assert.equal(isStandalone(none, false), false);
  // Safari-only, and the only signal there for a long time.
  assert.equal(isStandalone(none, true), true);
  for (const query of STANDALONE_QUERIES) {
    assert.equal(isStandalone((q) => q === query, false), true, `${query} is not counted`);
  }
  // A browser tab is not an installed app.
  assert.equal(isStandalone((q) => q === "(display-mode: browser)", false), false);
});

test("iOS is never told to press a button that does not exist", () => {
  // Safari has never fired beforeinstallprompt, so on iOS the only honest
  // answer is directions. This is the whole reason InstallState has four arms.
  assert.equal(
    installState({ standalone: false, promptAvailable: false, platform: "ios" }),
    "ios-guide",
  );
  assert.equal(
    installState({ standalone: false, promptAvailable: true, platform: "android" }),
    "promptable",
  );
  // Already installed beats everything: the offer must not follow you in.
  for (const platform of ["ios", "android", "other"] as const) {
    assert.equal(
      installState({ standalone: true, promptAvailable: true, platform }),
      "installed",
      `${platform} is offered an install inside the installed app`,
    );
  }
  // Desktop Firefox: no prompt, not iOS, nothing to say.
  assert.equal(
    installState({ standalone: false, promptAvailable: false, platform: "other" }),
    "unavailable",
  );
});

test("the dismissal key is namespaced like the console's other storage", () => {
  assert.match(INSTALL_DISMISSED_KEY, /^vodoge\./);
});

/* ── Offline honesty: the judgement ──────────────────────────────────── */

test("a clock is zero-padded and does not care about the locale", () => {
  // Built from local components, so this is the same answer in every zone.
  assert.equal(formatClock(new Date(2026, 7, 25, 9, 5)), "09:05");
  assert.equal(formatClock(new Date(2026, 7, 25, 0, 0)), "00:00");
  assert.equal(formatClock(new Date(2026, 7, 25, 23, 59)), "23:59");
  assert.equal(formatClock(new Date(2026, 7, 25, 13, 7)), "13:07");
});

test("one failed request is a blip and two is a lost connection", () => {
  const base = { online: true, lastOkAt: null, loadedAt: 1000 };
  assert.equal(connectionView({ ...base, failures: 0 }).lost, false);
  assert.equal(connectionView({ ...base, failures: 1 }).lost, false);
  assert.equal(connectionView({ ...base, failures: LOST_AFTER_FAILURES }).lost, true);
  assert.ok(LOST_AFTER_FAILURES >= 2, "a banner that flaps on a single blip is noise");
  // navigator.onLine going false means there is no interface at all. That one
  // is believed immediately.
  assert.equal(connectionView({ ...base, online: false, failures: 0 }).lost, true);
});

test("the timestamp is the age of what is on the screen, never the current time", () => {
  // This is the assertion the whole feature exists for. `dataAt` may only ever
  // be one of two facts — when the server rendered the page, or when a client
  // request last succeeded — and never anything derived from "now".
  const loadedAt = 1_700_000_000_000;
  assert.equal(connectionView({ online: false, failures: 0, lastOkAt: null, loadedAt }).dataAt, loadedAt);

  // A later client fetch is newer than the render, so it wins.
  const later = loadedAt + 60_000;
  assert.equal(
    connectionView({ online: false, failures: 2, lastOkAt: later, loadedAt }).dataAt,
    later,
  );
  // An earlier one does not: a request that landed before the render tells you
  // nothing newer than the render did.
  assert.equal(
    connectionView({ online: false, failures: 2, lastOkAt: loadedAt - 60_000, loadedAt }).dataAt,
    loadedAt,
  );
});

/* ── Offline honesty: what counts as a signal ────────────────────────── */

test("only same-origin gateway traffic says anything about the connection", () => {
  const origin = "https://a.vodoge.com";
  assert.equal(isWatchedRequest("/v1/devices", origin), true);
  assert.equal(isWatchedRequest("/api/auth/login", origin), true);
  assert.equal(isWatchedRequest("https://a.vodoge.com/v1/commands", origin), true);

  // A third party failing says nothing about our gateway.
  assert.equal(isWatchedRequest("https://example.com/v1/devices", origin), false);
  // The service worker may answer this from cache, which would report a
  // connection that is not there.
  assert.equal(isWatchedRequest("/_next/static/chunk.js", origin), false);
  assert.equal(isWatchedRequest("/icon.svg", origin), false);
  assert.equal(isWatchedRequest("", origin), false);
  // A prefix is not a path segment: /v1x is not the gateway.
  assert.equal(isWatchedRequest("/v1", origin), false);
  assert.equal(isWatchedRequest("/apixyz/thing", origin), false);
});

test("a request target is found whether it arrived as a string, a URL or a Request", () => {
  assert.equal(requestUrl("/v1/devices"), "/v1/devices");
  assert.equal(requestUrl(new URL("https://a.vodoge.com/v1/devices")), "https://a.vodoge.com/v1/devices");
  assert.equal(requestUrl({ url: "/v1/commands" }), "/v1/commands");
  assert.equal(requestUrl(undefined), "");
  assert.equal(requestUrl(null), "");
});

test("a cancelled request is not a lost connection", () => {
  // Several pages abort a superseded request on purpose. Counting those would
  // put the banner on a screen whose network is fine — the same lie as stale
  // data, pointed the other way.
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(isConnectionFailure(abort), false);
  assert.equal(isConnectionFailure(new TypeError("Failed to fetch")), true);
  assert.equal(isConnectionFailure(undefined), true);
});

/* ── Offline honesty: the monitor ────────────────────────────────────── */

type Harness = {
  host: ConnectionHost;
  calls: unknown[];
  fire(event: "online" | "offline"): void;
  tick(): void;
  installed(): FetchLike;
  respond: { mode: "ok" | "reject" | "abort" | "server-error" };
  clock: { value: number };
};

function harness(): Harness {
  const respond: Harness["respond"] = { mode: "ok" };
  const clock = { value: 5_000 };
  const calls: unknown[] = [];
  const handlers: Record<string, (() => void)[]> = { online: [], offline: [] };
  const timers: (() => void)[] = [];
  let online = true;
  let current: FetchLike = (input) => {
    calls.push(input);
    if (respond.mode === "reject") return Promise.reject(new TypeError("Failed to fetch"));
    if (respond.mode === "abort") {
      return Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }));
    }
    // A 500 is a *response*: the gateway answered, so the connection is up.
    return Promise.resolve({ ok: respond.mode !== "server-error", status: 200 });
  };

  return {
    respond,
    clock,
    calls,
    installed: () => current,
    fire(event) {
      if (event === "offline") online = false;
      if (event === "online") online = true;
      for (const handler of handlers[event]) handler();
    },
    tick() {
      for (const timer of [...timers]) timer();
    },
    host: {
      origin: "https://a.vodoge.com",
      now: () => clock.value,
      isOnline: () => online,
      getFetch: () => current,
      setFetch: (next) => {
        current = next;
      },
      listen: (event, handler) => {
        handlers[event].push(handler);
        return () => {
          handlers[event] = handlers[event].filter((h) => h !== handler);
        };
      },
      every: (_ms, handler) => {
        timers.push(handler);
        return () => {
          const at = timers.indexOf(handler);
          if (at !== -1) timers.splice(at, 1);
        };
      },
    },
  };
}

test("the monitor watches fetch without changing what fetch does", async () => {
  const h = harness();
  const original = h.installed();
  const monitor = createConnectionMonitor(h.host, { loadedAt: 1_000 });
  assert.notEqual(h.installed(), original, "fetch was not wrapped, so nothing is observed");

  const response = await h.installed()("/v1/devices");
  assert.deepEqual(response, { ok: true, status: 200 }, "the response was not passed through");

  // And the rejection has to arrive unchanged: callers are already handling it.
  h.respond.mode = "reject";
  await assert.rejects(() => h.installed()("/v1/devices") as Promise<unknown>, TypeError);

  monitor.stop();
  assert.equal(h.installed(), original, "stop() left the wrapper in place");
});

test("two failed gateway requests raise the banner and one success clears it", async () => {
  const h = harness();
  const monitor = createConnectionMonitor(h.host, { loadedAt: 1_000 });
  assert.equal(monitor.view().lost, false);

  h.respond.mode = "reject";
  await h.installed()("/v1/devices").catch(() => {});
  assert.equal(monitor.view().lost, false, "one failure is a blip");
  await h.installed()("/v1/commands").catch(() => {});
  assert.equal(monitor.view().lost, true);

  h.respond.mode = "ok";
  h.clock.value = 9_000;
  await h.installed()("/v1/devices");
  assert.equal(monitor.view().lost, false);
  assert.equal(monitor.view().dataAt, 9_000, "a success is newer than the render");
  monitor.stop();
});

test("a failing request to somewhere else does not raise the banner", async () => {
  const h = harness();
  const monitor = createConnectionMonitor(h.host, { loadedAt: 1_000 });
  h.respond.mode = "reject";
  for (const url of ["https://example.com/v1/x", "/_next/static/a.js", "/icon.svg"]) {
    await (h.installed()(url) as Promise<unknown>).catch(() => {});
  }
  assert.equal(monitor.view().lost, false);
  monitor.stop();
});

test("an aborted request does not raise the banner", async () => {
  const h = harness();
  const monitor = createConnectionMonitor(h.host, { loadedAt: 1_000 });
  h.respond.mode = "abort";
  await (h.installed()("/v1/devices") as Promise<unknown>).catch(() => {});
  await (h.installed()("/v1/devices") as Promise<unknown>).catch(() => {});
  assert.equal(monitor.view().lost, false, "a deliberate cancel was read as a network failure");
  monitor.stop();
});

test("a 500 means the gateway answered, so the connection is not lost", async () => {
  const h = harness();
  const monitor = createConnectionMonitor(h.host, { loadedAt: 1_000 });
  h.respond.mode = "server-error";
  await h.installed()("/v1/devices");
  await h.installed()("/v1/devices");
  assert.equal(monitor.view().lost, false, "an HTTP error is not a connection failure");
  monitor.stop();
});

test("going offline raises the banner at once, and coming back does not clear it alone", async () => {
  const h = harness();
  const monitor = createConnectionMonitor(h.host, { loadedAt: 1_000 });
  const seen: boolean[] = [];
  monitor.subscribe((view) => seen.push(view.lost));

  h.fire("offline");
  assert.equal(monitor.view().lost, true);

  // `online` means an interface came back, not that the gateway answers. The
  // banner has to stay up until something actually gets through, or it clears
  // itself on a captive portal and the numbers go back to looking current.
  h.respond.mode = "reject";
  h.fire("online");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(monitor.view().lost, true, "the banner cleared on an unproven connection");

  h.respond.mode = "ok";
  await monitor.probe();
  assert.equal(monitor.view().lost, false);
  assert.deepEqual(seen, [true, false], "listeners were told twice about the same state");
  monitor.stop();
});

test("the connection is re-checked while lost and left alone while it is fine", async () => {
  const h = harness();
  const monitor = createConnectionMonitor(h.host, { loadedAt: 1_000 });

  const before = h.calls.length;
  h.tick();
  assert.equal(h.calls.length, before, "a healthy console is polling the network for no reason");

  h.fire("offline");
  h.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(h.calls.length > before, "nothing re-checks while the banner is up");
  assert.ok(
    String(h.calls[h.calls.length - 1]).startsWith(PROBE_PATH),
    `the probe went somewhere else: ${String(h.calls[h.calls.length - 1])}`,
  );
  monitor.stop();
});

test("the probe is a static file, cache-busted, and outside the authenticated paths", () => {
  // Probing /api/ or /v1/ on a timer would keep a session warm that nobody is
  // using; and sw.js caches neither this path nor anything but /_next/static/
  // and /icon.svg, so a 200 here really came off the network.
  assert.equal(isWatchedRequest(PROBE_PATH, "https://a.vodoge.com"), false);
  assert.ok(!PROBE_PATH.startsWith("/v1/") && !PROBE_PATH.startsWith("/api/"));
  assert.ok(PROBE_INTERVAL_MS >= 5_000, "a tighter loop than this is a heartbeat, not a re-check");
});

test("stopping the monitor leaves nothing behind", async () => {
  const h = harness();
  const original = h.installed();
  const monitor = createConnectionMonitor(h.host, { loadedAt: 1_000 });
  h.fire("offline");
  monitor.stop();

  assert.equal(h.installed(), original);
  const before = h.calls.length;
  h.tick();
  await Promise.resolve();
  assert.equal(h.calls.length, before, "a stopped monitor is still polling");
  h.fire("offline");
  h.fire("online");
  assert.equal(h.calls.length, before, "a stopped monitor is still listening");
});

/* ── The service worker's principle, as a guard ──────────────────────── */

/**
 * The one thing this card was told it must not break.
 *
 * `sw.js` refuses to cache `/api/` and `/v1/`, because a cached fleet reading
 * is an operator acting on a number that is no longer true. The proof offered
 * for that in a receipt is a quote from a comment, which is worth nothing the
 * day someone edits the code below it. So the guard is read out of the code
 * with the comments stripped, and its position relative to everything that can
 * answer a request is checked.
 */
function serviceWorkerCode(): string {
  return readPublic("sw.js")
    .toString("utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("the service worker still refuses to cache the gateway", () => {
  const code = serviceWorkerCode();
  const guard = code.search(
    /if\s*\(\s*url\.pathname\.startsWith\(\s*["']\/api\/["']\s*\)\s*\|\|\s*url\.pathname\.startsWith\(\s*["']\/v1\/["']\s*\)\s*\)\s*return\s*;/,
  );
  assert.notEqual(guard, -1, "the /api/ and /v1/ guard is gone from public/sw.js");

  // Before anything that could answer or store a request, not merely present.
  // A guard below the first respondWith is a guard that does not run.
  for (const escape of ["respondWith", "caches.put", "cache.put", "caches.match"]) {
    const at = code.indexOf(escape);
    if (at === -1) continue;
    assert.ok(at > guard, `${escape} runs before the /api/ /v1/ guard, so the guard is decorative`);
  }
});

test("the service worker caches the shell and nothing that goes stale", () => {
  const code = serviceWorkerCode();
  // Only content-hashed build output and the icon are stored. Anything else
  // added to this list has to be a file whose bytes never change meaning.
  const cacheable = [...code.matchAll(/url\.pathname(?:\.startsWith\(|\s*===\s*)\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((path) => path !== "/api/" && path !== "/v1/");
  assert.deepEqual(cacheable.sort(), ["/_next/static/", "/icon.svg"]);
});

/**
 * The files `install` precaches, read straight out of sw.js, with each
 * identifier (e.g. OFFLINE_URL) resolved to its `const NAME = "..."`.
 *
 * Derived from the source rather than transcribed, so adding OR removing a
 * precached file is itself a change the digest below will see — the same reason
 * the cacheable list above is parsed instead of listed.
 */
function precachedPaths(code: string): string[] {
  const call = /addAll\(\s*\[([^\]]*)\]/.exec(code);
  assert.ok(call, "sw.js install no longer calls cache.addAll([...]) — this parser is stale");
  const paths = call[1]
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const literal = /^["']([^"']+)["']$/.exec(token);
      if (literal) return literal[1];
      const bound = new RegExp(`\\b${token}\\s*=\\s*["']([^"']+)["']`).exec(code);
      assert.ok(bound, `sw.js precaches \`${token}\` but nothing defines it as a string`);
      return bound[1];
    });
  assert.ok(paths.length > 0, "sw.js precaches nothing — this parser is stale");
  return paths.sort();
}

/**
 * A digest of the bytes every precached file will put in the cache.
 *
 * Line endings are normalised to LF first, on purpose: the repo is
 * autocrlf=true, so a working tree is CRLF on Windows and LF in the git blob,
 * and a digest that flipped with the checkout would be a false red on the next
 * machine to run this. Normalised, it is the content's own digest either way.
 */
function precacheDigest(paths: string[]): string {
  const perFile = paths.map((path) => {
    const lf = readPublic(path.replace(/^\//, "")).toString("latin1").replace(/\r\n/g, "\n");
    return `${path}:${createHash("sha256").update(lf, "latin1").digest("hex")}`;
  });
  return createHash("sha256").update(perFile.join("\n")).digest("hex");
}

/**
 * The precache digest recorded against each cache version.
 *
 * This is a frozen literal, NOT a value measured from the files it checks. A
 * digest recomputed from the same bytes on both sides would always agree with
 * them: it could catch "the digest was computed wrong" and never "a precached
 * file changed and nobody bumped the version" — which is the whole failure this
 * guards. The person who edits offline.html has no reason to open this file, so
 * the mismatch surfaces on their machine, in the run they were going to make.
 *
 * Bumping CACHE means adding the new version's digest here; the failure message
 * prints the exact line to paste. Past versions stay as a record.
 */
const PRECACHE_DIGESTS: Record<number, string> = {
  3: "aa289d84e9f88eb565630f623be3fd26b18afd93aba5e09ab88f13867b05e8b4",
};

test("the cache name is bumped when a precached file changes", () => {
  const code = serviceWorkerCode();
  // `install` is the only writer of these files and the browser only re-runs it
  // when the bytes of sw.js differ, so a precached file can change while every
  // already-installed console keeps the old bytes. Binding their digest to the
  // version is what makes that impossible to do silently.
  const version = /CACHE\s*=\s*["']vodoge-shell-v(\d+)["']/.exec(code);
  assert.ok(version, "the cache name no longer carries a version");
  const at = Number(version[1]);
  const digest = precacheDigest(precachedPaths(code));

  const recorded = PRECACHE_DIGESTS[at];
  assert.ok(
    recorded !== undefined,
    `CACHE is at v${at} but PRECACHE_DIGESTS has no entry for it. If you bumped the ` +
      `version, record this build's precache digest:\n    ${at}: "${digest}",`,
  );
  assert.equal(
    digest,
    recorded,
    `a precached file changed but CACHE is still v${at}: install will not re-run for ` +
      `consoles installed before the change, so they would serve the old shell ` +
      `forever. Bump CACHE and record\n    ${at + 1}: "${digest}",\nin PRECACHE_DIGESTS.`,
  );
});

/**
 * Run sw.js the way a browser would — execute its top level so its listeners
 * register — against a mock `self` and `caches`, and return the handlers with a
 * record of what it opened and deleted. This executes the real file, so the
 * claim that activate self-cleans on a bump is run, not read off the source.
 */
type SWEvent = { waitUntil(promise: Promise<unknown>): void };
type SWHandler = (event: SWEvent) => void;

function runServiceWorker(): { handlers: Record<string, SWHandler>; present: Set<string>; deleted: string[] } {
  const handlers: Record<string, SWHandler> = {};
  const present = new Set<string>();
  const deleted: string[] = [];
  const cacheApi = {
    keys: async () => [...present],
    open: async (name: string) => {
      present.add(name);
      return { addAll: async () => {}, put: async () => {} };
    },
    delete: async (name: string) => {
      deleted.push(name);
      return present.delete(name);
    },
    match: async () => undefined,
  };
  const swSelf = {
    addEventListener: (type: string, fn: SWHandler) => {
      handlers[type] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  // sw.js reads the bare globals `self`, `caches` and `URL`; pass all three so
  // running it touches nothing in the real environment.
  new Function("self", "caches", "URL", readPublic("sw.js").toString("utf8"))(swSelf, cacheApi, URL);
  return { handlers, present, deleted };
}

test("activate deletes every cache but the current one, so bumping self-cleans", async () => {
  const current = /CACHE\s*=\s*["'](vodoge-shell-v\d+)["']/.exec(serviceWorkerCode());
  assert.ok(current, "the cache name no longer carries a version");
  const sw = runServiceWorker();
  // What older workers and the runtime cache would have left behind, plus the
  // cache the current worker is about to serve from.
  for (const name of ["vodoge-shell-v1", "vodoge-shell-v2", current[1], "vodoge-runtime"]) {
    sw.present.add(name);
  }
  const activate = sw.handlers.activate;
  assert.ok(activate, "sw.js registered no activate handler");
  const waits: Promise<unknown>[] = [];
  activate({ waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);

  assert.ok(sw.present.has(current[1]), "activate deleted the cache the current worker serves from");
  assert.deepEqual(
    [...sw.present].sort(),
    [current[1]],
    "activate left an old cache behind, so a bump would not self-clean and caches pile up",
  );
});

/* ── The offline page ────────────────────────────────────────────────── */

test("the offline page ships both languages, with the same keys in each", () => {
  const html = readText(join("public", "offline.html"));
  const blocks: Record<string, string[]> = {};
  for (const match of html.matchAll(/<div data-lang="(zh|en)">([\s\S]*?)<\/div>/g)) {
    blocks[match[1]] = [...match[2].matchAll(/data-k="([^"]+)"/g)].map((m) => m[1]).sort();
  }
  assert.deepEqual(Object.keys(blocks).sort(), ["en", "zh"], "the offline page is monolingual");
  assert.ok(blocks.zh.length >= 3, "the offline page lost most of its copy");
  // The parity check `scripts/check-i18n.mjs` makes for messages/*.json and
  // cannot make here, because a static asset cannot read the catalogues.
  assert.deepEqual(blocks.zh, blocks.en, "the two languages of offline.html have drifted");
});

test("the offline page picks its language the same way the server does", () => {
  const html = readText(join("public", "offline.html"));
  assert.ok(
    html.includes(LOCALE_COOKIE.replace(".", "\\.")) || html.includes(LOCALE_COOKIE),
    `offline.html does not read ${LOCALE_COOKIE}, so it will disagree with every other page`,
  );
});

test("the offline page never claims to know how old the data is", () => {
  const html = readText(join("public", "offline.html")).replace(/<!--[\s\S]*?-->/g, "");
  // It is a static asset: it cannot know when this browser last heard from the
  // gateway, so any clock on it would be invented. That belongs to
  // components/connection-status.tsx, which is in a live tab.
  assert.ok(!/\d{1,2}:\d{2}/.test(html), "offline.html is printing something clock-shaped");
  assert.ok(!/toLocaleTimeString|getHours|Date\.now|new Date/.test(html));
});

/* ── The offline page's palette is a copy, so it is checked like one ───
 *
 * `public/offline.html` types dark-theme hexes in by hand, and it has to.
 * Nothing under `public/` is rewritten by a build step, Tailwind never scans
 * it, the service worker hands it over with no server in the loop, and it is
 * shown at exactly the moment the network is gone — so a `<link>` to the built
 * stylesheet would be both a content-hashed URL this file cannot keep in sync
 * and a fetch that by definition cannot succeed. T050 established that and
 * left a comment in the file saying so.
 *
 * A comment is read at the wrong end. The person who makes these values stale
 * is editing `app/globals.css` or `lib/tokens.ts` and has no reason to open a
 * static asset, so the note is in the one file they will not have in front of
 * them. This is the same statement pointed the other way round: it fails on
 * their machine, in the run they were going to make anyway.
 *
 * ## Why this reads globals.css rather than COLOR_TOKENS
 *
 * `lib/tokens.test.ts` already owns the `lib/tokens.ts` ⇄ `app/globals.css`
 * edge — it asserts `:root` declares exactly the dark column. Asserting
 * against the token table here as well would restate somebody else's check,
 * and worse, it would make a correctly synchronised palette change red until
 * every file involved had been touched, which is how a guard earns being
 * deleted. The claim made here is the narrower one nothing else makes:
 * *whatever the dark theme currently paints, the offline page paints the same
 * thing.* Change a token properly and this stays green. Change one side only
 * and it does not.
 */

/** The dark theme as `app/globals.css` actually declares it. */
function darkTokenValues(): Map<string, string> {
  // The light theme is `:root[data-theme="light"] {`, which does not contain
  // `:root {`, so the first hit is the dark block. Its body holds no nested
  // braces — the values are hexes and `rgba()` — so the next `}` closes it.
  const css = readText(join("app", "globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf(":root {");
  assert.notEqual(start, -1, "globals.css has no `:root {` block — this parser is stale");
  const body = css.slice(start + ":root {".length, css.indexOf("}", start));
  const values = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    values.set(name, value.trim());
  }
  // A floor, because an extractor that silently finds nothing would make every
  // comparison below vacuous and the whole section would pass reading colours
  // out of an empty map.
  assert.ok(values.size > 10, `only ${values.size} custom properties parsed out of globals.css`);
  return values;
}

/** `public/offline.html` with everything that is only prose taken out. */
function offlineMarkup(): string {
  return readText(join("public", "offline.html"))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The offline page's own rules, keyed by the selector exactly as written. */
function offlineRules(): Map<string, string> {
  const style = /<style>([\s\S]*?)<\/style>/.exec(offlineMarkup());
  assert.ok(style, "offline.html has no <style> block — this parser is stale");
  const rules = new Map<string, string>();
  for (const [, head, body] of style[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.set(head.trim(), body);
  }
  assert.ok(rules.size > 3, `only ${rules.size} rules parsed out of offline.html`);
  return rules;
}

/** One declaration out of one of those rules. */
function offlineDeclaration(rules: Map<string, string>, selector: string, property: string) {
  const body = rules.get(selector);
  assert.ok(body !== undefined, `offline.html has no \`${selector}\` rule — this parser is stale`);
  // Anchored on `;` or the start of the body so that `background-color` cannot
  // answer for `color`.
  const found = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body);
  assert.ok(found, `offline.html's \`${selector}\` no longer sets \`${property}\``);
  return found[1].trim();
}

/**
 * Every hex the offline page paints with, and the dark token each one copies.
 *
 * `where` is what a failure prints, so it names somewhere a reader can open
 * rather than a line number that moves the first time the file is edited.
 */
const OFFLINE_PALETTE: {
  token: string;
  where: string;
  hex: (rules: Map<string, string>) => string;
}[] = [
  {
    token: "--bg",
    where: '<meta name="theme-color">',
    hex: () => {
      const meta = /<meta\s+name="theme-color"\s+content="(#[0-9a-fA-F]{3,8})"/.exec(
        offlineMarkup(),
      );
      assert.ok(meta, "offline.html has no theme-color meta — this parser is stale");
      return meta[1];
    },
  },
  { token: "--bg", where: "body { background }", hex: (r) => offlineDeclaration(r, "body", "background") },
  { token: "--fg", where: "body { color }", hex: (r) => offlineDeclaration(r, "body", "color") },
  { token: "--fg-muted", where: "p { color }", hex: (r) => offlineDeclaration(r, "p", "color") },
  {
    token: "--accent",
    where: ".mark { background } gradient, first stop",
    hex: (r) => gradientStops(r)[0],
  },
  {
    token: "--accent-strong",
    where: ".mark { background } gradient, second stop",
    hex: (r) => gradientStops(r)[1],
  },
  { token: "--accent-ink", where: ".mark { color }", hex: (r) => offlineDeclaration(r, ".mark", "color") },
];

/** The two stops of `.mark`'s gradient, in the order they are painted. */
function gradientStops(rules: Map<string, string>): string[] {
  const background = offlineDeclaration(rules, ".mark", "background");
  const stops = [...background.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]);
  assert.equal(stops.length, 2, `.mark's gradient has ${stops.length} colour stops, not two`);
  return stops;
}

test("every colour on the offline page is still the dark token it was copied from", () => {
  const dark = darkTokenValues();
  const rules = offlineRules();
  const drifted: string[] = [];
  for (const copy of OFFLINE_PALETTE) {
    const declared = dark.get(copy.token);
    assert.ok(declared, `globals.css :root no longer declares ${copy.token}`);
    const painted = copy.hex(rules);
    if (painted.toLowerCase() !== declared.toLowerCase()) {
      drifted.push(`${copy.where} paints ${painted}, but ${copy.token} is now ${declared}`);
    }
  }
  // Listed rather than asserted one at a time so that a palette change that
  // missed several shows all of them in one run.
  assert.deepEqual(
    drifted,
    [],
    "the dark theme moved and public/offline.html did not follow — it is a hand-copy, so it has to be edited by hand",
  );
});

test("the offline page paints with nothing but those copies", () => {
  // Without this, a seventh hand-copied hex could be added tomorrow and the
  // check above would keep passing while knowing nothing about it. Comparing
  // the multiset also catches a colour moving from one declaration to another.
  const inFile = [...offlineMarkup().matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
    .map((m) => m[0].toLowerCase())
    .sort();
  const known = OFFLINE_PALETTE.map((copy) => copy.hex(offlineRules()).toLowerCase()).sort();
  assert.deepEqual(
    inFile,
    known,
    "a colour in public/offline.html is not one OFFLINE_PALETTE knows about, so nothing is checking it",
  );
});

/* ── The manifest matches the files on disk ──────────────────────────── */

/** Width and height straight out of the IHDR, which is always the first chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", "not a PNG");
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Decode far enough to read a pixel, because the size on its own proves nothing.
 *
 * The build of these icons shipped a real defect that every size check passed:
 * the headless browser will not lay a page out below about 466px, so the 192px
 * icons and the 180px apple icon were rendered into a 466-wide viewport and
 * cropped to their top-left corner — mostly blank, with a sliver of the V down
 * one edge, and exactly 192x192. The 512 was fine, so looking at one of them
 * proved nothing either. This is the check that catches it, and it doubles as
 * the one that catches a palette change that forgets to regenerate the files.
 */
function pngPixels(bytes: Buffer): {
  width: number;
  height: number;
  at(x: number, y: number): [number, number, number, number];
} {
  const { width, height } = pngSize(bytes);
  const depth = bytes[24];
  const colour = bytes[25];
  const interlace = bytes[28];
  assert.equal(depth, 8, "only 8-bit PNGs are read here");
  assert.equal(interlace, 0, "interlaced PNG");
  const bpp = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour];
  assert.ok(bpp, `unsupported colour type ${colour}`);

  const parts: Buffer[] = [];
  let at = 8;
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("ascii", at + 4, at + 8) === "IDAT") {
      parts.push(bytes.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = raw.subarray(read, read + stride);
    read += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      row[x] =
        (filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c)) & 0xff;
    }
  }

  return {
    width,
    height,
    at(x, y) {
      const i = y * stride + x * bpp;
      if (bpp >= 3) return [out[i], out[i + 1], out[i + 2], bpp === 4 ? out[i + 3] : 255];
      return [out[i], out[i], out[i], bpp === 2 ? out[i + 1] : 255];
    },
  };
}

const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const near = (got: readonly number[], want: readonly number[], slack: number) =>
  want.every((v, i) => Math.abs(got[i] - v) <= slack);

test("every icon the manifest declares exists at the size it claims", () => {
  const icons = consoleManifest().icons;
  assert.ok(icons.length > 0);
  for (const icon of icons) {
    if (icon.type === "image/svg+xml") {
      assert.ok(readPublic(icon.src.slice(1)).length > 0, `${icon.src} is missing`);
      continue;
    }
    // A manifest that claims 512 and ships 192 is silently downgraded by the
    // launcher and looks exactly like a correct one from the JSON.
    const { width, height } = pngSize(readPublic(icon.src.slice(1)));
    assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} is not ${icon.sizes}`);
  }
});

test("there is a real bitmap for both install paths, any and maskable", () => {
  const icons = consoleManifest().icons;
  const png = icons.filter((icon) => icon.type === "image/png");
  for (const purpose of ["any", "maskable"] as const) {
    const sizes = png.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes).sort();
    // 192 and 512 are what Chrome's install criteria are written against, and
    // an SVG satisfies them only by accident of parsing.
    assert.deepEqual(sizes, ["192x192", "512x512"], `purpose: ${purpose} has no usable bitmap`);
  }
});

test("iOS gets a PNG, because it ignores this manifest and cannot read SVG", () => {
  const { width, height } = pngSize(readPublic("apple-touch-icon.png"));
  assert.deepEqual({ width, height }, { width: 180, height: 180 });
  // Declared, or the file is on disk and nothing points at it.
  const layout = readText(join("app", "layout.tsx"));
  assert.match(layout, /apple:\s*\[[^\]]*apple-touch-icon\.png/);
});

/**
 * Where the artwork sits inside its own viewBox, measured from the SVG each
 * bitmap was rendered from.
 *
 * Writing the expected box down as numbers here would leave the SVGs free to be
 * redrawn without the PNGs being regenerated — the same drift the size check
 * exists to catch, one level up.
 */
function svgArtExtent(svg: string): { x: [number, number]; y: [number, number] } {
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  assert.ok(box, "no viewBox to measure against");
  const side = Number(box[1]);
  assert.equal(Number(box[2]), side, "these icons are square");
  const path = /\sd="([^"]+)"/.exec(svg);
  assert.ok(path, "no path to measure");
  const points = [...path[1].matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map(
    (match) => [Number(match[1]), Number(match[2])] as const,
  );
  assert.ok(points.length >= 3, "the mark has three points");
  const stroke = /stroke-width="([\d.]+)"/.exec(svg);
  assert.ok(stroke, "no stroke width");
  // Round caps and joins, so the stroke reaches exactly half its width past the
  // path in every direction.
  const grow = Number(stroke[1]) / 2;
  const span = (values: number[]): [number, number] => [
    (Math.min(...values) - grow) / side,
    (Math.max(...values) + grow) / side,
  ];
  return { x: span(points.map((p) => p[0])), y: span(points.map((p) => p[1])) };
}

/** Which SVG each bitmap is a rasterisation of. */
const ICON_SOURCES: Record<string, string> = {
  "icon-192.png": "icon.svg",
  "icon-512.png": "icon.svg",
  "apple-touch-icon.png": "icon.svg",
  "icon-maskable-192.png": "icon-maskable.svg",
  "icon-maskable-512.png": "icon-maskable.svg",
};

test("each icon is the whole drawing rather than a corner of it", () => {
  const accent = rgbOf(COLOR_TOKENS.accent.dark);
  const background = rgbOf(COLOR_TOKENS.bg.dark);

  for (const [png, svg] of Object.entries(ICON_SOURCES)) {
    const want = svgArtExtent(readPublic(svg).toString("utf8"));
    const image = pngPixels(readPublic(png));

    let minX = Infinity;
    let maxX = -1;
    let minY = Infinity;
    let maxY = -1;
    let hits = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const pixel = image.at(x, y);
        // Slack, because the mark is antialiased against the background at
        // every edge and only its interior is the flat token colour.
        if (pixel[3] < 200 || !near(pixel, accent, 40)) continue;
        hits++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    assert.ok(hits > 0, `${png} has no mark in it at all — it is a blank square`);

    // Exact, not slack: this is flat fill, and a near miss here means the
    // palette moved and these files were not regenerated with it.
    assert.ok(
      near(image.at(image.width >> 1, Math.round(image.height * 0.08)), background, 2),
      `${png} is not on the token background — regenerate it after a palette change`,
    );

    // The defect this catches shipped and passed every size check: the
    // headless browser these were rendered in will not lay out below about
    // 466px, so the 192s and the 180 came back as the top-left corner of a
    // 466-wide page — exactly 192x192, mostly empty, a sliver of the mark down
    // one edge. The 512 was fine, so opening one of them proved nothing.
    const edges: [string, number, number][] = [
      ["left", minX / image.width, want.x[0]],
      ["right", (maxX + 1) / image.width, want.x[1]],
      ["top", minY / image.height, want.y[0]],
      ["bottom", (maxY + 1) / image.height, want.y[1]],
    ];
    for (const [side, got, expected] of edges) {
      assert.ok(
        Math.abs(got - expected) <= 0.03,
        `${png}: the mark's ${side} edge is at ${got.toFixed(3)} of the image, ` +
          `but ${svg} puts it at ${expected.toFixed(3)}`,
      );
    }
  }
});

test("the install dialog has a screenshot of each shape, at the declared size", () => {
  const shots = consoleManifest().screenshots;
  const factors = shots.map((shot) => shot.form_factor).sort();
  // Chromium only shows the richer install dialog when it has both.
  assert.deepEqual(factors, ["narrow", "wide"]);
  for (const shot of shots) {
    const { width, height } = pngSize(readPublic(shot.src.slice(1)));
    assert.equal(`${width}x${height}`, shot.sizes, `${shot.src} is not ${shot.sizes}`);
    // Chromium rejects a screenshot outside roughly 1:2.3, and a rejected one
    // takes the whole rich dialog down with it.
    const ratio = width / height;
    assert.ok(ratio > 0.43 && ratio < 2.3, `${shot.src} has an unusable aspect ratio ${ratio}`);
  }
});

/* ── What the install dialog actually shows a person ──────────────────
 *
 * The size check above was the only thing looking at these two files, and it
 * is the same check that let five cropped icons ship. It cannot see colour and
 * it cannot see composition, and both had gone wrong here at once:
 *
 *   - Every pixel was the old green palette. 13 of 15 retired tokens were
 *     present in the narrow file and none of the new ones were — not partial
 *     drift, the entire picture.
 *   - Worse, the picture was of a page this console has never had: four stat
 *     cards and a device table headed 机队总览. The real overview has three
 *     stat cards and a recent-messages table headed 总览. `git show
 *     12b1ef7:apps/console/app/page.tsx` — the commit that added these very
 *     files — already had the three-card shape, and not one of the strings in
 *     the old images exists in messages/zh.json. They were drawn, not taken.
 *
 * Recolouring a drawing of a page that does not exist would have made it more
 * convincing, not less wrong, so both files are now captured from the real
 * page under a stub gateway serving synthetic data.
 *
 * 🔴 THESE ARE VIEWPORT SCREENSHOTS, NOT WHOLE-PAGE IMAGES, AND THEY CANNOT BE.
 * At 390 CSS px the messages table does not begin until y=818, and the page is
 * 931 CSS px tall even with every row hidden — against a declared frame of 844
 * (=1688/2). No demo data fits it. Nor does any legal reframing: at 780 wide,
 * Chromium's 0.43 aspect floor caps the height at about 907 CSS px, and the
 * page's own floor is 931. There is no honest 780x1688 that holds the whole
 * page, so what these show is the top of a page that scrolls — which is what a
 * phone screenshot is.
 *
 * That is emphatically NOT the defect the icons shipped with. That one was a
 * LAYOUT WIDTH that disagreed with the frame — laid out at 466, framed at 192,
 * so the composition itself was wrong while the size was right. The two checks
 * below are what tell those apart: the palette has to be the current one, and
 * the layout has to have been done at the frame's own width.
 */

const COLOURS: Record<string, Record<string, string>> = COLOR_TOKENS;
const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const unpack = (v: number): [number, number, number] => [v >> 16, (v >> 8) & 0xff, v & 0xff];
const hexOf = (v: number) => "#" + v.toString(16).padStart(6, "0");

/**
 * Every colour the palette this console ships can put on a dark screen.
 *
 * Derived from COLOR_TOKENS and nothing else — no list of names anywhere in
 * this file. Two kinds go in:
 *
 *   - the opaque values, deduplicated BY VALUE, because a pixel cannot tell
 *     `--fg` from `--accent` when both are #f5f5f5;
 *   - every wash composited over every opaque value, and over those
 *     composites, because a wash is a tint and lands as the blend rather than
 *     as its own rgba(). Two deep is the same superset lib/contrast.test.ts
 *     reasons about, and it is the depth the console can actually stack.
 */
function paintableColours(): Map<number, string> {
  const opaque: [string, [number, number, number]][] = [];
  const washes: [string, [number, number, number], number][] = [];
  for (const [name, value] of Object.entries(COLOURS)) {
    const dark = value.dark.toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(dark)) {
      opaque.push([name, rgbOf(dark)]);
      continue;
    }
    const parts = dark.match(/rgba\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)[,\s]+([0-9.]+)\s*\)/);
    if (parts) {
      washes.push([name, [Number(parts[1]), Number(parts[2]), Number(parts[3])], Number(parts[4])]);
    }
  }
  assert.ok(opaque.length > 0 && washes.length > 0, "COLOR_TOKENS parsed to nothing");

  // Two roundings, because the browser and the arithmetic disagree by one.
  // Chromium quantises alpha to 8 bits BEFORE compositing, so `--accent-wash`
  // at 0.1 is 26/255 and lands on #252525 over `--surface`, where exact
  // arithmetic says #242424. Measured off the real capture, not assumed —
  // #252525 covers 1,876 px of the wide frame and was the largest colour the
  // first draft of this could not explain.
  const roundings: ((
    tint: [number, number, number],
    alpha: number,
    base: [number, number, number],
  ) => [number, number, number])[] = [
    (tint, alpha, base) => [
      Math.round(alpha * tint[0] + (1 - alpha) * base[0]),
      Math.round(alpha * tint[1] + (1 - alpha) * base[1]),
      Math.round(alpha * tint[2] + (1 - alpha) * base[2]),
    ],
    (tint, alpha, base) => {
      const a8 = Math.round(alpha * 255);
      return [
        Math.round((a8 * tint[0] + (255 - a8) * base[0]) / 255),
        Math.round((a8 * tint[1] + (255 - a8) * base[1]) / 255),
        Math.round((a8 * tint[2] + (255 - a8) * base[2]) / 255),
      ];
    },
  ];

  const found = new Map<number, string>();
  let layer: [string, [number, number, number]][] = [];
  for (const [name, rgb] of opaque) {
    const key = pack(...rgb);
    if (!found.has(key)) found.set(key, `--${name}`);
    layer.push([`--${name}`, rgb]);
  }
  for (let depth = 0; depth < 2; depth++) {
    const next: [string, [number, number, number]][] = [];
    for (const [why, base] of layer) {
      for (const [name, tint, alpha] of washes) {
        for (const round of roundings) {
          const blended = round(tint, alpha, base);
          const key = pack(...blended);
          if (!found.has(key)) {
            found.set(key, `--${name} over ${why}`);
            next.push([`--${name} over ${why}`, blended]);
          }
        }
      }
    }
    layer = next;
  }
  return found;
}

/**
 * Antialiasing slack. A glyph edge is a straight blend between the ink and
 * whatever is behind it, so it lands ON the segment joining two paintable
 * colours — one shared fraction for all three channels.
 *
 * 🔴 **That is only true because the capture disables LCD text.** At dpr=1
 * Chromium subpixel-antialiases by default: R, G and B interpolate
 * INDEPENDENTLY, which fills the whole axis-aligned box between ink and
 * backdrop rather than the segment across it. Measured consequence — the
 * retired #63a4ff is a perfectly legal per-channel blend of #0d0d0d and the
 * current #97c3ff, so under subpixel antialiasing no arithmetic can tell a
 * dead token from a live glyph edge. The capture recipe records the flag and
 * the reason; if these files are ever recaptured without it this test goes red
 * on hundreds of colour fringes, which is the safe direction.
 */
const BLEND_SLACK = 3;

/**
 * 🔴 WHICH SEGMENTS EXIST — and why the palette was the wrong set to draw them
 * between. This is the repair for four blind spots, and it does not move
 * BLEND_SLACK by so much as a hundredth.
 *
 * The slack above says how far OFF a segment a pixel may sit. It said nothing
 * about which segments there are, and the rule offered the whole palette: all
 * 701 values, every one paired with every other, **245,350 segments** ruled
 * across the colour cube. At that density a dead colour does not have to be
 * plausible, only lucky — and four of them were. T016 §4 injected one pixel of
 * each into the real capture and watched the rule stay green:
 *
 *     #0b0e14   #64708a   #93a1b5   #e7ecf3
 *
 * `#64708a` is the worst of them, and not by accident: it is the 2.688
 * `--fg-faint` this whole board was opened to fix. It sits on the segment
 * `#404a59` -> `#acbcec` at t=1/3 and hits ALL THREE CHANNELS EXACTLY —
 * r 64+(172-64)/3 = 100, g 74+(188-74)/3 = 112, b 89+(236-89)/3 = 138, maxerr
 * 0.000. **A tolerance cannot separate a colour that is not off the segment at
 * all**, so tightening the slack was never available as a repair, and lowering
 * it to the measured innocent ceiling would have changed nothing here.
 *
 * What is wrong with that segment is not arithmetic, it is physics.
 * **#404a59 and #acbcec are not in the screenshot — neither of them, not one
 * pixel, in either frame.** They are two colours the palette CAN mix, joined
 * by a line that happens to pass through a dead value. An antialiased pixel is
 * coverage blending at a boundary between two things that are both ON THE
 * PAGE, so its endpoints have to be on the page too.
 *
 * Presence alone is still not it, and the wide frame is what says so: #0b0e14
 * lies 0.400 off `#010102` -> `#19222f` and BOTH of those are present. But
 * `#010102` is the page canvas and `#19222f` is the fill inside an info badge,
 * and there is nowhere on this page those two touch. A boundary needs its two
 * sides in the same place.
 *
 * So the endpoints are derived from the frame's own pixels: two paintable
 * colours may explain a blend only where the frame contains somewhere they
 * MEET. Nothing is enumerated, nothing is named, no history is read. Retire a
 * token and it stops being able to explain anything the same day, with nobody
 * editing this file — which is the property the hand-written list of eight
 * token names did not have, and the reason a retired colour shipped.
 *
 * Measured on these two frames (narrow / wide):
 *
 *   candidate segments      245,350  ->     321  /    290
 *   worst INNOCENT residual   0.682  ->   1.000  /  1.019     (slack is 3)
 *   #0b0e14                   0.253  ->   5.300  /  4.471
 *   #64708a                   0.000  ->  33.167  / 12.718
 *   #93a1b5                   0.115  ->  30.733  / 30.733
 *   #e7ecf3                   0.462  ->  11.533  / 11.533
 *   #63a4ff (already caught) 39.000  -> 151.133  / 52.000
 *
 * 🔴 **BLEND_SLACK IS UNCHANGED AT 3, and no assertion anywhere was loosened.**
 * Only the set of admissible endpoints moved. That is deliberate: "the guard
 * got stricter" and "the guard got correct" are different claims, and a guard
 * that catches dead colours by refusing legitimate antialiasing has not been
 * repaired, it has been broken in the direction nobody notices until a
 * recapture goes red and somebody widens the tolerance back. The innocent
 * ceiling is 1.019 against a slack of 3, so real glyph edges keep 2.9x of
 * room, while the tightest dead colour now needs 4.471.
 *
 * The tile size is not a tuned knob. Swept at 4, 8, 16, 32 and 64 px, with and
 * without the ring — ten settings, and at every one of them all four dead
 * colours are red and ZERO innocent colours are; the tightest margin (#0b0e14
 * in the wide frame) does not move at all. Regenerate the sweep, and the
 * synthetic-antialiasing control below, with `scratchpad/t017/probe4.mjs`.
 */
const MEET_TILE = 16;

/**
 * Which paintable colours meet somewhere in this image.
 *
 * Tiles rather than exact neighbourhoods: a boundary is one to three pixels of
 * ramp, so the two sides only have to be NEAR one another, and the one-tile
 * ring keeps a boundary that straddles a tile edge counted. Both choices lean
 * the same way on purpose — MISSING a real meeting is what would turn an
 * honest recapture red, and that is the failure that gets a guard deleted.
 */
function meetingPairs(
  image: { width: number; height: number; at(x: number, y: number): [number, number, number, number] },
  paintable: Map<number, string>,
): [number, number, number][][] {
  const cols = Math.ceil(image.width / MEET_TILE);
  const rows = Math.ceil(image.height / MEET_TILE);
  const tiles = new Map<number, Set<number>>();
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const p = image.at(x, y);
      const key = pack(p[0], p[1], p[2]);
      if (!paintable.has(key)) continue;
      let seen = tiles.get(key);
      if (!seen) tiles.set(key, (seen = new Set()));
      seen.add(((y / MEET_TILE) | 0) * cols + ((x / MEET_TILE) | 0));
    }
  }
  const reach = new Map<number, Set<number>>();
  for (const [key, seen] of tiles) {
    const grown = new Set<number>();
    for (const t of seen) {
      const ty = (t / cols) | 0;
      const tx = t % cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = ty + dy;
          const nx = tx + dx;
          if (ny >= 0 && ny < rows && nx >= 0 && nx < cols) grown.add(ny * cols + nx);
        }
      }
    }
    reach.set(key, grown);
  }
  const present = [...tiles.keys()];
  const pairs: [number, number, number][][] = [];
  for (let i = 0; i < present.length; i++) {
    const mine = tiles.get(present[i])!;
    for (let j = i + 1; j < present.length; j++) {
      const theirs = reach.get(present[j])!;
      for (const t of mine) {
        if (theirs.has(t)) {
          pairs.push([unpack(present[i]), unpack(present[j])]);
          break;
        }
      }
    }
  }
  return pairs;
}

/** Is `c` on a straight blend between two paintable colours that meet here? */
function isGlyphEdge(c: [number, number, number], pairs: [number, number, number][][]): boolean {
  for (const [a, b] of pairs) {
    // Bounding box first; it rejects almost every pair for almost no work.
    if (c[0] < Math.min(a[0], b[0]) - BLEND_SLACK || c[0] > Math.max(a[0], b[0]) + BLEND_SLACK) continue;
    if (c[1] < Math.min(a[1], b[1]) - BLEND_SLACK || c[1] > Math.max(a[1], b[1]) + BLEND_SLACK) continue;
    if (c[2] < Math.min(a[2], b[2]) - BLEND_SLACK || c[2] > Math.max(a[2], b[2]) + BLEND_SLACK) continue;
    // Take the shared fraction off the channel with the most to say.
    let axis = 0;
    let span = Math.abs(a[0] - b[0]);
    for (let k = 1; k < 3; k++) {
      const d = Math.abs(a[k] - b[k]);
      if (d > span) {
        span = d;
        axis = k;
      }
    }
    if (span < 8) continue;
    const t = (c[axis] - a[axis]) / (b[axis] - a[axis]);
    if (t < -0.02 || t > 1.02) continue;
    if (
      Math.abs(a[0] + t * (b[0] - a[0]) - c[0]) <= BLEND_SLACK &&
      Math.abs(a[1] + t * (b[1] - a[1]) - c[1]) <= BLEND_SLACK &&
      Math.abs(a[2] + t * (b[2] - a[2]) - c[2]) <= BLEND_SLACK
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Every distinct colour in a screenshot, with its pixel count. The decoded
 * image comes back too, so a caller that also needs the geometry — which
 * colours MEET which — does not pay for a second inflate.
 */
function colourCensus(name: string): {
  counts: Map<number, number>;
  width: number;
  height: number;
  image: ReturnType<typeof pngPixels>;
} {
  const image = pngPixels(readPublic(name));
  const counts = new Map<number, number>();
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const p = image.at(x, y);
      const key = pack(p[0], p[1], p[2]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return { counts, width: image.width, height: image.height, image };
}

/*
 * 🔴 THERE USED TO BE A HAND-WRITTEN LIST OF EIGHT TOKEN NAMES HERE, AND IT IS
 * WHY A RETIRED COLOUR SHIPPED.
 *
 * The list named the tokens the overview paints and deliberately left the four
 * status colours out, on the reasoning that a token the page does not paint
 * cannot make the screenshot stale. The reasoning is sound and the list was
 * accurate the day it was written. Then T010 retired `--info` #63a4ff, nobody
 * rescanned, and the install dialog went on showing 26 pixels of a dead colour
 * with every check green — because no listed token had moved, and the 0.9
 * token-share floor cannot feel 26 pixels against a measured 97.4%.
 *
 * The replacement asks the question the other way round, which needs no list
 * at all: instead of "are the tokens I remember still here?", it asks **"is
 * every colour in this file one the palette can still produce?"** A retired
 * value fails that on its first pixel. 26 is as red as 26,000.
 *
 * This is the third time on this board that a hand-enumerated set under-
 * reported, and the first time it happened inside a guard written specifically
 * to stop palette drift.
 */

test("no colour in the install dialog's screenshots is outside the palette this console ships", () => {
  const paintable = paintableColours();
  // Non-vacuity: a palette that derived to nothing would pass everything.
  assert.ok(paintable.size > 40, `only ${paintable.size} paintable colours derived`);

  for (const shot of consoleManifest().screenshots) {
    const { counts, width, height, image } = colourCensus(shot.src.slice(1));
    const pairs = meetingPairs(image, paintable);
    // Non-vacuity for the new half, and it fails the safe way round: with no
    // meeting pairs nothing could be explained and every antialiased pixel in
    // the file would be reported, so this floor is about a broken derivation
    // rather than about a clean frame. 321 narrow / 290 wide when written.
    assert.ok(pairs.length > 50, `only ${pairs.length} meeting pairs in ${shot.src}`);
    const foreign: [number, number][] = [];
    let exact = 0;
    for (const [key, n] of counts) {
      if (paintable.has(key)) {
        exact += n;
        continue;
      }
      if (isGlyphEdge(unpack(key), pairs)) continue;
      foreign.push([key, n]);
    }
    foreign.sort((a, b) => b[1] - a[1]);

    assert.deepEqual(
      foreign.map(([key, n]) => `${hexOf(key)} x${n}`),
      [],
      `${shot.src} contains colours this palette cannot produce — either a token was retired ` +
        `and this file was not recaptured, or the capture used subpixel antialiasing`,
    );

    // The counterweight, kept: every colour could be legal while the frame was
    // mostly something else. 96.9% / 97.4% when T013 captured; 97.0% / 97.1% now.
    const share = exact / (width * height);
    assert.ok(
      share >= 0.9,
      `only ${(share * 100).toFixed(1)}% of ${shot.src} is an exact palette colour`,
    );
  }
});

/**
 * 🔴 The mutation test for the rule above, kept in the suite instead of in a
 * scratchpad, because the hole it closes was found by mutation and NOTHING IN
 * THE REPOSITORY WOULD HAVE SHOWN IT. Every check was green, twice, across two
 * gates, while one pixel of the colour this board exists to retire could have
 * walked straight through.
 *
 * These four hexes are a FIXTURE, not the rule. Nothing above consults them
 * and nothing above would change if they were deleted — the repair is that
 * endpoints must meet on the page, and it names no colours at all. They are
 * here for the same reason TOP_PROFILE is: they are a measurement somebody
 * made on a real capture (T016 §4), and a measurement nobody re-runs is a
 * measurement that quietly stops being true.
 *
 * 🔴 What makes this a mutation test rather than a restatement is the SECOND
 * half. Catching dead colours is easy if you are willing to reject real
 * antialiasing too, and a guard that does that gets its tolerance widened back
 * by the next person who hits a false red — so the control is not decorative.
 * There are two of them and they are NOT of equal strength, which is worth
 * saying plainly rather than reporting one big number:
 *
 *   REAL (the strong one). Every non-exact colour in the two captures — 401
 *     narrow and 383 wide, 784 actual antialiasing values off a real page —
 *     must still be explained. These come from the PNG, not from this file,
 *     so nothing about how the rule is built can flatter them. Worst residual
 *     measured across all 784 is 1.019 against a slack of 3.
 *
 *   SYNTHETIC (the weak one, and weak in a specific way). Every 8-bit coverage
 *     step across every meeting pair, ~69,400 narrow and ~64,100 wide. Note
 *     what this can and cannot show: the blends are generated FROM the pair
 *     set and then handed back to it, so it is close to a self-consistency
 *     check. It is kept because self-consistency is exactly what dies if
 *     somebody squeezes BLEND_SLACK — at slack 0 the compositing rounding
 *     alone would fail it — and it covers coverage fractions the real capture
 *     never happened to produce. It is not evidence that the rule handles
 *     antialiasing it has not been told about; the 784 above are.
 *
 * Both halves have to hold at once. Only the pairing of them says the rule
 * found the real difference rather than a smaller tolerance.
 *
 * Every branch is counted rather than assumed, and the counts are separate. A
 * loop that skipped every case reports the same silent success as one that
 * caught every case — the shape that has already produced a false clean sweep
 * twice on this repository.
 */
const WAS_BLIND_T016 = ["#0b0e14", "#64708a", "#93a1b5", "#e7ecf3"];
const ALREADY_CAUGHT_T016 = ["#63a4ff", "#f2686d", "#10b47a"];

test("one pixel of a retired colour cannot hide in the install dialog's screenshots", () => {
  const paintable = paintableColours();
  let injected = 0;
  let real = 0;
  let blends = 0;

  for (const shot of consoleManifest().screenshots) {
    const { counts, image } = colourCensus(shot.src.slice(1));
    const pairs = meetingPairs(image, paintable);

    // ── 🔴 POSITIVE CONTROL, the strong one: real antialiasing off the page ──
    // Also the baseline. Against a frame that is already dirty every injection
    // below "passes" for the wrong reason and the whole test means nothing.
    for (const [key] of counts) {
      if (paintable.has(key)) continue;
      real++;
      assert.ok(
        isGlyphEdge(unpack(key), pairs),
        `${shot.src}: ${hexOf(key)} is a colour this capture actually contains and the rule can ` +
          `no longer explain it — the pair restriction has started rejecting honest antialiasing`,
      );
    }

    // ── CAUGHT: a single pixel of a retired value has to be visible ────────
    for (const hex of [...WAS_BLIND_T016, ...ALREADY_CAUGHT_T016]) {
      const c = rgbOf(hex);
      // If a retired value ever returns to the palette this stops being a
      // mutant and starts being a legal colour, and saying so beats failing
      // with a message about antialiasing.
      assert.ok(!paintable.has(pack(...c)), `${hex} is a palette colour again — this fixture is stale`);
      injected++;
      assert.ok(
        !isGlyphEdge(c, pairs),
        `${shot.src}: one pixel of the retired ${hex} is explicable as a glyph edge, so this ` +
          `guard cannot see it. That is the T016 §4 blind spot reopening — the endpoints of ` +
          `a blend must be two colours that MEET in this frame`,
      );
    }

    // ── POSITIVE CONTROL, the weak one: self-consistency at every coverage ──
    for (const [a, b] of pairs) {
      for (let a8 = 1; a8 < 255; a8++) {
        const c: [number, number, number] = [
          Math.round((a8 * b[0] + (255 - a8) * a[0]) / 255),
          Math.round((a8 * b[1] + (255 - a8) * a[1]) / 255),
          Math.round((a8 * b[2] + (255 - a8) * a[2]) / 255),
        ];
        // Exact palette hits never reach the blend rule at all.
        if (paintable.has(pack(...c))) continue;
        blends++;
        assert.ok(
          isGlyphEdge(c, pairs),
          `${shot.src}: ${hexOf(pack(...c))} is ${a8}/255 coverage of ${hexOf(pack(...b))} over ` +
            `${hexOf(pack(...a))}, two colours this frame says meet — rejecting it means the ` +
            `rule now turns honest antialiasing red`,
        );
      }
    }
  }

  // Counted apart, so a skipped branch cannot read as a passing one.
  // CAUGHT: 7 retired values x 2 frames. SKIP would show up here as a shortfall.
  assert.equal(injected, 14, `only ${injected} of 14 single-pixel injections were made`);
  // GREEN, real: 401 narrow + 383 wide when written.
  assert.ok(real > 700, `only ${real} real antialiasing colours were checked`);
  // GREEN, synthetic: ~133,500 when written.
  assert.ok(blends > 100000, `only ${blends} synthetic antialiasing steps were tested`);
});

/**
 * The pairing rule, and the one that would have caught this card's defect on
 * its own — including in a frame captured with subpixel antialiasing.
 *
 * A status wash is only ever painted behind that status token's own word:
 * `BADGE.tone.info` is `bg-info-wash text-info`, and the four tones are built
 * the same way. So a wash and its ink travel together, and a frame that shows
 * `--info-wash` while showing no `--info` is a frame whose blue word is some
 * other blue — which is exactly what shipped.
 *
 * Derived by name from the `-wash` suffix, the same convention lib/contrast
 * .test.ts classifies roles by, so a fifth status tone is covered the day it
 * is added. Silent for a wash that does not appear; a wash the overview never
 * paints cannot say anything about the ink.
 */
test("a status wash never appears in a screenshot without the word it sits behind", () => {
  const opaque: [string, [number, number, number]][] = [];
  const washes: [string, [number, number, number], number][] = [];
  for (const [name, value] of Object.entries(COLOURS)) {
    const dark = value.dark.toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(dark)) opaque.push([name, rgbOf(dark)]);
    const parts = dark.match(/rgba\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)[,\s]+([0-9.]+)\s*\)/);
    if (parts) {
      washes.push([name, [Number(parts[1]), Number(parts[2]), Number(parts[3])], Number(parts[4])]);
    }
  }
  const surfaces = opaque.filter(([name]) => /^(bg|surface)(-|$)/.test(name));
  assert.ok(surfaces.length >= 4, `only ${surfaces.length} surface tiers found`);
  assert.ok(washes.length >= 4, `only ${washes.length} washes found`);

  // Both frames together: the narrow one crops the page higher up, so a badge
  // can be in one and not the other, and neither alone is the whole answer.
  const total = new Map<number, number>();
  for (const shot of consoleManifest().screenshots) {
    for (const [key, n] of colourCensus(shot.src.slice(1)).counts) {
      total.set(key, (total.get(key) ?? 0) + n);
    }
  }

  for (const [washName, tint, alpha] of washes) {
    const inkName = washName.replace(/-wash$/, "");
    const ink = COLOURS[inkName];
    if (!ink || !/^#[0-9a-f]{6}$/.test(ink.dark.toLowerCase())) continue;
    let washPixels = 0;
    for (const [, base] of surfaces) {
      const key = pack(
        Math.round(alpha * tint[0] + (1 - alpha) * base[0]),
        Math.round(alpha * tint[1] + (1 - alpha) * base[1]),
        Math.round(alpha * tint[2] + (1 - alpha) * base[2]),
      );
      washPixels += total.get(key) ?? 0;
    }
    if (washPixels === 0) continue;
    const inkPixels = total.get(pack(...rgbOf(ink.dark.toLowerCase()))) ?? 0;
    assert.ok(
      inkPixels > 0,
      `the screenshots show ${washPixels} pixels of --${washName} but not one pixel of ` +
        `--${inkName} (${ink.dark}) — the word inside that badge is painted in some other ` +
        `colour, so these files predate the current --${inkName}`,
    );
  }
});

/**
 * Presence, and it is not the same question as the one above.
 *
 * 🔴 The blend rule has a blind spot, found by mutation rather than by
 * reasoning: a NEUTRAL token can move and its stale pixels stay explicable,
 * because every neutral grey lies on the segment between `--fg` and `--bg`.
 * Four mutants walked through it — `--fg-faint`, `--fg-strong`, `--fg-muted`
 * and a one-step nudge — all green. The hand-written list this replaced would
 * have caught every one of them, and trading one hole for another is not a
 * repair.
 *
 * Nor can area separate them: the largest innocent antialiasing grey in these
 * frames is 2,136 px and a stale `--fg-faint` would leave 1,967. Nor can mere
 * presence of the new value, because the ramp is continuous — #a8a8a8 already
 * occurs 79 times without being anybody's token.
 *
 * What works is the floor the old check used, kept: a token that really paints
 * type or chrome covers HUNDREDS of pixels, and a value that moved covers
 * essentially none of them. So the floor stays at 500. What changes is that
 * the SET is now derived, by two rules applied together:
 *
 *   ① its ROLE is surface, line or text — the patterns lib/contrast.test.ts
 *     already classifies by. Status fills and inks are out: a status colour
 *     appears only when that state occurs, and a demo fleet has no duty to
 *     exhibit every state at once. `--ok`, `--bad` and `--bad-ink` really are
 *     absent here. They are guarded instead by the wash pairing above and by
 *     the blend rule, both of which see a status colour move.
 *
 *   ② SOME RECIPE PAINTS IT. This is what excuses `--fg-strong`, and it is a
 *     reason rather than an exemption: no recipe in this design system paints
 *     `--fg-strong` at all — zero `text-fg-strong` anywhere — so demanding it
 *     in a photograph of a page is demanding something the page cannot
 *     contain. The day a recipe starts using it, this starts requiring it,
 *     with nobody editing this file.
 *
 * Where the floor is applied is itself decided by role, and the difference is
 * load-bearing rather than tidy:
 *
 *   surface / text — 500 IN EACH FRAME. Surfaces are regions and type is type;
 *     both are on every page at both widths.
 *   line           — 500 ACROSS THE PAIR, because a hairline genuinely can be
 *     scarce in one frame. `--line-strong` is 528 narrow against 132 wide, and
 *     that is the whole reason the old list dropped it.
 *
 * 🔴 Taking the count across the pair for EVERYTHING was a draft of this, and
 * mutation caught it: `--fg-faint` -> #8a8a8a survived, because #8a8a8a occurs
 * as innocent antialiasing 485 times in the narrow frame and 437 in the wide
 * one — under the floor in each, over it when added. The old guard caught that
 * mutant and this one did not, which made it a regression rather than a
 * repair, so the floor went back per-frame for the two roles that can bear it.
 */
test("the install dialog's screenshots show the chrome this console is built from", () => {
  // Which tokens any recipe paints, scanned out of the recipe strings the same
  // way lib/contrast.test.ts does it, rather than listed here.
  const painted = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(
        /(?:^|\s)(?:[a-z-]+:)*(?:text|bg|border|from|to|via|fill|stroke|ring|outline)-([a-z0-9-]+)(?=\s|$)/g,
      )) {
        if (Object.hasOwn(COLOURS, m[1])) painted.add(m[1]);
      }
    } else if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value && typeof value === "object") for (const v of Object.values(value)) walk(v);
  };
  walk(ALL_TOKENS);
  assert.ok(painted.size >= 10, `only ${painted.size} painted tokens found — recipe scan broke`);

  const isChrome = (name: string) =>
    /^(bg|surface)(-|$)/.test(name) || /^line(-|$)/.test(name) || /^fg(-|$)/.test(name);
  const required = Object.entries(COLOURS).filter(
    ([name]) => isChrome(name) && painted.has(name),
  );
  assert.ok(required.length >= 9, `only ${required.length} chrome tokens are painted by a recipe`);
  assert.ok(
    !required.some(([name]) => name === "fg-strong"),
    "a recipe now paints --fg-strong, so it should be required — update the note, not this rule",
  );

  const surfaces = required.filter(([name]) => /^(bg|surface)(-|$)/.test(name));
  assert.equal(surfaces.length, 4, "the surface ladder is no longer four tiers");

  const perShot = new Map<string, Map<number, number>>();
  const total = new Map<number, number>();
  for (const shot of consoleManifest().screenshots) {
    const { counts } = colourCensus(shot.src.slice(1));
    perShot.set(shot.src, counts);
    for (const [key, n] of counts) total.set(key, (total.get(key) ?? 0) + n);
  }

  const FLOOR = 500;
  for (const [name, value] of required) {
    const hex = value.dark.toLowerCase();
    const key = pack(...rgbOf(hex));
    if (/^line(-|$)/.test(name)) {
      const n = total.get(key) ?? 0;
      assert.ok(
        n >= FLOOR,
        `--${name} (${hex}) covers ${n} pixels across the two screenshots — the palette moved ` +
          `and these files were not recaptured with it`,
      );
      continue;
    }
    for (const [src, counts] of perShot) {
      const n = counts.get(key) ?? 0;
      assert.ok(
        n >= FLOOR,
        `${src} has ${n} pixels of --${name} (${hex}) — the palette moved and this file was ` +
          `not recaptured with it`,
      );
    }
  }
});

test("each screenshot is the page at its own width, not a corner of a wider one", () => {
  const canvas = rgbOf(COLOR_TOKENS.bg.dark);
  for (const shot of consoleManifest().screenshots) {
    const image = pngPixels(readPublic(shot.src.slice(1)));
    const isCanvas = (x: number, y: number) => near(image.at(x, y), canvas, 2);

    // The app shell's header is full-bleed. If the frame were wider than the
    // layout, the right of this row would be bare canvas.
    for (const [where, x] of [
      ["left", 0],
      ["middle", image.width >> 1],
      ["right", image.width - 1],
    ] as const) {
      assert.ok(
        !isCanvas(x, 0),
        `${shot.src}: the top row is canvas at the ${where} — the shell does not reach that edge, ` +
          `so this frame is wider than the page that was laid out in it`,
      );
    }

    // And the other direction. The content column is padded by an equal gutter
    // on both sides, so the commonest left/right pair in the frame is
    // symmetric. Lay the page out wider than the frame and the right gutter is
    // gone; lay it out narrower and the right gutter is enormous. Either way
    // this pair stops matching, which is what a crop looks like from the
    // pixels.
    //
    // 🔴 The gutter is measured from WHERE THE CANVAS STARTS, not from the
    // frame edge, and that is not a loosening — it is what keeps this
    // answerable at all. The original scan began at x=0 and dropped any row
    // whose ink reached the left edge (`first <= 0`). From `md` up this
    // console now mounts a full-height rail AT x=0, so on the wide frame every
    // single row was dropped: the histogram came back empty and the test
    // failed with "only 0 rows share a gutter pair (none)" against a perfectly
    // good capture. A criterion no correct frame can satisfy manufactures a
    // false red, and this one had become one the moment the rail landed.
    //
    // Starting at the first canvas pixel puts the measurement back on the
    // content column wherever that column begins. On a frame with no rail the
    // first canvas pixel is x=0 and this is byte-for-byte the original
    // computation, which is why the narrow frame's numbers do not move.
    const pairs = new Map<string, number>();
    for (let y = 0; y < image.height; y++) {
      let canvasFrom = -1;
      for (let x = 0; x < image.width; x++) {
        if (isCanvas(x, y)) {
          canvasFrom = x;
          break;
        }
      }
      // A row with no canvas at all (inside the bar, inside the header band)
      // has no content column to measure, exactly as before.
      if (canvasFrom < 0) continue;
      let first = -1;
      let last = -1;
      for (let x = canvasFrom; x < image.width; x++) {
        if (isCanvas(x, y)) continue;
        if (first < 0) first = x;
        last = x;
      }
      if (first < 0 || last >= image.width - 1) continue;
      const key = `${first - canvasFrom}|${image.width - 1 - last}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    const [modal, rows] = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
    const [left, right] = modal.split("|").map(Number);
    assert.ok(
      rows >= image.height * 0.15,
      `${shot.src}: only ${rows} rows share a gutter pair (${modal}) — there is no content ` +
        `column here, so nothing says the layout was done at ${image.width} px`,
    );
    assert.ok(
      Math.abs(left - right) <= 2,
      `${shot.src}: the content column sits ${left}px from the left and ${right}px from the ` +
        `right — a centred column cannot do that, so this frame is a crop of a differently ` +
        `sized layout`,
    );
  }
});

/**
 * 🔴 The fourth seam: "these start at the document origin" was written in the
 * note and the receipt, and NOTHING CHECKED IT.
 *
 * Both assertions above are horizontal — they catch a frame laid out at the
 * wrong width, which is the defect five icons shipped with. Neither can see a
 * frame that is the right width, in the right palette, and simply starts part
 * way down the page. Swept exhaustively: the narrow file could lose its first
 * 513 rows and the wide one its first 116 with the whole suite green, and the
 * only thing holding the origin was `clip: {x: 0, y: 0}` in a scratchpad
 * capture script that is not on the test path.
 *
 * What the top of a document has that no other offset does is the shell
 * header: a full-bleed band of padding, the page's first `--fg` text inside
 * it, and its closing `--line` rule underneath. Three row offsets, all read
 * off the pixels, all keyed to token colours rather than to sampled hexes.
 *
 * The numbers are measured geometry, not a palette, and they are the one thing
 * in this file that a legitimate layout change will turn red — deliberately.
 * Regenerate them with `scratchpad/t014/theme-black/origin2.cjs`, which also
 * prints the sweep: over all 1,647 narrow and 759 wide vertical offsets, the
 * TRIPLE matches at ZERO of them. Each row on its own survives at 2-10
 * offsets, so all three are load-bearing.
 */
const TOP_PROFILE: Record<string, { fg: number; line: number; content: number }> = {
  "/screenshot-mobile.png": { fg: 54, line: 16, content: 16 },
  "/screenshot-wide.png": { fg: 18, line: 0, content: 0 },
};

test("each screenshot starts at the top of the document, not part way down it", () => {
  const fg = pack(...rgbOf(COLOR_TOKENS.fg.dark));
  const line = pack(...rgbOf(COLOR_TOKENS.line.dark));
  for (const shot of consoleManifest().screenshots) {
    const want = TOP_PROFILE[shot.src];
    assert.ok(want, `no top profile recorded for ${shot.src}`);
    const image = pngPixels(readPublic(shot.src.slice(1)));

    let firstFg = -1;
    let firstLine = -1;
    let firstContent = -1;
    for (let y = 0; y < image.height; y++) {
      const opening = image.at(0, y);
      let uniform = true;
      for (let x = 0; x < image.width; x++) {
        const p = image.at(x, y);
        const key = pack(p[0], p[1], p[2]);
        if (firstFg < 0 && key === fg) firstFg = y;
        if (firstLine < 0 && key === line) firstLine = y;
        if (uniform && (p[0] !== opening[0] || p[1] !== opening[1] || p[2] !== opening[2])) {
          uniform = false;
        }
      }
      if (firstContent < 0 && !uniform) firstContent = y;
      if (firstFg >= 0 && firstLine >= 0 && firstContent >= 0) break;
    }

    assert.deepEqual(
      { fg: firstFg, line: firstLine, content: firstContent },
      want,
      `${shot.src}: the shell header is not where the top of this page puts it. The frame is ` +
        `the right size and the right palette, so this is a vertical crop — the capture must ` +
        `clip from y=0`,
    );
  }
});

test("the manifest still asks for a standalone window with the app's own colours", () => {
  const m = consoleManifest();
  assert.equal(m.display, "standalone");
  assert.equal(m.scope, "/");
  // Wandering onto another tenant's subdomain would show a session it has not
  // got; the scope is what keeps an installed window at home.
  assert.equal(m.start_url, "/");
  assert.match(String(m.theme_color), /^#[0-9a-f]{6}$/i);
  assert.match(String(m.background_color), /^#[0-9a-f]{6}$/i);
});

test("the two chrome colours come from the token table, not a second copy", () => {
  // Four places have to remember a palette change: globals.css, the phone
  // status bar in app/layout.tsx, public/offline.html, and this. The last
  // three are the ones nobody looks at — one paints the strip above an
  // installed console, one the splash screen it shows before its first paint,
  // and one the page it falls back to with no network. The first two reach a
  // token; the offline page cannot, and has its own guard above.
  const m = consoleManifest();
  assert.equal(m.theme_color, COLOR_TOKENS.bg.dark);
  assert.equal(m.background_color, COLOR_TOKENS.bg.dark);
  // Equality alone would still hold if the hex were typed back in, since it is
  // the same string today — which is exactly the state this guards against, so
  // the source has to say where the value came from.
  const source = readText(join("lib", "pwa.ts"));
  assert.match(source, /background_color: COLOR_TOKENS\.bg\.dark/);
  assert.match(source, /theme_color: COLOR_TOKENS\.bg\.dark/);

  const layout = readText(join("app", "layout.tsx"));
  // `themeColor` is one unconditional value. It used to be a media-keyed list —
  // one entry per `prefers-color-scheme` — and that was the defect T048 fixed:
  // this console picks its theme from storage and a first-frame script, never
  // from the system preference, so a media-keyed status bar answers a question
  // nobody asked. `lib/pwa.ts` paints the splash screen behind it from
  // `COLOR_TOKENS.bg.dark` unconditionally, so the two disagreed for every
  // reader whose phone was set to light.
  //
  // The trailing comma is load-bearing and this line was wrong once without it.
  // While T048 was in flight this had to accept both shapes so the two branches
  // could land independently, and the pattern that did — `themeColor:` then the
  // token within 120 characters — also matched the pair it was meant to forbid,
  // because the pair's first entry reaches `COLOR_TOKENS.bg.dark` well inside
  // that window. It was proved by injecting the old shape back, not reasoned
  // about. The list form is always `themeColor: [`, never `themeColor: X,`, so
  // requiring the comma is what separates them.
  assert.match(layout, /themeColor: COLOR_TOKENS\.bg\.dark,/);
  // This one is the point of the test and does not move.
  assert.ok(!/#[0-9a-f]{6}/i.test(layout), "a hex colour was typed into app/layout.tsx again");
});

test("app/manifest.ts is only a caller, so no test has to reach into app/", () => {
  const route = readText(join("app", "manifest.ts"));
  // A call site rather than a definition: `consoleManifest` is declared in
  // lib/pwa.ts, so nothing in this file can match that string except a use.
  assert.match(route, /return consoleManifest\(\);/, "the manifest route stopped delegating");
  // And it holds nothing of its own. The reason a field would move back here
  // is to reach a token through `@/` — which is exactly what took the whole
  // suite down, silently, once already.
  for (const field of ["start_url", "icons", "screenshots", "theme_color"]) {
    assert.ok(!route.includes(`${field}:`), `${field} moved back into app/manifest.ts`);
  }
});

/* ── The assets are reachable without a session ──────────────────────────
 *
 * Everything above checks that the right bytes are on disk and named correctly
 * in the manifest. All of that was true and green while production answered
 * `307 → /login` to every one of the seven PNGs, because the middleware's
 * `config.matcher` excluded a hand-written list of the five files that existed
 * when it was written. Nothing in the repository could see the difference: the
 * manifest was right, the icons were right, and the only wrong thing was a
 * regex in another file that nobody had a reason to open.
 *
 * So these run against the literal `middleware.ts` actually ships — parsed out
 * as text — rather than against `MIDDLEWARE_MATCHER`. A test that agreed with
 * the copy in `lib/` while the middleware disagreed with both would be the same
 * class of green as the manifest was.
 */

const middlewareSource = readText("middleware.ts");

/** The `config.matcher` entry as the shipped file spells it. */
function shippedMatcher(): string {
  const found = /matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\]/.exec(middlewareSource);
  assert.ok(found, "config.matcher is no longer one string literal — this parser is stale");
  // Through JSON so the `\\.` in the source becomes the `\.` the regex means.
  return JSON.parse(`"${found[1]}"`) as string;
}

/** Every file under `public/`, as the path a browser would ask for. */
function publicFiles(dir = join(root, "public"), prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const served = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...publicFiles(join(dir, entry.name), served));
    else out.push(served);
  }
  return out;
}

/** Every route `app/` defines, as a path. `[param]` becomes a sample value. */
function appRoutes(dir = join(root, "app"), prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const segment = entry.name.replace(/^\[\.{0,3}(.+)\]$/, "sample");
      out.push(...appRoutes(join(dir, entry.name), `${prefix}/${segment}`));
    } else if (entry.name === "page.tsx" || entry.name === "route.ts") {
      out.push(prefix === "" ? "/" : prefix);
    }
  }
  return out;
}

test("the matcher in middleware.ts is the one lib/ describes and tests", () => {
  // Next reads config.matcher by static analysis and needs a literal, so the
  // rule cannot be imported from lib/pwa.ts. This is what stops the copy from
  // being a second place for it to live.
  assert.equal(shippedMatcher(), MIDDLEWARE_MATCHER);
});

test("every file in public/ is served to a browser that has no session", () => {
  const matcher = shippedMatcher();
  const files = publicFiles();
  // A walk that returned nothing would pass the assertion below without
  // measuring anything at all.
  assert.ok(files.length >= 11, `only ${files.length} files under public/ — the walk is broken`);

  const gated = files.filter((path) => middlewareRunsOn(path, matcher));
  // This is the reconciliation the old list could not do. Drop any file into
  // public/ and it is covered; nest one in a subdirectory and this goes red
  // rather than 307ing in production for a month.
  assert.deepEqual(gated, [], "these files redirect an anonymous browser to /login");
});

test("every asset the install path fetches is reachable anonymously", () => {
  const matcher = shippedMatcher();
  const manifest = consoleManifest();
  const layout = readText(join("app", "layout.tsx"));
  const declared = [
    // The connection banner's probe, which runs while signed out on /login.
    PROBE_PATH,
    ...manifest.icons.map((icon) => icon.src),
    ...manifest.screenshots.map((shot) => shot.src),
    // apple-touch-icon is declared in the <head>, not the manifest: iOS ignores
    // the manifest's icons entirely, so it has its own way to be missed.
    ...[...layout.matchAll(/url:\s*"(\/[^"]+)"/g)].map((match) => match[1]),
  ];
  assert.ok(declared.length >= 9, `only ${declared.length} declared assets — the extractor broke`);
  assert.ok(
    declared.includes("/apple-touch-icon.png"),
    "the apple-touch-icon is not being read out of app/layout.tsx",
  );

  const unreachable = declared.filter((path) => middlewareRunsOn(path, matcher));
  assert.deepEqual(unreachable, [], "the manifest names files an anonymous browser cannot fetch");
});

test("opening the assets did not open anything that needs a session", () => {
  const matcher = shippedMatcher();
  // The negative half, and the more important one: a matcher that let
  // everything through would satisfy every assertion above.
  const routes = appRoutes();
  assert.ok(routes.length >= 15, `only ${routes.length} routes found — the walk is broken`);

  const open = routes.filter((path) => !middlewareRunsOn(path, matcher));
  // Including /login and /unknown-tenant: the middleware still has to run on
  // those to resolve the tenant. Being reachable without a session is
  // isPublicPath's job, inside the middleware, not the matcher's.
  assert.deepEqual(open, [], "these routes no longer reach the middleware at all");

  for (const path of ["/", "/devices", "/proxy", "/settings"]) {
    assert.ok(middlewareRunsOn(path, matcher), `${path} stopped being gated`);
  }
});

test("a dot in a path cannot be used to walk out of a gated route", () => {
  const matcher = shippedMatcher();
  // The exclusion is anchored to a single segment. Without that anchor, every
  // one of these would be served with no session and no bearer token —
  // /devices/[deviceId] accepts any string, so the first one is a real route.
  for (const path of [
    "/devices/evil.png",
    "/inbox/evil.png",
    "/devices/sample/deeper.svg",
    "/v1/auth/session.json",
    "/api/auth/login.json",
    "/v1/devices.png",
    // A leading dot is not a filename for this purpose.
    "/.env",
    "/.git/config",
  ]) {
    assert.ok(middlewareRunsOn(path, matcher), `${path} escaped the middleware`);
  }
});

test("no route segment could ever be mistaken for a static file", () => {
  // The premise the rule rests on: route segments are directory names, and none
  // of them contains a dot, so no page can match the exclusion. The day someone
  // adds `app/report.pdf/page.tsx` this goes red — which is the point, because
  // that page would otherwise be served to anyone.
  const withDots = appRoutes().filter((path) =>
    path.split("/").some((segment) => segment.includes(".")),
  );
  assert.deepEqual(withDots, [], "a route segment contains a dot and the matcher would skip it");
});

/* ── Safe area ───────────────────────────────────────────────────────── */

test("the safe area is covered on all four sides, not only top and bottom", () => {
  // T023 found top and bottom done and the sides missing. An iPhone in
  // landscape puts the notch on one edge, and Safari renders edge to edge
  // horizontally even in a tab, so this is clipped text without an install.
  assert.match(SAFE_AREA.sides.paddingLeft, /env\(safe-area-inset-left\)/);
  assert.match(SAFE_AREA.sides.paddingRight, /env\(safe-area-inset-right\)/);
  assert.match(SAFE_AREA.headerTop.paddingTop, /env\(safe-area-inset-top\)/);

  // On the element, not merely somewhere in the file — the same mutation that
  // got past the header check in T026 applies here.
  const layout = readText(join("app", "layout.tsx"));
  assert.match(layout, /<body\s+style=\{SAFE_AREA\.sides\}/, "the sides are not applied to <body>");
  assert.match(layout, /viewportFit:\s*"cover"/, "without this the insets are all zero anyway");

  // A fixed bar is outside <body>'s padding box and has to repeat all three.
  for (const side of ["Left", "Right", "Bottom"]) {
    assert.match(
      (SAFE_AREA.fixedBottom as Record<string, string>)[`padding${side}`],
      /env\(safe-area-inset-/,
      `the fixed banner has no ${side.toLowerCase()} inset`,
    );
  }
  const banner = readText(join("components", "connection-status.tsx"));
  assert.match(banner, /style=\{SAFE_AREA\.fixedBottom\}/);
});

/* ── The two components are wired in, and say what they must ─────────── */

test("both PWA affordances are mounted, and the banner is not inside the shell", () => {
  const layout = readText(join("app", "layout.tsx"));
  assert.match(layout, /<InstallPrompt\b/, "nothing renders the install offer");
  assert.match(layout, /<ConnectionStatus\b/, "nothing renders the connection banner");
  // PM's ruling: a sibling of the shell, so this card does not take T007's file.
  const shell = readText(join("components", "shell.tsx"));
  assert.ok(!shell.includes("ConnectionStatus"), "the banner moved into T007's file");
  // The age of the page is the server's to know; a client-side default would
  // be the current time, which is the bug this whole feature prevents.
  assert.match(layout, /loadedAt=\{loadedAt\}/);
  assert.match(layout, /const loadedAt = Date\.now\(\)/);
});

test("the banner prints the clock rather than only the word offline", () => {
  const banner = readText(join("components", "connection-status.tsx"));
  assert.match(banner, /formatClock\(new Date\(view\.dataAt\)\)/, "the timestamp is not rendered");

  /*
   * The two sentences are resolved in app/layout.tsx and handed over as props,
   * so the check follows them there rather than looking for a `t()` call this
   * component no longer makes. The component is a client component the root
   * layout mounts on every page; a lookup here put both message catalogues —
   * 27.7 kB gzipped — onto every route in the console. See lib/locale.ts.
   *
   * Both halves are asserted, because either one alone can pass while the
   * banner shows nothing: the layout can resolve a string it never passes, and
   * the component can render a label the layout never fills. Only the pair
   * says the sentence reaches the screen.
   */
  const layout = readText(join("app", "layout.tsx"));
  assert.match(layout, /t\("connection\.lost"/, "the layout no longer resolves connection.lost");
  assert.match(layout, /t\("connection\.stale"/, "the layout no longer resolves connection.stale");
  assert.match(banner, /labels\.lost/, "the banner no longer renders the lost label");
  assert.match(banner, /labels\.stale/, "the banner no longer renders the stale label");
});

test("every string these components show exists in both catalogues", () => {
  const zh = JSON.parse(readText(join("messages", "zh.json"))) as Record<string, string>;
  const en = JSON.parse(readText(join("messages", "en.json"))) as Record<string, string>;
  /*
   * Read from app/layout.tsx, which is where these keys are now resolved: both
   * components take finished strings as props so that the root layout stops
   * dragging both catalogues onto every route. The guarantee is unchanged —
   * every string these two components can show must exist in both catalogues —
   * only the file that names the keys moved.
   *
   * The floor below is what caught that move rather than letting it pass
   * silently: after the refactor the old extractor found zero keys here and
   * said so, instead of reporting an empty list of missing ones as success.
   */
  const sources = readText(join("app", "layout.tsx"));

  const keys = [...sources.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length >= 8, `only ${keys.length} message keys found — the extractor is broken`);
  const missing = keys.filter((key) => typeof zh[key] !== "string" || typeof en[key] !== "string");
  // A missing key renders as ⟦key⟧ in a banner that only appears when
  // something has already gone wrong, which is the worst place to find one.
  assert.deepEqual(missing, []);
});

test("the two affordances cannot land on the same edge of the screen", () => {
  // They can be on screen together — a console being read offline is exactly
  // one somebody would rather have installed — and two fixed bars sharing an
  // edge means one of them is invisible.
  assert.ok(!PWA.install.bar.includes("fixed"), "the install bar floats over the content");
  assert.ok(PWA.connection.bar.includes("fixed"), "the banner scrolls away with the page");
  assert.ok(PWA.connection.bar.includes("bottom-0"));
});

/* ── The fifth seam: are these still pictures of THIS console? ─────────
 *
 * 🔴 EVERY SCREENSHOT GUARD ABOVE COMPARES THESE TWO FILES TO A PALETTE OR TO
 * THEMSELVES. NOT ONE COMPARES THEM TO THE SOURCE THAT LAYS OUT THE CHROME.
 *
 * The seven checks split into three kinds, and all three are blind to a
 * relayout that holds the palette still:
 *
 *   - colour — wired live to `COLOR_TOKENS`, so they do fire when the palette
 *     moves. That is how the recolour was caught. They cannot fire when it
 *     does not move.
 *   - size — the frame against the manifest's own declaration. The manifest
 *     declares the frame; rearranging what is inside it moves neither number.
 *   - geometry — and this is the trap. Both LOOK layout-sensitive. "each
 *     screenshot is the page at its own width" compares the frame to itself:
 *     are the gutters symmetric. "each screenshot starts at the top of the
 *     document" compares it to TOP_PROFILE — three numbers measured off these
 *     very files. Its docblock claims it is "the one thing in this file that a
 *     legitimate layout change will turn red — deliberately".
 *     🔴 IT IS NOT, AND THE CLAIM IS THE DANGEROUS PART. Both of its operands
 *     are frozen artefacts of the same capture, so it can catch a BAD
 *     RECAPTURE and can never catch a MISSING one. A guard that reads as
 *     layout-sensitive is worse than none: it is why nobody looked again.
 *
 * What went past all of it: the navigation moved off the top of the page onto
 * a fixed phone bar and a desktop rail, and the radius scale went from 3/4/6
 * to 8/10/14. Neither touched a colour. 52 tests stayed green over two frames
 * showing chrome that no longer exists — the phone frame shows a page with no
 * bottom bar, taken when `components/mobile-nav.tsx` was not yet a file.
 *
 * The two guards below supply the missing term, and they fail differently on
 * purpose:
 *
 *   A. PROVENANCE — what tree were these captured from, and is it this one?
 *      This is the "when was it taken" the charter asks every snapshot asset
 *      to carry. It catches any chrome change and names none of them.
 *   B. WHAT IS IN THE PICTURE — the phone frame must show the bar this console
 *      mounts, the desktop frame must show the rail. Narrower, but it cannot
 *      be satisfied by editing this file. Only by taking the photograph again.
 */

/**
 * Every source file that helps decide what is inside these two frames,
 * DERIVED rather than listed.
 *
 * The roots are the two files Next.js composes to build the captured URL: the
 * root layout and the overview page. The set is their transitive local-import
 * closure. Hand-listing it is the move that has under-reported three times on
 * this board; the only hand-written part here is the two entry points, which
 * are not a set.
 *
 * 🔴 `unresolved` is the non-vacuity half, and it is not decoration. A
 * specifier that looks local and does not resolve means the walker missed a
 * file, and a walker that silently misses files hands out a green stamp for a
 * tree it never read. The first draft did exactly that: its regex forbade
 * newlines, so the multi-line `import { … } from "@/components/ui/card"` in
 * app/page.tsx was invisible, and card.tsx and table.tsx — which draw the stat
 * cards and the message table that ARE IN THESE SCREENSHOTS — were not in the
 * closure. It reported 25 files and looked entirely reasonable.
 */
const CHROME_ROOTS = ["app/layout.tsx", "app/page.tsx"];

const MODULE_SPECIFIER =
  /(?:\bimport\b|\bexport\b)(?:[\s\S](?!\bimport\b|\bexport\b))*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function chromeClosure(): { files: string[]; unresolved: string[] } {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  // null = a package, not our source. undefined = local-looking and missing.
  const resolveLocal = (spec: string, from: string): string | null | undefined => {
    let base: string;
    if (spec.startsWith("@/")) base = join(root, spec.slice(2));
    else if (spec.startsWith("./") || spec.startsWith("../")) base = join(dirname(from), spec);
    else return null;
    for (const c of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.css`,
      `${base}.json`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ]) {
      if (isFile(c)) return c;
    }
    return undefined;
  };

  const unresolved: string[] = [];
  const seen = new Set<string>();
  const stack = CHROME_ROOTS.map((r) => join(root, r));
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    // css and json are leaves: hashed for their contents, not parsed.
    if (!/\.tsx?$/.test(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(MODULE_SPECIFIER)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const hit = resolveLocal(spec, file);
      if (hit === null) continue;
      if (hit === undefined) {
        unresolved.push(`${relative(root, file)} -> ${spec}`);
        continue;
      }
      stack.push(hit);
    }
  }
  return {
    files: [...seen].map((f) => relative(root, f).split(sep).join("/")).sort(),
    unresolved,
  };
}

/**
 * 🔴 LINE ENDINGS ARE NORMALISED BEFORE HASHING, AND THAT IS LOAD-BEARING.
 * The working tree is CRLF and the repo has no .gitattributes, so the same
 * file arriving through `git archive`, a patch, or an editor that writes LF is
 * byte-different and content-identical. Hashing raw bytes would turn this
 * guard red for a reason that has nothing to do with the screenshots, which is
 * the third CRLF trap in the charter. Checked both ways: converting all 232
 * CRLF lines of app/layout.tsx to LF leaves this digest unchanged, and the
 * capture-commit tree still hashes differently from this one.
 */
function chromeDigest(files: string[]): string {
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Where the two files in public/ came from.
 *
 * 🔴 THESE ARE FACTS ABOUT TWO DIFFERENT TREES, NOT NUMBERS SOMEBODY CHOSE,
 * AND WHICH TREE EACH ONE DESCRIBES IS THE PART THAT KEEPS GOING WRONG.
 *
 *   `shots`  the two PNGs' own hashes.
 *   `commit` the tree the frames were CAPTURED AGAINST. An observation; it
 *            moves only when someone reshoots.
 *   `chrome` chromeDigest over the closure of the tree of THE COMMIT THAT
 *            CARRIES THIS STAMP. It moves on every re-stamp.
 *
 * After a re-stamp those are two different trees, and the distance between
 * them is not a defect — it IS the re-stamp claim: the chrome moved in a way
 * neither frame can show. Do not close the gap by re-pointing `commit`. The
 * one time `commit` legitimately moved (a265143, 4d7451d → 7b24441) it was
 * paid for by reshooting the frames, which came back byte-identical. Moving it
 * without a reshoot files an inference in the slot reserved for an observation.
 *
 * ⚠️ THIS DOCBLOCK USED TO CARRY A RECIPE THAT RECOVERED `chrome` FROM
 * `commit`, AND IT WAS UNSATISFIABLE BY CONSTRUCTION. `git archive <commit>`
 * then chromeDigest reproduces the value only while the stamp rides a commit
 * that changes nothing in the closure — true of a recapture, false of a
 * re-stamp, because a re-stamp exists precisely because a closure member
 * moved. A commit cannot name its own hash, so a self-contained re-stamp has
 * no earlier commit to point at: the recipe died at the moment it was needed.
 * SN-T029 re-stamped, the recipe went on reproducing the superseded
 * 922b9fd5…, and nothing caught it, because no assertion has ever read
 * `commit`. It is prose. Guard A reads `chrome`.
 *
 * 💡 Provenance is still checkable — derive it instead of writing it down:
 *
 *     git log -1 --format=%H -S'<the chrome value below>' \
 *       -- apps/console/lib/pwa.test.ts          # the commit that stamped it
 *     git archive <that commit> apps/console | tar -x -C <tmp>
 *     cp apps/console/lib/pwa.test.ts <tmp>/apps/console/lib/
 *     cd <tmp>/apps/console && node --test --experimental-strip-types \
 *       --test-name-pattern 'captured from the chrome this tree renders' \
 *       lib/pwa.test.ts
 *
 * Guard A going green there IS the reproduction, and guard A is also the
 * comparator, so no second implementation can drift away from this one.
 * Copying this file in is sound, and that is its own proof: run the same steps
 * on 7b24441 and the digest still comes out 922b9fd5…, the value a265143
 * computed on that tree against a different copy of this file.
 *
 * Recapturing changes all three fields; editing `chrome` alone is a one-line
 * diff that leaves the PNG hashes untouched — exactly what a re-stamp should
 * look like. Make that claim in the commit message rather than silently, and
 * note that guard B will not accept it for anything structural.
 */
const CAPTURED_FROM = {
  // The tree these frames were CAPTURED AGAINST — an observation, last re-taken
  // when a265143 reshot them for SN-T022 (below). It is NOT the tree `chrome`
  // was taken on, and has not been since SN-T029 re-stamped: `git archive
  // 7b24441` reproduces the superseded 922b9fd5…, verified rather than assumed.
  // Move this only by reshooting.
  //
  // ⚠️ The frames were shot against two different builds of the same chrome,
  // and they came out byte-identical. That is the evidence this stamp rests on,
  // and it is worth reading before re-stamping anything here yourself.
  //
  // SN-T022 moved BOTTOM_NAV.bar from z-20 to z-10 so the connection banner
  // stops being painted over. That is a real class change, not a comment: the
  // built stylesheet went from dff3987b0c0d88a7.css to 6395ac6053b94fdd.css.
  // The frames were therefore reshot against the new build — and both PNGs
  // hashed exactly as before (08d8ea54…, d7d8a9b5…), because nothing overlaps
  // the bar while the connection is up and the banner is not on screen.
  //
  // 🔴 The point is the order of operations. "The banner is not in my frames,
  // so a z-index between them cannot matter" is a correct argument, and it was
  // still not what this was settled with — the frames were retaken and the
  // bytes compared. A guard that freezes an upstream digest has to be paid for
  // with the artefact, because the one time the reasoning is wrong it is wrong
  // silently. `lib/tokens.ts` is a Tailwind content file and prose in one has
  // leaked a rule into the shipped stylesheet four times on this repo, once
  // from the ordinary English word `transition` sitting in a comment.
  // SN-T09x re-stamped the chrome digest alone, without reshooting. Three
  // closure files moved: `lib/catalog.ts` gained optional firmware, number and
  // topology fields on ModemRow plus disk, throughput and machine fields on
  // DeviceRow, and both message packs gained the keys those columns are
  // labelled with. The home page renders none of them.
  //
  // Paid for with the artefact, as the note below demands rather than with the
  // argument that it looked cosmetic: the shipped stylesheet was generated
  // from the real content globs on this tree and on the tree with these
  // changes stashed, and came out byte-identical --
  // 4d601b64641b0511b86ac01dbf366accd2aca18336fc9dbf94ed8e48c63bade5 at 12403
  // bytes, both times.
  //
  // The two files that do add markup -- `app/devices/[deviceId]/page.tsx` and
  // `components/device-console.tsx` -- are Tailwind content but are NOT in the
  // chrome closure, which is why the digest moved on the other three and why
  // the stylesheet check was the part that mattered.
  commit: "7b24441",
  //
  // Re-stamped again in the same change, after the card policy table gained a
  // plan-declaration column and `lib/card-capability.ts` joined the closure.
  // Neither is on the home page. Paid for the same way and with the same
  // result: the shipped stylesheet is still
  // 4d601b64641b0511b86ac01dbf366accd2aca18336fc9dbf94ed8e48c63bade5 at 12403
  // bytes, byte-identical to the tree before any of this, because every
  // control added here is an existing component and no file gained a class
  // string of its own.
  //
  // Re-stamped once more in the same change: the support ledger page and
  // its nav entry joined the closure, and the device list gained a filter
  // form. None of it is on the home page the frames show. Paid for the same
  // way a third time and with the same answer -- the shipped stylesheet is
  // still 4d601b64641b0511b86ac01dbf366accd2aca18336fc9dbf94ed8e48c63bade5
  // at 12403 bytes, unchanged since before any of this work began, because
  // every control added is an existing component and no file writes a class
  // string of its own.
  // Re-stamped again for the APN work: `lib/catalog.ts` gained the
  // profile table on ModemRow. Not on the home page, and the shipped
  // stylesheet is still
  // 4d601b64641b0511b86ac01dbf366accd2aca18336fc9dbf94ed8e48c63bade5 at
  // 12403 bytes -- unchanged across every console change in this session.
  //
  // Re-stamped for the country flags and the APN credential columns:
  // `lib/plmn.ts` gained a flag table and four territories, `lib/catalog.ts`
  // gained the credential fields, and the device page renders them. Paid for
  // with a real build, twice: once with the change and once with
  // `apps/console` stashed. Both produced
  // .next/static/css/6395ac6053b94fdd.css at 16934 bytes hashing to
  // c6c804b7619aa61cbe939f2d1861574b0025fe6476414cd6a1ff1ad2af95fe80 --
  // byte-identical, so nothing this change added reached the stylesheet.
  //
  // 🔴 Note for whoever re-stamps next: the
  // 4d601b64641b0511b86ac01dbf366accd2aca18336fc9dbf94ed8e48c63bade5 at 12403
  // bytes recited by the notes above no longer describes this tree, and had
  // already stopped describing it before this change -- the stashed baseline
  // built to 16934 bytes with none of this work applied. Compare against a
  // baseline you build yourself rather than against that number.
  //
  // Re-stamped once more in the same change: the APN editor joined
  // `components/device-console.tsx`, with its consequence sentence, its label
  // keys and `lib/tokens.ts` gaining the guard row. Third real build of the
  // day, and the answer has not moved -- still 16934 bytes hashing to
  // c6c804b7619aa61cbe939f2d1861574b0025fe6476414cd6a1ff1ad2af95fe80. Every
  // control in the new form is an existing component, so no file gained a
  // class string of its own.
  //
  // Re-stamped for the cloud-visibility work: the agent log card, the matrix
  // key and proxy columns, the uptime card, and `lib/catalog.ts` gaining the
  // rows behind them. Fourth real build, same answer -- 16934 bytes hashing to
  // c6c804b7619aa61cbe939f2d1861574b0025fe6476414cd6a1ff1ad2af95fe80. The
  // uptime sparkline is drawn with block characters precisely so that a chart
  // needing a height per bar could not put a class per step in a content file.
  //
  // 🔴 Re-stamped with the stylesheet CHANGED, which no re-stamp above this
  // one did. Say so plainly rather than repeating the byte-identical line:
  //
  //   before  6395ac6053b94fdd.css, 16934 bytes
  //   after   9eb9f0c4694166eb.css, 15907 bytes
  //
  // `app/layout.tsx` moved from `next/font/google` to `next/font/local`
  // because the google loader downloads each face during `next build` with no
  // timeout outside dev, and one stalled socket hung this build for ever --
  // see the note on `monoFace`. What moved in the CSS is the `@font-face`
  // `src`, now `/_next/static/media/…` under this origin, and the loss of the
  // latin-ext `@font-face` that `subsets: ["latin"]` never downloaded anyway.
  //
  // The frames were NOT recaptured, and that is a claim about rendering
  // rather than about bytes: the family, both weights, `display: swap` and
  // the whole fallback chain are unchanged, so the same glyphs are drawn from
  // the same faces. Only the URL the browser fetches them from moved.
  //
  // Re-stamped for the alerts card on `/devices`. Paid for the usual way and
  // back to byte-identical: 15907 bytes hashing to
  // efcff242dc5a7c82ddcb5f48bb6d500b8c5139904e43508db2c8070ef3e324f3, the
  // same as the build immediately before it -- every control in the new card
  // is an existing component and no file gained a class string of its own.
  //
  // The card went on `/devices` rather than the landing page deliberately.
  // The landing page is what these frames show, so a card there would make
  // the install dialog advertise chrome this tree no longer renders, and
  // recapturing needs a signed-in browser at the frames' exact viewport.
  //
  // Re-stamped alone at eefb542+1, on a diff rather than on judgement. Every
  // other file in the closure -- app/layout.tsx, app/page.tsx,
  // components/shell.tsx, both message catalogues, lib/i18n.ts, lib/catalog.ts
  // and app/globals.css -- is byte-identical to the stamped tree. The single
  // change is one line in lib/tokens.ts:
  //
  //   + "components/modem-network.tsx",
  //
  // added to MIGRATED_SOURCES, which is a list of filenames read by the
  // migration-ledger test and by nothing that renders. The extraction it
  // records moved the network cell out of two pages that are not in this
  // closure. The built stylesheet came out identical too
  // (9eb9f0c4694166eb.css), which is the same evidence the SN-T022 note above
  // rests on.
  // Re-stamped for the adoption controls. The stylesheet did NOT move --
  // `9eb9f0c4694166eb.css` is byte-identical across this change -- so the
  // frames still show the chrome they were captured from. What moved is
  // `lib/tokens.ts` and the message catalogues: a guard entry for adopting and
  // unmanaging a module, and the sentences those two put in front of an
  // operator. Neither is drawn on the install screens.
  // ⚠️ **这两张截图现在是过期的，需要重拍。**
  //
  // 前几次重新盖章时外观没有变（只动了 globals.css 的变量）。这一次不同：
  // Button / Badge / Card / Table / 表单原语全部换成了 shadcn，尺寸也集中收紧
  // 了一档。安装弹窗里展示给用户的，是一个已经不存在的界面。
  //
  // 拍摄需要浏览器、特定视口和一个已登录的会话，我没有这些。守着这件事的其余
  // 守卫已经在第 1 阶段退休，**不会再有东西提醒**——这条注释就是提醒本身。
  //
  // 🔴 SHELL 配方内联（2026-09-02）之后，这条记录要说得更死一点。上面那句
  // 「需要重拍」当时还是个笼统的判断；这一次不是了：导航栏的链接与分组标签从
  // --fg-muted / --fg-faint 换成了 --muted-foreground（#c1c1c1 / #a7a7a7 →
  // #a1a1aa），而 **screenshot-wide.png 正对着左侧导航栏**，那几个分组标签就在
  // 画面里。所以这次盖章走的**不是**上面那条「改动看不出来」的分支——是看得出
  // 来、但拍摄条件仍然不具备。两者不该记成同一件事：前者是判断，后者是欠账。
  //
  // CARD 配方内联（同日）走的**是**「改动看不出来」那条分支，和上面 SHELL 那次
  // 相反，理由逐条核过：首页只画 CardActions 和 CardEmpty 两个受影响部件，
  // CardActions 的唯一改动是 gap-s2→gap-2（两者都是 0.5rem，像素完全相同），
  // CardEmpty 在有数据时根本不画，而两帧都有数据。CardDisclosure / CARD.stack /
  // 危险区那几处不在首页上。
  //
  // BOTTOM_NAV 内联（同日）又回到「看得见但拍不了」那一侧，而且比 SHELL 那次更
  // 直接：手机帧底部那条栏就是它画的，非当前项的标签从 --fg-muted 换成
  // --muted-foreground（#c1c1c1 → #a1a1aa），四个字都在画面里。
  chrome: "7020f8ae125188409ea2be5dc2036a6ce0f468aa054d8845def7bdb54d8ea3fe",
  shots: {
    "/screenshot-mobile.png": "08d8ea54d20ee139825fa35d32114b0821754d130f7d87d06ddf397437dde0f6",
    "/screenshot-wide.png": "d7d8a9b5f16b5a1ee31330974efef012a10fe81679c317bd7a59b8ec0b5f096b",
  } as Record<string, string>,
};

test("the chrome closure is derived from the roots and reaches every file that draws the frame", () => {
  const { files, unresolved } = chromeClosure();
  assert.deepEqual(
    unresolved,
    [],
    "a local import did not resolve, so the closure is short a file and its digest is a " +
      "stamp for a tree that was never fully read",
  );
  assert.ok(files.length >= 20, `the chrome closure is only ${files.length} files — walker broke`);
  // A floor, not the set: these are things that must be reachable from the
  // roots for the digest to mean anything. The set itself stays derived.
  for (const must of [
    "app/globals.css",
    "app/layout.tsx",
    "app/page.tsx",
    "components/mobile-nav.tsx",
    "components/shell.tsx",
    "components/sidebar.tsx",
    "components/ui/card.tsx",
    "components/ui/table.tsx",
    "lib/tokens.ts",
  ]) {
    assert.ok(
      files.includes(must),
      `${must} is not in the chrome closure, so a change to it would not move the digest`,
    );
  }
});

test("the install screenshots were captured from the chrome this tree renders", () => {
  for (const [src, want] of Object.entries(CAPTURED_FROM.shots)) {
    const got = createHash("sha256").update(readPublic(src.slice(1))).digest("hex");
    assert.equal(
      got,
      want,
      `${src} is not the file CAPTURED_FROM describes. If it was just recaptured, update the ` +
        `hash and the chrome digest together.`,
    );
  }

  const { files } = chromeClosure();
  const digest = chromeDigest(files);
  assert.equal(
    digest,
    CAPTURED_FROM.chrome,
    `the ${files.length} sources that decide what these screenshots show have changed since ` +
      `the digest below was last stamped, and the files in public/ have not. Whatever moved, ` +
      `the install dialog is still advertising the chrome from before it. (The frames were ` +
      `shot against ${CAPTURED_FROM.commit}; after a re-stamp the digest is newer than that ` +
      `— see CAPTURED_FROM.)\n\n` +
      `  Either recapture both frames and update all of CAPTURED_FROM, or — if the change ` +
      `genuinely cannot be seen in either frame — re-stamp the chrome digest alone with\n\n` +
      `    chrome: "${digest}",\n\n` +
      `  and say so in the commit message.\n\n` +
      `  🔴 A re-stamp is a claim that the rendered output did not move, so pay for it with ` +
      `the output: rebuild and check the stylesheet is byte-identical to the one the frames ` +
      `were captured against. Do NOT pay for it with the argument that the change looked ` +
      `cosmetic. lib/tokens.ts is a Tailwind content file, and prose in one has leaked a ` +
      `rule into the shipped stylesheet four times on this repo — once from the ordinary ` +
      `English word \`transition\` sitting in a comment.\n\n` +
      `  This went stale twice in the afternoon the frames were first taken, and the two ` +
      `cases looked identical from here. One was a comment-only edit to lib/tokens.ts that ` +
      `left the built stylesheet byte-identical; the other moved one utility class and ` +
      `changed it. Only the rebuild separated them — and in that second case the frames, ` +
      `reshot, still hashed the same, so neither "the digest moved" nor "the stylesheet ` +
      `moved" tells you on its own whether the picture is wrong.`,
  );
});

/* ── B. What has to be in the picture ─────────────────────────────────
 *
 * The colour guards ask whether the palette in these files is current. These
 * ask whether the LAYOUT is — and unlike A, they cannot be answered by editing
 * this file, because the only way to put a bottom bar into a PNG is to point a
 * browser at a page that has one.
 *
 * Both derive their expectation from the recipe rather than restating it, so
 * that a deliberate change to the bar or the rail rewrites the question
 * instead of producing a failure nobody can act on.
 */

const shotFor = (factor: string) =>
  consoleManifest().screenshots.find((s) => s.form_factor === factor);

test("the phone screenshot shows the bottom bar this console mounts", () => {
  const bar = ALL_TOKENS.BOTTOM_NAV.bar;
  const cls = bar.split(/\s+/);
  assert.ok(
    ["fixed", "inset-x-0", "bottom-0", "border-t", "md:hidden"].every((c) => cls.includes(c)) &&
      cls.includes("border-line"),
    `BOTTOM_NAV.bar is no longer a phone-only full-bleed bottom bar closed by a --line rule ` +
      `(${bar}). Rewrite the pixel assertion below to match what it is now — do not delete it.`,
  );

  const shot = shotFor("narrow");
  assert.ok(shot, "the manifest declares no narrow screenshot");
  const image = pngPixels(readPublic(shot.src.slice(1)));
  const canvas = rgbOf(COLOR_TOKENS.bg.dark);
  const line = pack(...rgbOf(COLOR_TOKENS.line.dark));
  const canvasInRow = (y: number) => {
    let n = 0;
    for (let x = 0; x < image.width; x++) if (near(image.at(x, y), canvas, 2)) n++;
    return n;
  };

  // An element that is full-bleed and pinned to the bottom means the last row
  // of the frame cannot show page canvas. Deliberately dpr-free: it asks
  // whether the bar is there, not how tall it came out, so it cannot false-red
  // on a capture taken at a different device pixel ratio.
  const last = image.height - 1;
  const bleed = canvasInRow(last);
  assert.equal(
    bleed,
    0,
    `${shot.src}: the bottom row shows ${bleed} pixels of page canvas at its edges, so nothing ` +
      `is pinned over it — but this console mounts a full-bleed bottom bar at every width below ` +
      `md. This frame was captured before the bar existed. Recapture it.`,
  );

  // And the band has to be closed by the bar's own rule. This is what tells it
  // apart from the offline banner, which is also fixed inset-x-0 bottom-0 but
  // rules in --bad: a frame captured with the banner up would satisfy the
  // check above for the wrong reason.
  let band = 0;
  while (band < image.height && canvasInRow(last - band) === 0) band++;
  const top = last - band + 1;
  let ruled = 0;
  for (let x = 0; x < image.width; x++) {
    const p = image.at(x, top);
    if (pack(p[0], p[1], p[2]) === line) ruled++;
  }
  assert.ok(
    ruled >= image.width * 0.99,
    `${shot.src}: the ${band}-row full-bleed band at the bottom opens with ${ruled}/${image.width} ` +
      `pixels of --line, so it is not the nav bar's rule. Something else is pinned there.`,
  );
});

test("the desktop screenshot shows the rail this console mounts", () => {
  const rail = ALL_TOKENS.SHELL.rail;
  const cls = rail.split(/\s+/);
  assert.ok(
    ["hidden", "w-rail", "border-r", "bg-surface", "md:flex"].every((c) => cls.includes(c)),
    `SHELL.rail is no longer a bordered full-height surface column shown from md up (${rail}). ` +
      `Rewrite the pixel assertion below to match what it is now — do not delete it.`,
  );

  const shot = shotFor("wide");
  assert.ok(shot, "the manifest declares no wide screenshot");
  const image = pngPixels(readPublic(shot.src.slice(1)));
  const canvas = rgbOf(COLOR_TOKENS.bg.dark);

  // The rail is the leftmost thing on the page at this width, so no page
  // canvas can reach x=0. Measured over the middle half of the frame rather
  // than all of it: the header is above the rail and the source footer is
  // below it, and neither is what this is about — sampling the middle keeps
  // the check from depending on how tall either of them happens to be.
  let n = 0;
  const from = image.height >> 2;
  const to = image.height - (image.height >> 2);
  for (let y = from; y < to; y++) if (near(image.at(0, y), canvas, 2)) n++;
  assert.equal(
    n,
    0,
    `${shot.src}: column x=0 is page canvas on ${n} of the ${to - from} rows between y=${from} ` +
      `and y=${to}. The rail is a full-height surface column at the left edge from md up, so at ` +
      `this frame width nothing can put canvas at x=0. This frame predates the rail. Recapture it.`,
  );
});
