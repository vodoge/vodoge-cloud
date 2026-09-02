import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { t, type Locale } from "@/lib/i18n";
import { NAV_GROUPS, navState } from "@/lib/tokens";

/**
 * The navigation rail, drawn with shadcn's `Sidebar`.
 *
 * 🔴 **One of ONE renderers of `NAV_GROUPS` now.** There used to be two —
 * this and `components/mobile-nav.tsx` — because the phone needed a different
 * arrangement of the same ten destinations, and a pair of tests existed to
 * stop them drifting into two lists. shadcn's `Sidebar` collapses that: above
 * `md` it is this rail, below it the same markup is drawn inside a `Sheet` by
 * the library. One renderer cannot disagree with itself, so the guard that
 * held the two in step retired with the second renderer.
 *
 * ⚠️ **What was given up, so that reversing this is a decision and not a
 * discovery.** The phone used to navigate from a bar pinned to the bottom of
 * the screen: five cells at 78px, thumb-reachable, with the other five behind
 * an overflow sheet. It is now a trigger in the header and a drawer. The bar
 * was measured (390px, a 44px touch target, `bottomNavCellWidth()` computing
 * both budgets) and it was not replaced because it was wrong — it was replaced
 * because it was hand-written, and a bar plus its gutter held 90px of an 844px
 * screen permanently, which is 10.7% of the phone given to navigation rather
 * than to data.
 *
 * 🔴 **Still a server component, and that is load-bearing.** `Sidebar` itself
 * is `"use client"`, but everything below is passed to it as children, so
 * `t(item.key, locale)` runs on the server and the served HTML carries the
 * operator's language. A nav that resolves its own locale after hydration
 * serves every reader the default language in the HTML, and the check that
 * reads this page runs no JavaScript at all — this console has shipped that
 * defect twice.
 *
 * The nav data stays in `lib/tokens.ts` rather than being written as markup
 * here: a `.tsx` cannot be read by a test in this app, so a nav written as
 * markup is a nav nothing can check.
 */
export function AppSidebar({
  locale,
  pathname,
  appName,
}: {
  locale: Locale;
  pathname: string;
  appName: string;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5 text-base font-semibold tracking-tight">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded bg-primary text-xs font-bold text-primary-foreground"
            aria-hidden="true"
          >
            V
          </span>
          <span className="truncate group-data-[collapsible=icon]:hidden">{appName}</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label ?? group.items[0].href}>
            {group.label ? <SidebarGroupLabel>{t(group.label, locale)}</SidebarGroupLabel> : null}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const state = navState(pathname, item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={state !== null}
                        tooltip={t(item.key, locale)}
                      >
                        {/* Only an exact match is the current page. A device
                            detail page is inside the devices section, not the
                            devices page. */}
                        <Link href={item.href} aria-current={state === "page" ? "page" : undefined}>
                          <NavIcon d={item.icon} />
                          <span>{t(item.key, locale)}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}

/**
 * One navigation glyph, drawn from the path data on the nav entry.
 *
 * It carries no size of its own any more: `SidebarMenuButton` sizes the icon
 * it is given (`[&>svg]:size-4`), which is the library deciding a thing this
 * file used to decide.
 *
 * `aria-hidden` because the word beside it already says where the link goes.
 * An accessible name here would make every entry announce itself twice.
 */
export function NavIcon({ d }: { d: string }) {
  return (
    <svg
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
