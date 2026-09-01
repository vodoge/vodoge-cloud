import * as React from "react"

import { cn } from "@/lib/cn"
import { CARD, STAT, type StatTone } from "@/lib/tokens"

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-xl border bg-card text-card-foreground shadow",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1 p-4", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("font-semibold leading-none tracking-tight", className)}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-4 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-4 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

type DivProps = React.HTMLAttributes<HTMLDivElement>

/* ── 这个产品自己的组合件 ────────────────────────────────────────────
 *
 * 上面六个是 shadcn 的原语，下面几个是用它们拼出来的。shadcn 不提供
 * `CardPanel` 或 `CardEmpty` 这种东西，也不该提供——把原语组合成应用自己的
 * 部件正是它的用法，不是「又开始手写设计系统」。
 *
 * `CardNote` 是旧名字，现在是 shadcn `CardDescription` 的别名：五处调用不必
 * 因为换库而改，而两个名字指同一个东西不值得留成两份实现。
 */

/** 旧名字，指向 shadcn 的 CardDescription。 */
const CardNote = CardDescription

export function CardActions({ className, ...props }: DivProps) {
  return <div className={cn(CARD.actions, className)} {...props} />;
}

/**
 * The old card's prop shape, drawn with the new parts.
 *
 * ## Why this exists, when the parts above are the better API
 *
 * `components/ui.tsx` used to export a `Card` taking `title`, `note`,
 * `actions` and `bodyless`, and **ten pages imported it** — every page in the
 * seven migration cards that ran in parallel. The composed `Card` here is a
 * different API, so each of those seven would have had to decide for itself
 * how to turn `<Card title=… note=… actions=… bodyless>` into header parts.
 * Seven cards each translating the same four props is seven answers, and the
 * four that disagree are found afterwards by eye.
 *
 * So the translation was written once, here, and migrating a page was a change
 * of import rather than a rewrite of every card on it:
 *
 * ```tsx
 * import { CardPanel as Card } from "@/components/ui/card";
 * ```
 *
 * All ten pages have since moved across, and `components/ui.tsx` was deleted
 * once the last of them had. This is now the only place a card is built from
 * that prop shape, rather than the translation sitting behind another one.
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

export {
  Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, CardNote,
}
