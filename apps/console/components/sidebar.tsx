import Link from "next/link";
import { cn } from "@/lib/cn";
import { t, type Locale } from "@/lib/i18n";
import { NAV_GROUPS, navState } from "@/lib/tokens";

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
 * Below `md` this rail is `display: none` and the phone bar is what draws
 * instead. Exactly one of the two is ever on screen.
 */
export function Sidebar({ locale, pathname }: { locale: Locale; pathname: string }) {
  return (
    <aside className="hidden w-rail shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-base font-semibold tracking-tight text-foreground">
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded bg-gradient-to-br from-accent to-accent-strong text-xs font-bold text-accent-ink"
          aria-hidden="true"
        >
          V
        </span>
        {t("app.name", locale)}
      </div>

      <nav
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-2"
        aria-label={t("nav.label", locale)}
      >
        {NAV_GROUPS.map((group) => (
          <div
            key={group.label ?? group.items[0].href}
            className="flex flex-col gap-1 border-t border-line-strong pt-3 first:border-t-0 first:pt-0"
          >
            {group.label ? (
              <span className="px-1 font-mono text-xs font-medium uppercase tracking-eyebrow text-muted-foreground">
                {t(group.label, locale)}
              </span>
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
                  className={cn(
                    "flex min-h-touch items-center gap-2 rounded px-3 text-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground",
                    state ? "bg-accent-wash font-semibold text-foreground" : undefined,
                  )}
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
      className="size-4 shrink-0"
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
