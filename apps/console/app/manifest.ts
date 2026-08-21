import type { MetadataRoute } from "next";

/**
 * Served from a route rather than a static file so the name follows the
 * request's locale the same way the rest of the console does.
 *
 * `display: standalone` is what makes an installed console open without browser
 * chrome; `scope` keeps an installed window from wandering onto another tenant's
 * subdomain, which would silently show a session it does not have.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VoDoge Console",
    short_name: "VoDoge",
    description: "Multi-tenant modem fleet console",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0e14",
    theme_color: "#0b0e14",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
