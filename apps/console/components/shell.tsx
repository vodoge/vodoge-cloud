import Link from "next/link";
import { LocaleSwitch } from "@/components/locale-switch";
import { SignOutButton } from "@/components/sign-out";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/cn";
import { t, type Locale } from "@/lib/i18n";
import type { Tenant } from "@/lib/tenant";
import { NAV_GROUPS, SAFE_AREA, SHELL, navState } from "@/lib/tokens";

/**
 * The chrome every signed-in page renders inside: the header bar, the grouped
 * navigation, and the content column.
 *
 * The nav is four groups rather than a flat row of nine links, and the groups
 * live in `lib/tokens.ts` rather than here: a `.tsx` cannot be read by a test
 * in this app, so a nav written as markup is a nav nothing can check. The same
 * reason keeps every class string out of this file — `SHELL.*` is data that
 * `lib/tokens.test.ts` puts to the real Tailwind build.
 *
 * `locale` arrives as a prop the server resolved. Nothing here reads a cookie.
 *
 * 🔴 **The outermost element is not here any more.** `app/layout.tsx` draws
 * `SHELL.root` and puts `SourceFooter` at the end of it, so that the footer
 * reaches the pages this component never wraps — see the note on
 * `SourceFooter`. This returns a fragment so the signed-in arrangement is
 * unchanged by that move: the same three children of the same one column,
 * with the frame owned a level up instead of here.
 */
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
    <>
      <header className={SHELL.header}>
        {/* The inline style is the safe-area inset; see SAFE_AREA. */}
        <div className={SHELL.bar} style={SAFE_AREA.headerTop}>
          <Link href="/" className={SHELL.brand}>
            <span className={SHELL.brandMark} aria-hidden="true">
              V
            </span>
            {t("app.name", locale)}
          </Link>

          <div className={SHELL.side}>
            <span className={SHELL.tenant} title={tenant.tenant_id}>
              <strong className={SHELL.tenantSlug}>{tenant.slug}</strong>
              <span className={SHELL.tenantRegion}>{regionLabel}</span>
            </span>
            <ThemeToggle
              labels={{
                toggle: t("theme.toggle", locale),
                dark: t("theme.dark", locale),
                light: t("theme.light", locale),
              }}
            />
            <LocaleSwitch
              locale={locale}
              labels={{
                language: t("header.language", locale),
                zh: t("header.langZh", locale),
                en: t("header.langEn", locale),
              }}
            />
            <SignOutButton label={t("nav.logout", locale)} />
          </div>
        </div>

        <nav className={SHELL.nav} aria-label={t("nav.label", locale)}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label ?? group.items[0].href} className={SHELL.navGroup}>
              {group.label ? (
                <span className={SHELL.navGroupLabel}>{t(group.label, locale)}</span>
              ) : null}
              {group.items.map((item) => {
                const state = navState(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    // Only an exact match is the current page. A device detail
                    // page is inside the devices section, not the devices page.
                    aria-current={state === "page" ? "page" : undefined}
                    className={cn(SHELL.navLink, state ? SHELL.navLinkCurrent : undefined)}
                  >
                    {t(item.key, locale)}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </header>

      <main className={SHELL.main}>{children}</main>
    </>
  );
}

/**
 * Where the source is, and where each repository states its terms.
 *
 * Deliberately not a licence notice. This console carries no vowifi-go
 * code -- that was grepped for, and there is none -- so AGPL section 13
 * does not reach it. Nothing written here is an offer or a declaration: the
 * links point at the files that are, and those files are the only place the
 * terms are stated. This is what an open project looks like, not a duty
 * being discharged.
 *
 * One licence link per repository, and deliberately no combined one, because
 * the two repositories are not the same shape. vodoge-cloud is Apache-2.0
 * over every path, with no per-path exception. vodoge-edge's root LICENSE is
 * a map instead -- it says which directories are AGPL-3.0-or-later and which
 * are Apache-2.0, because vowifi-go reached two of its modules. One link
 * standing for both would be wrong about one of them. That asymmetry is why
 * the English reads "Console license" and "Edge licensing" and not the same
 * word twice.
 *
 * 🔴 **It is a component of its own, and the root layout draws it, because
 * for eleven days it was drawn by the shell -- and the shell is behind the
 * sign-in gate.** So it appeared on every page except the one page a
 * stranger can reach. T094 measured that on the deployed console rather
 * than reasoning about it: `/login` came back 200 in both languages with no
 * footer at all and zero links to the repositories. A source link is for
 * people who are not users yet; behind a sign-in it is addressed to the one
 * audience that has already decided.
 *
 * It stays outside every role gate too, for the same reason it is outside
 * the sign-in one: a read-only account is not a lesser reader.
 *
 * `locale` is resolved on the server and handed over. Reading it here, after
 * hydration, is the defect this repository has shipped twice: the served
 * HTML is then always in the default language, and the fetch that checks
 * this footer runs no JavaScript at all.
 */
export function SourceFooter({ locale }: { locale: Locale }) {
  return (
    <footer className={SHELL.footer}>
      <span className={SHELL.footerLabel}>{t("source.label", locale)}</span>
      <a
        className={SHELL.footerLink}
        href={t("source.consoleUrl", locale)}
        target="_blank"
        rel="noreferrer"
      >
        {t("source.console", locale)}
      </a>
      <a
        className={SHELL.footerLink}
        href={t("source.consoleLicenseUrl", locale)}
        target="_blank"
        rel="noreferrer"
      >
        {t("source.consoleLicense", locale)}
      </a>
      <a
        className={SHELL.footerLink}
        href={t("source.edgeUrl", locale)}
        target="_blank"
        rel="noreferrer"
      >
        {t("source.edge", locale)}
      </a>
      <a
        className={SHELL.footerLink}
        href={t("source.edgeLicenseUrl", locale)}
        target="_blank"
        rel="noreferrer"
      >
        {t("source.edgeLicense", locale)}
      </a>
    </footer>
  );
}
