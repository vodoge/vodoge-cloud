import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ServiceWorker } from "@/components/pwa";
import { Shell } from "@/components/shell";
import { htmlLang, t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { TENANT_HEADER } from "@/lib/tenant";
import { getTenantFromHeaders, sessionToken } from "@/lib/tenant-headers";
import "./globals.css";

export const dynamic = "force-dynamic";

/** Matches the app background so the phone status bar blends with the shell. */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0e14" },
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
  ],
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

  return (
    <html lang={htmlLang(locale)}>
      <body>
        <ServiceWorker />
        {tenant && signedIn ? (
          <Shell tenant={tenant} locale={locale} pathname={pathname}>
            {children}
          </Shell>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
