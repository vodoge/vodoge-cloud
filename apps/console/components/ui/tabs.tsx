import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Tabs.
 *
 * This component is here because two page cards need it and neither owns a
 * file it could live in: one is told to build a four-tab skeleton for the
 * device detail page and the other to fill two of those tabs. Without it they
 * would each have written one, in a file the other could not edit, and the
 * second would have had to redo the first — which is exactly the kind of
 * parallel zeroing this card exists to prevent.
 *
 * **Two kinds of tab, one recipe.** A tab that selects a *view of a page* is a
 * link: it keeps the page a server component, it keeps a tab deep-linkable and
 * bookmarkable, and it survives a reload — which matters on a device page an
 * operator returns to. A tab that switches a pane *inside* an already-client
 * component is a button, because there is no URL to change. `Tab` renders a
 * `<a>` when it is given an `href` and a `<button>` when it is not.
 *
 * `aria-current="page"` on the link and `aria-selected` on the button, rather
 * than one for both: they are different things to a screen reader, and saying
 * "page" for a pane that did not navigate is a lie told for a highlight — the
 * same distinction `navState` makes for the shell's navigation.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */

/**
 * The strip these tabs sit in.
 *
 * 🔴 **A `<nav>`, not a `role="tablist"`.** Every `Tab` in this console
 * navigates — the device page keeps its selection in `?tab=` so a reload
 * during a slow command does not lose the operator's place, which is the
 * reason this console kept link-style tabs instead of taking shadcn's Radix
 * `Tabs`. `role="tablist"` promises the opposite: a screen reader announces
 * "tab", then offers arrow-key traversal of panes inside the same document.
 * What it gets is a link that leaves the page. The roles said one thing and
 * the elements did another.
 *
 * `label` is required rather than optional because an unnamed `<nav>` is
 * announced as just "navigation", and this page has two of them once the
 * sidebar is counted.
 */
export function TabList({
  label,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { label: string }) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex flex-wrap items-center gap-x-4 border-0 border-b border-solid border-border",
        className,
      )}
      {...props}
    />
  );
}

export type TabProps = {
  /** Selected. The caller decides, from the URL or from its own state. */
  current?: boolean;
  className?: string;
  children: React.ReactNode;
  /** Present for a tab that navigates, absent for one that switches a pane. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  id?: string;
  "aria-controls"?: string;
};

export function Tab({ href, current, className, children, ...props }: TabProps) {
  const classes = cn(
    "inline-flex min-h-touch cursor-pointer items-center whitespace-nowrap rounded-none border-x-0 border-t-0 border-b-2 border-solid border-transparent bg-transparent px-1 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground",
    current ? "border-ring text-foreground" : undefined,
    className,
  );
  if (href !== undefined) {
    const { disabled, ...anchorProps } = props;
    return (
      // No `role="tab"`: this is a link, and `aria-current="page"` is how a
      // navigation says which one you are on.
      <Link href={href} aria-current={current ? "page" : undefined} className={classes} {...anchorProps}>
        {children}
      </Link>
    );
  }
  return (
    // ⚠️ The pane-switching variant, which has no caller today. If one
    // appears it needs a `role="tablist"` parent — `TabList` above is a
    // `<nav>` and will not supply one.
    <button type="button" role="tab" aria-selected={current ?? false} className={classes} {...props}>
      {children}
    </button>
  );
}

/** What the selected tab shows. Separate so the padding is not repeated. */
export function TabPanel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="tabpanel" className={cn("pt-4", className)} {...props} />;
}
