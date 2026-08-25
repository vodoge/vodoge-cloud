import type { MetadataRoute } from "next";

/**
 * Served from a route rather than a static file so the name follows the
 * request's locale the same way the rest of the console does.
 *
 * `display: standalone` is what makes an installed console open without browser
 * chrome; `scope` keeps an installed window from wandering onto another tenant's
 * subdomain, which would silently show a session it does not have.
 *
 * ## Why the bitmaps are here as well as the SVG
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
 * - **iOS ignores this file's icons completely** and reads `apple-touch-icon`,
 *   which is declared in `app/layout.tsx` and must also be a PNG.
 *
 * `lib/pwa.test.ts` reads each PNG's header off disk and checks that the
 * declared `sizes` is the size the file really is, because a manifest that
 * claims 512 and ships 192 is silently downgraded by the launcher and looks
 * exactly like a correct one from here.
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
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "VoDoge Console",
    short_name: "VoDoge",
    description: "Multi-tenant modem fleet console",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0e14",
    theme_color: "#0b0e14",
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
