import { cn } from "@/lib/cn";
import { BADGE, badgeClass, toneForState, type BadgeTone } from "@/lib/tokens";

/**
 * A status pill.
 *
 * The dot is a real element rather than a `::before`, because a pseudo-element
 * cannot be expressed in utilities without an arbitrary `content` value, and
 * because it means the tone reads as a shape as well as a colour — which is
 * what a monochrome screen and colour-blind vision get.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  /** Off for a label that is not a state — a category, a count. */
  dot?: boolean;
};

export function Badge({ tone, dot = true, className, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeClass(tone), className)} {...props}>
      {dot ? <span className={BADGE.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/**
 * A badge whose tone is derived from the state word itself.
 *
 * An unrecognised state comes out neutral rather than guessing. Green on a
 * fleet dashboard is read as "fine", so a wrong colour is worse than none.
 */
export function StateBadge({
  state,
  label,
  ...props
}: Omit<BadgeProps, "tone" | "children"> & { state: string; label?: string }) {
  return (
    <Badge tone={toneForState(state)} {...props}>
      {label ?? state}
    </Badge>
  );
}
