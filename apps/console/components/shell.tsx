import Link from "next/link";
import { LocaleSwitch } from "@/components/locale-switch";
import { SignOutButton } from "@/components/sign-out";
import { ThemeToggle } from "@/components/theme-toggle";
import { t, type Locale } from "@/lib/i18n";
import type { Tenant } from "@/lib/tenant";

/** Nav is data so the header markup does not grow a branch per destination. */
const NAV = [
  { href: "/", key: "nav.overview" },
  { href: "/devices", key: "nav.devices" },
  { href: "/inbox", key: "nav.inbox" },
  { href: "/sessions", key: "nav.sessions" },
  { href: "/rules", key: "nav.rules" },
  { href: "/audit", key: "nav.audit" },
  { href: "/settings", key: "nav.settings" },
] as const;

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
          <span className="brand-mark" aria-hidden="true">
            V
          </span>
          {t("app.name", locale)}
        </Link>

        <nav className="shell-nav" aria-label={t("nav.label", locale)}>
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              // Only the exact path is current. A prefix match would light up
              // the overview link on every page, since its href is "/".
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {t(item.key, locale)}
            </Link>
          ))}
        </nav>

        <div className="shell-side">
          <span className="tenant-chip" title={tenant.tenant_id}>
            <strong>{tenant.slug}</strong>
            <span className="faint">{regionLabel}</span>
          </span>
          <ThemeToggle
            labels={{
              toggle: t("theme.toggle", locale),
              dark: t("theme.dark", locale),
              light: t("theme.light", locale),
            }}
          />
          <LocaleSwitch locale={locale} />
          <SignOutButton label={t("nav.logout", locale)} />
        </div>
      </header>

      <main className="shell-main">{children}</main>
    </div>
  );
}
