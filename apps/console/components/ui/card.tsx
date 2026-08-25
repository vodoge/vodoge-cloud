import { cn } from "@/lib/cn";
import { CARD, STAT, type StatTone } from "@/lib/tokens";

/**
 * A card, in parts.
 *
 * The old `Card` took `title`, `note`, `actions` and a `bodyless` flag, which
 * meant every new arrangement of a card header needed another prop. These
 * compose instead: a card whose content is a full-bleed table is `<Card>` with
 * a `<Table>` in it and no `<CardContent>`, rather than a boolean.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <section className={cn(CARD.root, className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <header className={cn(CARD.header, className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn(CARD.title, className)} {...props} />;
}

/** A qualifier on the title — a count, a timestamp — not a second title. */
export function CardNote({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(CARD.note, className)} {...props} />;
}

export function CardActions({ className, ...props }: DivProps) {
  return <div className={cn(CARD.actions, className)} {...props} />;
}

export function CardContent({ className, ...props }: DivProps) {
  return <div className={cn(CARD.content, className)} {...props} />;
}

/**
 * Says what would be here, not just that nothing is.
 *
 * "No rows" leaves the reader unsure whether the page is empty or broken,
 * which on a fleet console is the difference between "nothing happened" and
 * "we are not seeing what happened".
 */
/**
 * A row of stat cards. `flex`, never `grid` — see LEGACY_UTILITY_COLLISIONS.
 */
export function StatRow({ className, ...props }: DivProps) {
  return <div className={cn(STAT.row, className)} {...props} />;
}

/**
 * One number, with what it counts above it and its qualifier below.
 *
 * The label comes first because the number is meaningless without it, and the
 * hint last because it is the answer to "out of how many", which is only asked
 * after the number has been read.
 *
 * `tone` is only for a value that carries a judgement. An unfinished thought
 * about that: colouring a plain count spends attention that the one number
 * which does mean something then cannot get.
 */
export function StatCard({
  label,
  value,
  hint,
  tone,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  label: string;
  value: number | string;
  hint?: string;
  tone?: StatTone;
}) {
  return (
    <section className={cn(STAT.root, className)} {...props}>
      <span className={STAT.label}>{label}</span>
      <span className={cn(STAT.value, tone ? STAT.tone[tone] : undefined)}>{value}</span>
      {hint ? <span className={STAT.hint}>{hint}</span> : null}
    </section>
  );
}

export function CardEmpty({
  title,
  description,
  className,
  ...props
}: DivProps & { title: string; description?: string }) {
  return (
    <div className={cn(CARD.empty, className)} {...props}>
      <span className={CARD.emptyTitle}>{title}</span>
      {description ? <span className={CARD.emptyDescription}>{description}</span> : null}
    </div>
  );
}
