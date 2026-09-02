import { LocaleSwitch } from "@/components/locale-switch";
import { SignOutButton } from "@/components/sign-out";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { t, type Locale } from "@/lib/i18n";
import type { Tenant } from "@/lib/tenant";
import { SAFE_AREA } from "@/lib/tokens";

/**
 * The chrome every signed-in page renders inside: the navigation rail, a slim
 * header, and the content column beside them.
 *
 * 🔴 **The header no longer carries the navigation.** It used to hold four
 * groups of links, which wrapped to about three rows on a phone; that is now
 * `components/sidebar.tsx` on a wide screen and `components/mobile-nav.tsx` on
 * a narrow one, both drawing the same `NAV_GROUPS`. What is left here is the
 * brand and the controls — theme, language, sign out — which is why the
 * header is pinned at every width now rather than only above `sm`.
 *
 * The nav data lives in `lib/tokens.ts` rather than in either renderer: a
 * `.tsx` cannot be read by a test in this app, so a nav written as markup is a
 * nav nothing can check. The class strings no longer live there — they are
 * written out below — and what guarded them survives the move: this file is on
 * `MIGRATED_SOURCES`, so `lib/tokens.test.ts` reads its source and puts every
 * class in it to the real Tailwind build. A class that produces no CSS is
 * still a failing test rather than a silent no-op.
 *
 * `locale` arrives as a prop the server resolved. Nothing here reads a cookie.
 *
 * 🔴 **The outermost element is not here any more.** `app/layout.tsx` draws
 * the outer column and puts `SourceFooter` at the end of it, so that the footer
 * reaches the pages this component never wraps — see the note on
 * `SourceFooter`. This returns a fragment so the signed-in arrangement is
 * unchanged by that move, with the frame owned a level up instead of here.
 * `MobileNav` is drawn a level up as well, and for a related reason: its
 * gutter has to come after that footer or the bar covers it.
 */
export function Shell({
  tenant,
  locale,
  pathname: _pathname,
  children,
}: {
  tenant: Tenant;
  locale: Locale;
  /** Consumed by `AppSidebar`, which `app/layout.tsx` draws beside this. */
  pathname: string;
  children: React.ReactNode;
}) {
  const regionLabel = tenant.region === "cn" ? t("region.cn", locale) : t("region.intl", locale);

  return (
    <SidebarInset>
      <header className="sticky top-0 z-20 flex shrink-0 items-center border-b border-border bg-surface">
        {/* The inline style is the safe-area inset; see SAFE_AREA. */}
        <div
          className="mx-auto flex w-full max-w-page flex-wrap items-center gap-2 px-3 py-2 sm:px-6"
          style={SAFE_AREA.headerTop}
        >
          {/* 🔴 The one control that opens the navigation, at every width.
              The rail collapses to icons on a wide screen and to a drawer on a
              phone, and this is the trigger for both — the library decides
              which, from its own breakpoint, so this file no longer holds a
              second arrangement of the same ten destinations. */}
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface-hover px-3 py-1 text-xs text-muted-foreground"
              title={tenant.tenant_id}
            >
              <strong className="font-semibold text-foreground">{tenant.slug}</strong>
              <span className="hidden text-muted-foreground sm:inline">{regionLabel}</span>
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
      </header>

      <main className="mx-auto w-full max-w-page flex-1 px-3 py-4 sm:px-6 sm:py-6">{children}</main>
    </SidebarInset>
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
    <footer className="mx-auto flex w-full max-w-page flex-wrap items-center gap-3 px-3 py-4 text-sm text-muted-foreground sm:px-6">
      <span className="text-muted-foreground">{t("source.label", locale)}</span>
      <a
        className="underline transition-colors hover:text-foreground"
        href={t("source.consoleUrl", locale)}
        target="_blank"
        rel="noreferrer"
      >
        {t("source.console", locale)}
      </a>
      <a
        className="underline transition-colors hover:text-foreground"
        href={t("source.consoleLicenseUrl", locale)}
        target="_blank"
        rel="noreferrer"
      >
        {t("source.consoleLicense", locale)}
      </a>
      <a
        className="underline transition-colors hover:text-foreground"
        href={t("source.edgeUrl", locale)}
        target="_blank"
        rel="noreferrer"
      >
        {t("source.edge", locale)}
      </a>
      <a
        className="underline transition-colors hover:text-foreground"
        href={t("source.edgeLicenseUrl", locale)}
        target="_blank"
        rel="noreferrer"
      >
        {t("source.edgeLicense", locale)}
      </a>
    </footer>
  );
}
