"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createConnectionMonitor,
  formatClock,
  type ConnectionHost,
  type ConnectionView,
  type FetchLike,
} from "@/lib/pwa";
import { PWA, SAFE_AREA } from "@/lib/tokens";

/**
 * The missing half of "offline honesty".
 *
 * `public/sw.js` already handles a *navigation* that fails: it serves
 * `public/offline.html` instead of the browser's error page. It does nothing
 * for the case that actually happens on a shift — a console already open on a
 * desk whose network goes away. Every number on that screen keeps its last
 * value, and until this component existed there was no indication anywhere
 * that it had stopped being true. That is the same harm `sw.js` refuses to
 * cause by caching `/api/`, arriving by a different door.
 *
 * The timestamp cannot live in `offline.html`, which is why this is a
 * component at all: that file is a static asset and cannot know when this tab
 * last heard from the gateway.
 *
 * ## Why this is not in `components/shell.tsx`
 *
 * PM's call, and it holds up on its own: the shell is a different card's file,
 * and this banner has to be visible on a page that renders without the shell.
 * `app/layout.tsx` mounts it as a sibling.
 *
 * ## Why it renders `null` until an event
 *
 * The server cannot know whether this tab's network works, so anything drawn
 * during the server render would be a guess. Returning `null` on the server
 * and on the first client render also keeps the clock — which is formatted in
 * the reader's own time zone — out of the hydration comparison entirely.
 */
export function ConnectionStatus({
  labels,
  loadedAt,
}: {
  /**
   * The three sentences this banner can show, already resolved by the server.
   *
   * They arrive translated rather than as a locale this component looks up,
   * because `app/layout.tsx` mounts this on every page: a `t()` call here puts
   * `lib/i18n.ts` — and with it both message catalogues, one 27.7 kB gzipped
   * chunk — into the layout's client graph, which every route then downloads.
   * Measured on this tree, and it is the whole reason the prop has this shape.
   *
   * Handing over three finished strings costs the wire what those three
   * strings weigh. Nothing was shortened to get there; the sentences are the
   * catalogue's, verbatim, resolved one step earlier.
   */
  labels: { lost: string; stale: string; retry: string };
  /**
   * When the server produced the page this tab is showing, in epoch
   * milliseconds. It is a prop rather than something read here because it is
   * the one fact only the server has: it is the age of the numbers already on
   * the screen.
   */
  loadedAt: number;
}) {
  const [view, setView] = useState<ConnectionView | null>(null);

  useEffect(() => {
    const host: ConnectionHost = {
      origin: window.location.origin,
      now: () => Date.now(),
      isOnline: () => window.navigator.onLine,
      // Bound, because a browser `fetch` called with the wrong receiver throws
      // "Illegal invocation" — which would break every request on the page.
      getFetch: () => window.fetch.bind(window) as FetchLike,
      setFetch: (next) => {
        window.fetch = next as typeof window.fetch;
      },
      listen: (event, handler) => {
        window.addEventListener(event, handler);
        return () => window.removeEventListener(event, handler);
      },
      every: (ms, handler) => {
        const id = window.setInterval(handler, ms);
        return () => window.clearInterval(id);
      },
    };

    const monitor = createConnectionMonitor(host, { loadedAt });
    setView(monitor.view());
    const unsubscribe = monitor.subscribe(setView);
    return () => {
      unsubscribe();
      monitor.stop();
    };
  }, [loadedAt]);

  if (!view?.lost) return null;

  return (
    <div
      className={PWA.connection.bar}
      style={SAFE_AREA.fixedBottom}
      role="status"
      aria-live="polite"
    >
      <div className={PWA.connection.inner}>
        <span className={PWA.connection.mark} aria-hidden="true" />
        <strong className={PWA.connection.title}>{labels.lost}</strong>
        {/* The clock is the whole point. "Offline" on its own invites the
            reader to assume the numbers are merely a moment old. */}
        <span className={PWA.connection.detail}>{labels.stale}</span>
        <span className={PWA.connection.time}>{formatClock(new Date(view.dataAt))}</span>
        <span className={PWA.connection.actions}>
          <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
            {labels.retry}
          </Button>
        </span>
      </div>
    </div>
  );
}
