"use client";

import { useEffect } from "react";

/**
 * Registers the service worker.
 *
 * Registration is deferred to the load event so it never competes with the
 * first render for bandwidth, and failure is swallowed: the console works
 * perfectly well without one, and a red console error would send someone
 * debugging a non-problem.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
