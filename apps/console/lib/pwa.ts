/**
 * The PWA logic, kept out of the components on purpose.
 *
 * `apps/console` cannot render a `.tsx` in a test — no jsdom, no
 * testing-library, no vitest, no jest — so anything written inside a component
 * is unreachable from the suite. Every decision this feature makes therefore
 * lives here as a function over plain values, and `components/pwa.tsx` and
 * `components/connection-status.tsx` do nothing but read the browser and
 * render the answer.
 *
 * ## The one principle this file must not break
 *
 * `public/sw.js` says it, and it is right:
 *
 * > This console shows live fleet state, so caching an API response would mean
 * > an operator acting on numbers that are no longer true.
 *
 * So "offline support" here is **not** "keeps working offline". It is
 * "says, out loud, that what is on the screen is old, and how old". Nothing in
 * this file may make a stale number look current, and `connectionView()` is
 * built so that the *only* thing it can report about the data is the moment it
 * arrived.
 */

import { COLOR_TOKENS } from "./tokens.ts";

/* ── The manifest ────────────────────────────────────────────────────────
 *
 * The document itself is here rather than in `app/manifest.ts`, and the route
 * is a two-line caller. That is the same rule the rest of this file follows —
 * testable values in `lib/`, framework shell on top — and it is here because
 * the alternative was tried and broke the suite:
 *
 * `node --test` resolves ES module specifiers itself and knows nothing about
 * `tsconfig.json`'s `paths`. Only Next and `tsc` expand `@/`. So the moment
 * `app/manifest.ts` grew one `import … from "@/lib/tokens"`, a test file that
 * imported it died with `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'` —
 * and it died at *import* time, which takes the whole file with it. Every one
 * of this file's tests vanished at once and the run reported a single failure,
 * so the pass count fell by 35 while the summary said "1 fail". Nothing under
 * `lib/` may reach across into `app/`, for that reason.
 *
 * `app/manifest.ts` is checked by `lib/pwa.test.ts` — as text, not by
 * importing it — to be a caller and nothing else.
 */

/**
 * `purpose` is `any` or `maskable` and the distinction is not cosmetic: a
 * launcher crops a maskable icon to its own shape, so an `any` icon promoted
 * to maskable gets its edges cut off.
 */
export type ManifestIcon = {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: "any" | "maskable";
};

export type ManifestScreenshot = {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly form_factor: "narrow" | "wide";
  readonly label: string;
};

export type ConsoleManifest = {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: "standalone";
  readonly orientation: "any";
  readonly background_color: string;
  readonly theme_color: string;
  readonly categories: string[];
  readonly icons: ManifestIcon[];
  readonly screenshots: ManifestScreenshot[];
};

/**
 * What `/manifest.webmanifest` serves.
 *
 * `display: standalone` is what makes an installed console open without browser
 * chrome; `scope` keeps an installed window from wandering onto another
 * tenant's subdomain, which would silently show a session it does not have.
 *
 * ## Why there are bitmaps as well as the SVG
 *
 * The console used to declare two SVGs and nothing else. An SVG icon is
 * accepted by the manifest parser, so the file looked complete, and it is the
 * wrong format for every path that actually installs anything:
 *
 * - **Android/WebAPK** rasterises the icon at install time and wants a real
 *   `192` and `512`. Chrome's install criteria are written against pixel
 *   sizes, and `sizes: "any"` on an SVG satisfies them only by accident of
 *   parsing.
 * - **`purpose: "maskable"`** exists so a launcher can crop the art to
 *   whatever shape the device uses. The safe zone in `icon-maskable.svg` was
 *   already correct — the art spans x=21..43 of a 64 viewBox — so what was
 *   missing was never the drawing, only a bitmap of it.
 * - **iOS ignores this document's icons completely** and reads
 *   `apple-touch-icon`, which is declared in `app/layout.tsx` and must also be
 *   a PNG.
 *
 * `lib/pwa.test.ts` decodes each PNG off disk: the declared `sizes` against the
 * header, because a manifest that claims 512 and ships 192 is silently
 * downgraded by the launcher and reads as correct from the JSON; and the
 * pixels against the SVG they were rendered from, because a file can be exactly
 * 192x192 and still be a crop of the top-left corner.
 *
 * ## The screenshots
 *
 * Chromium only shows the richer install dialog when there is at least one
 * `narrow` and one `wide` screenshot; with none it falls back to a one-line
 * bar. Both are checked in by this card, and how they were produced is written
 * down in `docs/goals/vodoge-ui-refactor/notes/T016-pwa-install-offline.md` —
 * they are rendered from this design system's own tokens with demo data, not
 * captured from a tenant, because no real fleet's numbers belong in an install
 * dialog and this card has no session to capture one with.
 */
