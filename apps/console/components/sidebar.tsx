import Link from "next/link";
import { cn } from "@/lib/cn";
import { t, type Locale } from "@/lib/i18n";
import { NAV_GROUPS, SHELL, navState } from "@/lib/tokens";

/**
 * The desktop navigation rail.
 *
 * 🔴 **One of two renderers of `NAV_GROUPS`, and it names no destination of
 * its own.** `components/mobile-nav.tsx` is the other. Everything either of
 * them draws — the hrefs, the labels, the glyphs, and which four the phone
 * puts on its bar — is read out of that one array, so a destination added,
 * renamed or removed moves both at once. `lib/tokens.test.ts` enforces it the
 * only way it can for a file it cannot render: it reads the source of both and
 * fails if either contains a route or a message key of its own. That is what
 * stops this from becoming two lists that agree until the first time somebody
 * edits one.
 *
 * A server component. `locale` and `pathname` arrive as props the server
 * resolved, which is the defect this console has shipped twice: a nav that
 * reads either after hydration serves every reader the default language in the
 * HTML, and the check that reads this page runs no JavaScript at all.
 *
 * Below `md` it is `display: none` — see `SHELL.rail` — and the phone bar is
 * what draws instead. Exactly one of the two is ever on screen.
 */
export function Sidebar({ locale, pathname }: { locale: Locale; pathname: string }) {
  return (
    <aside className={SHELL.rail}>
      <div className={SHELL.railHeader}>
        <span className={SHELL.brandMark} aria-hidden="true">
          V
        </span>
        {t("app.name", locale)}
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
                  <NavIcon d={item.icon} />
                  {t(item.key, locale)}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/**
 * One navigation glyph, drawn from the path data on the nav entry.
 *
 * It lives here rather than in a file of its own because every `.tsx` under
 * `app/` and `components/` has to be on the ledger in `lib/tokens.ts`, and a
 * third file for six lines of markup is a third thing to keep registered. It
 * is imported by `components/mobile-nav.tsx` rather than the other way round
 * so that nothing imports in a circle: the shell draws this, this draws
 * nothing, and the phone bar draws this too.
 *
 * It carries its own class rather than taking one, so the two renderers cannot
 * end up drawing the same glyph at two sizes.
 *
 * `aria-hidden` because the word beside it already says where the link goes.
 * An accessible name here would make every entry announce itself twice.
 */
export function NavIcon({ d }: { d: string }) {
  return (
    <svg
      className={SHELL.navIcon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
