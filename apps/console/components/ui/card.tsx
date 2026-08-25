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
 * The old card's prop shape, drawn with the new parts.
 *
 * ## Why this exists, when the parts above are the better API
 *
 * `components/ui.tsx` exports a `Card` that takes `title`, `note`, `actions`
 * and `bodyless`, and **ten pages import it** — every page in the seven
 * remaining migration cards. The composed `Card` here is a different API, so
 * each of those seven cards would have had to decide for itself how to turn
 * `<Card title=… note=… actions=… bodyless>` into header parts. Seven cards
 * running in parallel, each translating the same four props, is seven answers,
 * and the four that disagree are found afterwards by eye.
 *
 * So the translation is written once, here, and a page migrating a card is a
 * change of import rather than a rewrite of every card on the page:
 *
 * ```tsx
 * import { CardPanel as Card } from "@/components/ui/card";
 * ```
 *
 * The composed parts stay the primary API — a card whose content is a
 * full-bleed table is `<Card>` with a `<Table>` in it, not a boolean — and a
 * page is free to use them where it wants a header this shape cannot express.
 * `CardPanel` is for the other ninety per cent, where the header is a title, a
 * qualifier and maybe two buttons.
 */
export function CardPanel({
  title,
  note,
  actions,
  bodyless,
  className,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
  title?: React.ReactNode;
  /** A qualifier on the title — a count, a timestamp — not a second title. */
  note?: React.ReactNode;
  actions?: React.ReactNode;
  /** Skip the padded body, for a card whose content is a full-bleed table. */
  bodyless?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={className} {...props}>
      {title ? (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {note ? <CardNote>{note}</CardNote> : null}
          {actions ? <CardActions>{actions}</CardActions> : null}
        </CardHeader>
      ) : null}
      {bodyless ? children : <CardContent>{children}</CardContent>}
    </Card>
  );
}

/**
 * A card that folds.
 *
 * `<details>` rather than a `useState`, so it works with JavaScript off, needs
 * no client boundary, and keeps a server-rendered page a server component.
 * The stylesheet styles neither `details` nor `summary`, so there is nothing
 * here for the legacy layer to fight over.
 *
 * `hint` is the caller's own affordance in place of the disclosure triangle,
 * which `list-none` removes: "3 configured" reads better than a marker, and a
 * marker that cannot be styled consistently across browsers is worse than a
 * word.
 */
export function CardDisclosure({
  title,
  hint,
  className,
  children,
  ...props
}: Omit<React.DetailsHTMLAttributes<HTMLDetailsElement>, "title"> & {
  title: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details className={cn(CARD.root, className)} {...props}>
      <summary className={CARD.disclosureSummary}>
        <span className={CARD.title}>{title}</span>
        {hint ? <span className={CARD.disclosureMarker}>{hint}</span> : null}
      </summary>
      <CardContent>{children}</CardContent>
    </details>
  );
}

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
