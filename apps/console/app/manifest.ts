import type { MetadataRoute } from "next";
import { consoleManifest } from "@/lib/pwa";

/**
 * Served from a route rather than a static file so the name follows the
 * request's locale the same way the rest of the console does.
 *
 * The document itself is `consoleManifest()` in `lib/pwa.ts`, and this file is
 * deliberately nothing but the call. `apps/console` can render no component in
 * a test, so everything worth checking lives under `lib/` — and `node --test`
 * cannot resolve the `@/` alias that every file under `app/` uses, so a test
 * that reaches across into `app/` dies at import time and takes its whole file
 * with it. `lib/pwa.test.ts` asserts this file stays a caller.
 *
 * The return type is the point of the indirection being this thin: `tsc` checks
 * `ConsoleManifest` against Next's own `MetadataRoute.Manifest` right here, so
 * the plain-values version in `lib/` cannot drift out of the shape Next serves.
 */
export default function manifest(): MetadataRoute.Manifest {
  return consoleManifest();
}
