import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import manifest from "../app/manifest.ts";
import { LOCALE_COOKIE } from "./i18n.ts";
import {
  INSTALL_DISMISSED_KEY,
  LOST_AFTER_FAILURES,
  PROBE_INTERVAL_MS,
  PROBE_PATH,
  STANDALONE_QUERIES,
  connectionView,
  createConnectionMonitor,
  detectPlatform,
  formatClock,
  installState,
  isConnectionFailure,
  isStandalone,
  isWatchedRequest,
  requestUrl,
  type ConnectionHost,
  type FetchLike,
} from "./pwa.ts";
import { PWA, SAFE_AREA } from "./tokens.ts";

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

test("the cache name is bumped when a precached file changes", () => {
  const code = serviceWorkerCode();
  // `install` is the only writer of the offline page and it only runs when the
  // bytes of sw.js differ. Editing offline.html without touching this leaves
  // every installed console serving the old one forever.
  const version = /CACHE\s*=\s*["']vodoge-shell-v(\d+)["']/.exec(code);
  assert.ok(version, "the cache name no longer carries a version");
  assert.ok(Number(version[1]) >= 2, "offline.html changed in T016; the cache was not bumped");
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

/* ── The manifest matches the files on disk ──────────────────────────── */

/** Width and height straight out of the IHDR, which is always the first chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", "not a PNG");
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("every icon the manifest declares exists at the size it claims", () => {
  const icons = manifest().icons ?? [];
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
  const icons = manifest().icons ?? [];
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

test("the install dialog has a screenshot of each shape, at the declared size", () => {
  const shots = manifest().screenshots ?? [];
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

test("the manifest still asks for a standalone window with the app's own colours", () => {
  const m = manifest();
  assert.equal(m.display, "standalone");
  assert.equal(m.scope, "/");
  // Wandering onto another tenant's subdomain would show a session it has not
  // got; the scope is what keeps an installed window at home.
  assert.equal(m.start_url, "/");
  assert.match(String(m.theme_color), /^#[0-9a-f]{6}$/i);
  assert.match(String(m.background_color), /^#[0-9a-f]{6}$/i);
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
  assert.match(banner, /t\("connection\.lost"/);
  assert.match(banner, /t\("connection\.stale"/);
});

test("every string these components show exists in both catalogues", () => {
  const zh = JSON.parse(readText(join("messages", "zh.json"))) as Record<string, string>;
  const en = JSON.parse(readText(join("messages", "en.json"))) as Record<string, string>;
  const sources = [
    readText(join("components", "connection-status.tsx")),
    readText(join("components", "pwa.tsx")),
  ].join("\n");

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
