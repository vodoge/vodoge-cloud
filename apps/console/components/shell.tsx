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
  { href: "/journal", key: "nav.journal" },
  { href: "/audit", key: "nav.audit" },
  { href: "/proxy", key: "nav.proxy" },
  { href: "/settings", key: "nav.settings" },
] as const;

/**
 * Anchors are `text-decoration: none` globally, so a link that is not part of
 * a styled control has to say it is a link.
 */
const SOURCE_LINK = { textDecoration: "underline" } as const;

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

      {/* Where the source is.
          Deliberately not a licence notice. This console carries no vowifi-go
          code -- that was grepped for, and there is none -- so AGPL section 13
          does not reach it, and this repository declares no licence of its own;
          naming one here would be inventing an answer nobody has given. What is
          left is a fact worth putting on the page people actually use: the
          source is public, and this is where. It lives in the shell rather than
          on /settings so every page carries it, and outside every role gate,
          because a read-only account is not a lesser reader. */}
      <footer
        className="hint"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--s3)",
          padding: "var(--s4) var(--s5)",
          maxWidth: "1400px",
          width: "100%",
          margin: "0 auto",
        }}
      >
        <span className="faint">{t("source.label", locale)}</span>
        <a
          style={SOURCE_LINK}
          href={t("source.consoleUrl", locale)}
          target="_blank"
          rel="noreferrer"
        >
          {t("source.console", locale)}
        </a>
        <a style={SOURCE_LINK} href={t("source.edgeUrl", locale)} target="_blank" rel="noreferrer">
          {t("source.edge", locale)}
        </a>
        <a
          style={SOURCE_LINK}
          href={t("source.edgeLicenseUrl", locale)}
          target="_blank"
          rel="noreferrer"
        >
          {t("source.edgeLicense", locale)}
        </a>
      </footer>
    </div>
  );
}
