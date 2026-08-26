import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ConnectionStatus } from "@/components/connection-status";
import { InstallPrompt, ServiceWorker } from "@/components/pwa";
import { Shell } from "@/components/shell";
import { htmlLang, t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { TENANT_HEADER } from "@/lib/tenant";
import { getTenantFromHeaders, sessionToken } from "@/lib/tenant-headers";
import { COLOR_TOKENS, SAFE_AREA } from "@/lib/tokens";
import "./globals.css";

export const dynamic = "force-dynamic";

/**
 * The status bar colour of the document the server just sent.
 *
 * That document is dark, on every route and for every reader. `globals.css`
 * declares `color-scheme: dark` on bare `:root` and contains no
 * `prefers-color-scheme` rule anywhere, so the light theme is reachable only
 * through `:root[data-theme="light"]` — an attribute nothing but script sets,
 * after hydration, from a choice that lives in `localStorage`.
 *
 * This used to be a pair keyed on `prefers-color-scheme`, which answered a
 * question about the reader's phone with a fact about the page. It was wrong
 * in both directions and nobody had looked, because it is only visible on a
 * phone: a light phone got a pale bar above the dark login screen, and a
 * signed-in reader whose stored choice disagreed with their system got the
 * mismatch the other way round — so the people it failed were the ones who
 * had actually used the toggle.
 *
 * So: one value, the one that is really painted when no script has run.
 * `components/theme-toggle.tsx` repoints it whenever it sets `data-theme`,
 * reading the colour back out of the stylesheet, which is what keeps the bar
 * and the background in step from then on.
 *
 * Still read from the token table rather than typed again: a hand-copied hex
 * is a third place a palette change has to be remembered — the sort that gets
 * found later, on a phone, as a status bar in last season's colour.
 */
export const viewport: Viewport = {
  themeColor: COLOR_TOKENS.bg.dark,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return {
    title: t("app.name", locale),
    description: t("app.tagline", locale),
    applicationName: "VoDoge",
    manifest: "/manifest.webmanifest",
    /**
     * iOS ignores the manifest's icons entirely and reads `apple-touch-icon`,
     * and it does not render SVG. Until this line existed the console shipped
     * two SVG icons and no bitmap, so an iPhone that added it to the home
     * screen got neither: it fell back to a screenshot of the page, which is
     * the downgraded icon T023 found. A PNG is the only format that works
     * there, and 180 is the largest size iOS asks for.
     */
    icons: {
      icon: [
        { url: "/icon.svg", type: "image/svg+xml" },
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    // Tells iOS to open an added-to-home-screen console without browser chrome;
    // Safari has no install prompt, so this is the only way to get there.
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "VoDoge" },
    formatDetection: { telephone: false },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getRequestLocale();
  const tenant = await getTenantFromHeaders();
  const pathname = (await headers()).get(TENANT_HEADER.pathname) ?? "";
  // The shell carries navigation and a sign-out button, so it only belongs on a
  // page reached with a session. Rendering it around the login form offers to
  // sign out of a session that does not exist and links to pages that will
  // bounce straight back here.
  const signedIn = Boolean(await sessionToken());
  // The age of what is about to be rendered. `dynamic = "force-dynamic"` means
  // this really is per request, so it is the honest answer to "how old are
  // these numbers" — and it is the one fact the client cannot work out for
  // itself. See components/connection-status.tsx.
  const loadedAt = Date.now();

  return (
    <html lang={htmlLang(locale)}>
      {/* The left/right insets, which nothing had. `body` already carries the
          bottom one from globals.css; see SAFE_AREA.sides for why the sides
          matter on a device that is not even installed. */}
      <body style={SAFE_AREA.sides}>
        <ServiceWorker />
        {/* Every string these two banners can draw is resolved here, on the
            server, and handed over finished.

            This layout wraps every route, so whatever its client components
            import, every route downloads. When these took a `locale` and
            called `t()` themselves, that was `lib/i18n.ts` and both message
            catalogues — one 27.7 kB gzipped chunk — on the wire for pages that
            never render a word of it. `next build`'s First Load JS column does
            not show it, because that column omits the root layout's chunks;
            the union of the layout's and the route's entries in
            `.next/app-build-manifest.json` does, and matches the script tags
            in the delivered HTML exactly.

            Nothing is abbreviated to make that number: the catalogue is
            unchanged and these are its sentences, resolved one step earlier. */}
        <InstallPrompt
          labels={{
            title: t("pwa.install.title", locale),
            hint: t("pwa.install.hint", locale),
            iosTitle: t("pwa.install.iosTitle", locale),
            iosHint: t("pwa.install.iosHint", locale),
            action: t("pwa.install.action", locale),
            dismiss: t("pwa.install.dismiss", locale),
          }}
        />
        {tenant && signedIn ? (
          <>
            <Shell tenant={tenant} locale={locale} pathname={pathname}>
              {children}
            </Shell>
            {/* A sibling of the shell rather than part of it: the banner is
                this card's, the shell is T007's, and they have to be able to
                change without touching each other. */}
            <ConnectionStatus
              labels={{
                lost: t("connection.lost", locale),
                stale: t("connection.stale", locale),
                retry: t("connection.retry", locale),
              }}
              loadedAt={loadedAt}
            />
          </>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
