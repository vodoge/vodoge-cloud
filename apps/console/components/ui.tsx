import {
  CardEmpty,
  CardPanel,
  StatCard as UiStatCard,
} from "@/components/ui/card";
import { StateBadge as UiStateBadge } from "@/components/ui/badge";

/**
 * The old layout barrel, now a compatibility layer over `components/ui/*`.
 *
 * ## What this file was, and why it was the most dangerous file on the board
 *
 * It held four hand-written components — a prop-shaped `Card`, `StatCard`,
 * `EmptyState` and `StateBadge` — drawn with classes from the legacy
 * stylesheet. **Ten pages import from it, and all ten belong to the seven page
 * migrations that are meant to run in parallel**, while the file itself was on
 * exactly one of those cards' file lists. The other six would have found their
 * pages importing a card they were not allowed to change, whose API is not the
 * API of the `Card` they were told to migrate to.
 *
 * Six cards each inventing a translation of the same four props, in parallel,
 * is six answers. The translation is written once instead — `CardPanel` in
 * `components/ui/card.tsx` — and this file hands it out under the old names.
 *
 * ## What a caller sees
 *
 * Nothing. Every prop signature below is the one it had, so the ten importing
 * pages compile and render without a line changing, and `tsc` is what proves
 * it rather than a reviewer reading ten files. What they get is the design
 * system's card instead of the stylesheet's — which is the point, since the
 * goal is measured by no page depending on the old stylesheet.
 *
 * ## The one implementation rule
 *
 * `EmptyState` is a wrapper over `CardEmpty` rather than a second empty state,
 * and `StatCard` and `StateBadge` are re-exports rather than copies. There is
 * one of each in this console. Opening a third file for an empty state — which
 * was the plan until the review — would have turned "two implementations that
 * disagree" into three.
 */

/**
 * The prop-shaped card, unchanged for its callers.
 *
 * `className` still passes through, which is what keeps `card-span-all`
 * working on the six pages that use it: that class is grid placement from the
 * old stylesheet, and it belongs to the page's layout rather than to the card.
 * It stops being needed when the page around it is migrated.
 */
export function Card({
  title,
  note,
  actions,
  className,
  bodyless,
  children,
}: {
  title?: string;
  note?: string;
  actions?: React.ReactNode;
  className?: string;
  /** Skip the padded body, for a card whose content is a full-bleed table. */
  bodyless?: boolean;
  children: React.ReactNode;
}) {
  return (
    <CardPanel title={title} note={note} actions={actions} bodyless={bodyless} className={className}>
      {children}
    </CardPanel>
  );
}

/**
 * One number per card.
 *
 * A re-export: the new one takes the same four props and adds `className`.
 * Nothing imports this today — `app/page.tsx` already reaches for the one in
 * `components/ui/card.tsx` — but it is kept so that this barrel's surface is
 * the surface it has always had, and removing it stays a decision somebody
 * makes on purpose.
 */
export const StatCard = UiStatCard;

/**
 * Says what would be here, not just that nothing is.
 *
 * "No rows" leaves the reader unsure whether the page is empty or broken,
 * which on a fleet console is the difference between "nothing happened" and
 * "we are not seeing what happened". The prop is `desc` here and `description`
 * on `CardEmpty`; renaming it is the whole of this wrapper, and doing it here
 * is what keeps eight pages from each doing it themselves.
 */
export function EmptyState({ title, desc }: { title: string; desc?: string }) {
  return <CardEmpty title={title} description={desc} />;
}

/**
 * Status pill. Unknown states fall back to neutral rather than guessing.
 *
 * A re-export. The tone table moved to `toneForState` in `lib/tokens.ts`,
 * where a test can read it — the copy that used to live here mapped the same
 * seven states to legacy class names, and two tables of the same seven states
 * is how `warn` ends up two different colours.
 */
export const StateBadge = UiStateBadge;