export function consoleManifest(): ConsoleManifest {
  return {
    id: "/",
    name: "VoDoge Console",
    short_name: "VoDoge",
    description: "Multi-tenant modem fleet console",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    // From the token table, not typed again. The splash screen an installed
    // console shows before its first paint is drawn from these two, so a
    // hand-copied pair means a launch that flashes the old palette.
    background_color: COLOR_TOKENS.bg.dark,
    theme_color: COLOR_TOKENS.bg.dark,
    categories: ["business", "utilities"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    screenshots: [
      {
        src: "/screenshot-mobile.png",
        // A 390px phone layout rasterised at 2x, so it stays sharp in the
        // install dialog on the sort of screen that is going to show it.
        sizes: "780x1688",
        type: "image/png",
        form_factor: "narrow",
        label: "Fleet overview on a phone",
      },
      {
        src: "/screenshot-wide.png",
        sizes: "1280x800",
        type: "image/png",
        form_factor: "wide",
        label: "Fleet overview on a desktop",
      },
    ],
  };
}

/* ── Installing ──────────────────────────────────────────────────────────
 *
 * Two entirely different mechanisms wearing one word.
 *
 * Chromium fires `beforeinstallprompt`, which can be deferred and replayed
 * from a button. **Safari has never fired it and there is no equivalent**, so
 * on iOS the only route is the user finding Share → Add to Home Screen by
 * themselves. A console that renders the Chromium button and nothing else has
 * no install path at all on iPhone or iPad — which is where an operator on
 * call actually reads it.
 */

export type Platform = "ios" | "android" | "other";

/**
 * `maxTouchPoints` is not a nicety.
 *
 * iPadOS 13 and later request desktop sites by default, and the user-agent
 * they send is byte-for-byte a macOS Safari one — `Macintosh; Intel Mac OS X`.
 * There is no iPad in it. The only thing separating the two is that the iPad
 * reports touch points and a Mac reports zero, so without this an iPad is
 * classified as a desktop, gets offered a `beforeinstallprompt` button that
 * Safari will never fire, and ends up with no way to install.
 */
export function detectPlatform(userAgent: string, maxTouchPoints = 0): Platform {
  const ua = userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/**
 * The display modes that mean "installed".
 *
 * `standalone` is the one this app's manifest asks for, but a user can end up
 * in `fullscreen` or `minimal-ui` through `display_override` or a launcher's
 * own choice, and all three mean the same thing to us: the install prompt has
 * already been answered and must not be shown again.
 */
export const STANDALONE_QUERIES = [
  "(display-mode: standalone)",
  "(display-mode: fullscreen)",
  "(display-mode: minimal-ui)",
] as const;

/**
 * `iosStandalone` is `navigator.standalone`, which is Safari-only and the
 * *only* signal there: iOS supports the display-mode media query in a home
 * screen app but has historically not, so both are asked and either counts.
 */
export function isStandalone(
  matches: (query: string) => boolean,
  iosStandalone: boolean,
): boolean {
  if (iosStandalone) return true;
  return STANDALONE_QUERIES.some((query) => matches(query));
}

export type InstallState =
  /** Already a home-screen app. Offer nothing. */
  | "installed"
  /** A deferred `beforeinstallprompt` is in hand: one button does it. */
  | "promptable"
  /** iOS: no prompt exists, so the only honest thing to render is directions. */
  | "ios-guide"
  /** Desktop Firefox, an already-dismissed prompt, a non-installable context. */
  | "unavailable";

export function installState(input: {
  standalone: boolean;
  promptAvailable: boolean;
  platform: Platform;
}): InstallState {
  if (input.standalone) return "installed";
  if (input.promptAvailable) return "promptable";
  if (input.platform === "ios") return "ios-guide";
  return "unavailable";
}

/** Where a dismissal is remembered, so the bar asks once rather than daily. */
export const INSTALL_DISMISSED_KEY = "vodoge.install.dismissed";

/* ── Offline honesty ─────────────────────────────────────────────────────
 *
 * The half of the checklist that did not exist. Falling back to
 * `public/offline.html` covers a *navigation* that fails; it says nothing
 * about the far more common case, which is a console left open on a desk whose
 * network goes away. Every number on that screen then keeps its last value
 * with no indication at all that it stopped being true — which is precisely
 * the failure `sw.js` refuses to cause by caching, arriving by another door.
 *
 * The timestamp cannot live in `offline.html`: that file is a static asset and
 * has no way to know when this tab last heard from the gateway.
 */

/** Two, not one. A single failure is a blip; a banner that flaps is noise. */
export const LOST_AFTER_FAILURES = 2;

/**
 * A static asset, so a probe costs the gateway nothing, and it is deliberately
 * *not* under `/api/` or `/v1/`: probing an authenticated endpoint on a timer
 * would extend a session that the operator is not actually using.
 *
 * `sw.js` does not cache this path — it caches only `/_next/static/` and
 * `/icon.svg` — so a 200 here really did come off the network.
 */
export const PROBE_PATH = "/manifest.webmanifest";

/** How often to re-check while disconnected. Only ever runs while lost. */
export const PROBE_INTERVAL_MS = 15_000;

/**
 * Which requests say something about the connection.
 *
 * Same-origin `/api/` and `/v1/` only. A failed request to a third party says
 * nothing about our gateway, and `/_next/static/` may be answered from the
 * service worker's cache, which would report "connected" while offline.
 */
export function isWatchedRequest(url: string, origin: string): boolean {
  if (!url) return false;
  let resolved: URL;
  let base: URL;
  try {
    base = new URL(origin);
    resolved = new URL(url, origin);
  } catch {
    return false;
  }
  if (resolved.origin !== base.origin) return false;
  return resolved.pathname.startsWith("/v1/") || resolved.pathname.startsWith("/api/");
}

/** `fetch` takes a string, a `URL` or a `Request`; all three carry the target. */
export function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const asRequest = input as { url?: unknown; href?: unknown };
    if (typeof asRequest.url === "string") return asRequest.url;
    if (typeof asRequest.href === "string") return asRequest.href;
  }
  return "";
}

