import Link from "next/link";
import { NavIcon } from "@/components/sidebar";
import { cn } from "@/lib/cn";
import { t, type Locale } from "@/lib/i18n";
import {
  BOTTOM_NAV,
  NAV_MORE,
  SAFE_AREA,
  bottomNavItems,
  navState,
  overflowNavItems,
} from "@/lib/tokens";

/**
 * The phone's bottom bar: four destinations, and a fifth cell holding the rest.
 *
 * 🔴 **One of two renderers of `NAV_GROUPS`, and it names no destination of
 * its own.** `components/sidebar.tsx` is the other. Which four are on the bar
 * is `NavItem.bottomSlot`; the six behind the overflow trigger are *everything
 * without one*, by subtraction — `overflowNavItems()`. Neither set is typed
 * out here, which is the point: a hand-written six is a list that quietly
 * loses an entry the first time an eleventh destination is added, and a
 * destination on neither renderer is a page reachable only by typing its URL.
 *
 * A server component, and `<details>` rather than state, so the sheet opens
 * with JavaScript off and needs no client boundary. `locale` and `pathname`
 * arrive as props the server resolved — a nav that reads either after
 * hydration serves the default language in the HTML to everybody.
 *
 * Above `md` the whole thing is `display: none` and `SHELL.rail` draws
 * instead, so exactly one of the two is ever on screen.
 */
export function MobileNav({ locale, pathname }: { locale: Locale; pathname: string }) {
  return (
    <>
      {/* The inline style is the safe-area inset; see SAFE_AREA.fixedBottom.
          A bar with `position: fixed` sits outside the padding box that
          app/globals.css puts the inset on, so without this it renders under
          the home indicator on an installed console. */}
      <nav
        className={BOTTOM_NAV.bar}
        style={SAFE_AREA.fixedBottom}
        aria-label={t("nav.label", locale)}
      >
        <div className={BOTTOM_NAV.row}>
          {bottomNavItems().map((item) => {
            const state = navState(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={state === "page" ? "page" : undefined}
                className={cn(BOTTOM_NAV.cell, state ? BOTTOM_NAV.cellCurrent : undefined)}
              >
                <NavIcon d={item.icon} />
                {t(item.shortKey, locale)}
              </Link>
            );
          })}

          <details className={BOTTOM_NAV.more}>
            {/* `aria-haspopup` says this opens something rather than going
                somewhere. It is also the attribute the reference console's
                press guard keys on — and the reason this trigger carries its
                own recipe instead of BUTTON.base: a control that opens a sheet
                should stay still while the sheet moves. */}
            <summary className={BOTTOM_NAV.moreTrigger} aria-haspopup="menu">
              <NavIcon d={NAV_MORE.icon} />
              {t(NAV_MORE.shortKey, locale)}
            </summary>

            <div className={BOTTOM_NAV.sheet}>
              <span className={BOTTOM_NAV.sheetLabel}>{t(NAV_MORE.key, locale)}</span>
              {overflowNavItems().map((item) => {
                const state = navState(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={state === "page" ? "page" : undefined}
                    className={cn(
                      BOTTOM_NAV.sheetLink,
                      state ? BOTTOM_NAV.sheetLinkCurrent : undefined,
                    )}
                  >
                    <NavIcon d={item.icon} />
                    {t(item.shortKey, locale)}
                  </Link>
                );
              })}
            </div>
          </details>
        </div>
      </nav>

      {/* The gutter the bar would otherwise cover. It is drawn here, after the
          source footer, because that footer is the last thing on the page and
          the one thing on it addressed to people who are not signed in — see
          BOTTOM_NAV.spacer for why padding on the shell root cannot reach it.
          Same height as the bar, by carrying the same border, the same touch
          minimum and the same inset. */}
      <div className={BOTTOM_NAV.spacer} style={SAFE_AREA.fixedBottom} aria-hidden="true" />
    </>
  );
}
