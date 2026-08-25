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