/**
 * A rejected `fetch` is not always a lost connection.
 *
 * `AbortError` is the caller cancelling on purpose — a superseded search, a
 * component unmounting mid-request — and the console does that on several
 * pages. Counting those as connection failures would put a "connection lost"
 * banner on a screen whose network is perfectly fine, which is the same lie as
 * showing stale data, only in the other direction.
 *
 * Note the asymmetry with what counts as *reachable*: any resolved response
 * does, including a 500. A 500 means the gateway answered — the connection is
 * up and the problem is elsewhere, and this banner must not claim otherwise.
 */
export function isConnectionFailure(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name !== "AbortError";
}

export type ConnectionSnapshot = {
  /** `navigator.onLine`. False is reliable; true only means an interface exists. */
  readonly online: boolean;
  /** Consecutive watched failures since the last time something got through. */
  readonly failures: number;
  /** When a watched request last succeeded in this tab, or `null`. */
  readonly lastOkAt: number | null;
  /** When the server rendered the page this tab is showing. */
  readonly loadedAt: number;
};

export type ConnectionView = {
  readonly lost: boolean;
  /** The moment the newest thing on the screen arrived. Never "now". */
  readonly dataAt: number;
};

/**
 * The whole judgement, in one pure function.
 *
 * `dataAt` is the newer of two facts, and both are facts rather than
 * estimates: the server rendered this page at `loadedAt`, and any client fetch
 * that has landed since is newer still. There is deliberately no third branch
 * that falls back to the current time — that would be the bug this feature
 * exists to prevent, written into the thing meant to prevent it.
 */
export function connectionView(snapshot: ConnectionSnapshot): ConnectionView {
  const dataAt =
    snapshot.lastOkAt !== null && snapshot.lastOkAt > snapshot.loadedAt
      ? snapshot.lastOkAt
      : snapshot.loadedAt;
  const lost = !snapshot.online || snapshot.failures >= LOST_AFTER_FAILURES;
  return { lost, dataAt };
}

/** `HH:MM` in the reader's own clock. Zero-padded, 24 hour, no locale surprises. */
export function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/* ── The monitor ─────────────────────────────────────────────────────────
 *
 * Sixteen client components already call `fetch("/v1/…")` directly, and none
 * of them are this card's files. Rather than thread a reporting callback
 * through every one of them — sixteen edits, each of which the next card can
 * forget — the monitor wraps `window.fetch` once and observes. It changes no
 * behaviour: the original is called with the original arguments, the response
 * is returned untouched and the rejection is re-thrown unchanged.
 *
 * Everything the browser supplies arrives through `ConnectionHost` so that the
 * suite can drive the whole thing with plain objects.
 */

