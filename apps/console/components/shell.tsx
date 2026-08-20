import Link from "next/link";
import { LocaleSwitch } from "@/components/locale-switch";
import { t, type Locale } from "@/lib/i18n";
import type { Tenant } from "@/lib/tenant";

export function Shell({
  tenant,
  locale,
  pathname,
  children,
}: {
  tenant: Tenant;
  locale: Locale;
  pathname: string;
  children: React.ReactNode;
}) {
  const regionLabel = tenant.region === "cn" ? t("region.cn", locale) : t("region.intl", locale);

  return (
    <div className="shell">
      <header className="shell-header">
        <Link href="/" className="brand">
          {t("app.name", locale)}
        </Link>
        <nav className="shell-nav" aria-label={t("app.tagline", locale)}>
          <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
            {t("nav.devices", locale)}
          </Link>
          <Link href="/inbox" aria-current={pathname === "/inbox" ? "page" : undefined}>
            {t("nav.inbox", locale)}
          </Link>
          <Link href="/sessions" aria-current={pathname === "/sessions" ? "page" : undefined}>
            {t("nav.sessions", locale)}
          </Link>
          <Link href="/rules" aria-current={pathname === "/rules" ? "page" : undefined}>
            {t("nav.rules", locale)}
          </Link>
          <Link href="/audit" aria-current={pathname === "/audit" ? "page" : undefined}>
            {t("nav.audit", locale)}
          </Link>
          <Link href="/login" aria-current={pathname === "/login" ? "page" : undefined}>
            {t("nav.login", locale)}
          </Link>
        </nav>
        <div className="shell-meta">
          <span>
            {t("header.tenant", locale)} <code>{tenant.slug}</code>
          </span>
          <span className="region-badge" data-region={tenant.region} title={tenant.region}>
            {t("header.region", locale)}
            <strong>{regionLabel}</strong>
            <code className="region-code">{tenant.region}</code>
          </span>
          <LocaleSwitch locale={locale} />
        </div>
      </header>
      <main className="shell-main">{children}</main>
    </div>
  );
}
