import type { Metadata } from "next";
import { headers } from "next/headers";
import { Shell } from "@/components/shell";
import { htmlLang, t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { TENANT_HEADER } from "@/lib/tenant";
import { getTenantFromHeaders } from "@/lib/tenant-headers";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return {
    title: t("app.name", locale),
    description: t("app.tagline", locale),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getRequestLocale();
  const tenant = await getTenantFromHeaders();
  const pathname = (await headers()).get(TENANT_HEADER.pathname) ?? "";

  return (
    <html lang={htmlLang(locale)}>
      <body>
        {tenant ? (
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