export type FetchLike = (input: unknown, init?: unknown) => Promise<unknown>;

export type ConnectionHost = {
  readonly origin: string;
  now(): number;
  isOnline(): boolean;
  /** Must already be safe to call unbound — browsers throw on a bare `fetch`. */
  getFetch(): FetchLike | undefined;
  setFetch(next: FetchLike): void;
  /** Returns its own undo, so `stop()` cannot leak a listener. */
  listen(event: "online" | "offline", handler: () => void): () => void;
  /** Runs `handler` every `ms` until the returned function is called. */
  every(ms: number, handler: () => void): () => void;
};

export type ConnectionMonitor = {
  view(): ConnectionView;
  subscribe(listener: (view: ConnectionView) => void): () => void;
  /** Check the connection now, out of band. Resolves once the answer is in. */
  probe(): Promise<void>;
  stop(): void;
};

export function createConnectionMonitor(
  host: ConnectionHost,
  options: { loadedAt: number },
): ConnectionMonitor {
  let online = host.isOnline();
  let failures = 0;
  let lastOkAt: number | null = null;
  let stopped = false;
  let cancelProbes: (() => void) | null = null;

  const listeners = new Set<(view: ConnectionView) => void>();
  const undo: (() => void)[] = [];
  const underlying = host.getFetch();

  const snapshot = (): ConnectionSnapshot => ({
    online,
    failures,
    lastOkAt,
    loadedAt: options.loadedAt,
  });

  let last = connectionView(snapshot());

  function publish(): void {
    const next = connectionView(snapshot());
    // Only when the answer changed. `lost` flipping is what the banner cares
    // about, and `dataAt` moving forward while connected is not worth a render.
    const changed = next.lost !== last.lost || next.dataAt !== last.dataAt;
    last = next;
    schedule();
    if (!changed) return;
    for (const listener of listeners) listener(next);
  }

  /**
   * Poll only while disconnected.
   *
   * A heartbeat that runs all the time is traffic the console does not need
   * and a session it keeps warm for no reason. While the banner is up there is
   * a real question to answer — "is it back yet" — and nobody else is going to
   * ask it, because the page is not fetching anything.
   */
  function schedule(): void {
    if (stopped) return;
    if (last.lost && !cancelProbes) {
      cancelProbes = host.every(PROBE_INTERVAL_MS, () => {
        void probe();
      });
      return;
    }
    if (!last.lost && cancelProbes) {
      cancelProbes();
      cancelProbes = null;
    }
  }

  function noteReachable(): void {
    lastOkAt = host.now();
    failures = 0;
    // A response proves the network is there whatever `navigator.onLine` says;
    // it is wrong often enough in the "captive portal just let us out"
    // direction to be worth overruling with evidence.
    online = true;
    publish();
  }

  function noteUnreachable(): void {
    failures += 1;
    publish();
  }

  async function probe(): Promise<void> {
    const original = underlying;
    if (!original || stopped) return;
    try {
      // Cache-busted *and* `no-store`: without both, a probe can be answered
      // out of the HTTP cache and report a connection that is not there.
      await original(`${PROBE_PATH}?probe=${host.now()}`, { cache: "no-store" });
      noteReachable();
    } catch (error) {
      if (isConnectionFailure(error)) noteUnreachable();
    }
  }

  if (underlying) {
    const wrapped: FetchLike = (input, init) => {
      const watched = isWatchedRequest(requestUrl(input), host.origin);
      const result = underlying(input, init);
      if (!watched) return result;
      return result.then(
        (response) => {
          noteReachable();
          return response;
        },
        (error: unknown) => {
          if (isConnectionFailure(error)) noteUnreachable();
          // Re-thrown unchanged. Observing must never swallow a rejection the
          // caller is already handling.
          throw error;
        },
      );
    };
    host.setFetch(wrapped);
    undo.push(() => host.setFetch(underlying));
  }

  undo.push(
    host.listen("offline", () => {
      online = false;
      publish();
    }),
  );
  undo.push(
    host.listen("online", () => {
      // `online` means an interface came back, not that the gateway answers.
      // The banner stays up until something actually gets through.
      void probe();
    }),
  );

  // A tab opened while already offline starts lost, and nothing has published
  // yet, so the polling has to be armed here or it would never re-check.
  schedule();

  return {
    view: () => last,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    probe,
    stop() {
      stopped = true;
      if (cancelProbes) cancelProbes();
      cancelProbes = null;
      listeners.clear();
      while (undo.length) undo.pop()?.();
    },
  };
}
