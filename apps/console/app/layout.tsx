import type { Metadata, Viewport } from "next";
import { DM_Mono } from "next/font/google";
import { headers } from "next/headers";
import { ConnectionStatus } from "@/components/connection-status";
import { MobileNav } from "@/components/mobile-nav";
import { InstallPrompt, ServiceWorker } from "@/components/pwa";
import { Shell, SourceFooter } from "@/components/shell";
import { htmlLang, t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { TENANT_HEADER } from "@/lib/tenant";
import { getTenantFromHeaders, sessionToken } from "@/lib/tenant-headers";
import { COLOR_TOKENS, SAFE_AREA, SHELL } from "@/lib/tokens";
import "./globals.css";

export const dynamic = "force-dynamic";

/**
 * DM Mono, fetched during the build and served from this origin.
 *
 * `next/font` downloads the face while `next build` runs and rewrites the
 * `@font-face` to point at a file this server hosts, so the delivered page
 * asks Google for nothing at all: no stylesheet and no font file crosses to a
 * third party, and nobody outside this origin learns who reads the console.
 *
 * It is bound to `--font-mono`, the property the recipes already resolve
 * through, rather than to a name of its own. A new custom property is not
 * available from here: `tokens.test.ts` requires every `var()` the Tailwind
 * theme names to be a key of the token tables, and deep-equals those tables
 * against the `:root` in `globals.css` — so a new name would have to be added
 * to two files this card does not own. The existing name is also the honest
 * one, because the console's monospace face is exactly what is being replaced.
 *
 * The class goes on `body` rather than on `html`. On `html` it would land on
 * the same element as `:root`, at the same specificity, and which one won
 * would come down to the order the two sheets happen to be injected in.
 * `body` is a descendant, so the property is inherited into the subtree and
 * the question does not arise. `globals.css` is left alone, which also keeps
 * the declared value of this shared token byte-identical for the edge.
 *
 * 🔴 **The three CJK families are the reason this is a chain and not one
 * name, and dropping them fails only in Chinese.** Every column heading here
 * is translated — `messages/zh.json` answers `devices.colName` with 设备 —
 * and DM Mono carries no CJK glyphs, nor does any monospace face after it.
 * Naming the same CJK families `--font-ui` names keeps a Chinese heading in
 * the typeface it renders in today; without them the browser falls through to
 * a last-resort face, which is a change no English page would ever show.
 * They are ahead of the generic on purpose, because a generic ends the search.
 *
 * Weights 400 and 500 are the two the recipes ask for, and 500 is the top of
 * what DM Mono publishes. The eyebrow recipes therefore say `font-medium`
 * rather than the `font-semibold` they used to: 600 does not exist in this
 * face, and asking for it buys a synthesised bold instead of a drawn one.
 */
const monoFace = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
  fallback: [
    "ui-monospace",
    "SFMono-Regular",
    "SF Mono",
    "Menlo",
    "Consolas",
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    "monospace",
  ],
});

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
      <body style={SAFE_AREA.sides} className={monoFace.variable}>
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
        {/* 🔴 The one column every route is drawn in, and the source footer
            at the end of it, are outside the gate below. That is the whole of
            this card. The shell used to own both, and the shell is the thing
            the gate withholds — so the source links were on all nine signed-in
            pages and missing from /login, which is the only page a stranger
            can reach. T094 measured that on the deployed console: 200 in both
            languages, no footer, no repository links at all.

            The column moved up here rather than the footer moving down into
            the shell, because a footer the shell owns is a footer the gate
            owns. What a signed-in page renders is unchanged by the move: the
            same header, the same content column, the same footer, the same
            three children of the same one column. */}
        <div className={SHELL.root}>
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
          <SourceFooter locale={locale} />
          {/* 🔴 After the footer, and that is the whole reason it is drawn
              here rather than inside the shell. The bar is `position: fixed`,
              so it covers whatever the document ends with — and what this
              document ends with is the source links, the one thing on the page
              addressed to people who are not signed in. `MobileNav` draws a
              gutter of its own height as its last element, which only clears
              the footer if it comes after it.

              Gated with the shell for the ordinary reason: it links to pages
              that bounce a reader without a session straight back to /login. */}
          {tenant && signedIn ? <MobileNav locale={locale} pathname={pathname} /> : null}
        </div>
      </body>
    </html>
  );
}
