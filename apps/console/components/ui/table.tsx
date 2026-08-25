import { cn } from "@/lib/cn";
import { TABLE, tableCellClass } from "@/lib/tokens";

/**
 * A table that scrolls sideways inside its card rather than stretching the
 * page. On a phone a fleet table is always wider than the screen; the choice
 * is where the overflow goes, and a card that scrolls keeps the page's own
 * layout intact.
 *
 * The row, not the cell, carries the horizontal rule. With
 * `border-collapse: collapse` a row border renders, and "no rule under the
 * last row" is then a plain `last:` variant instead of something that has to
 * reach every cell of the last row.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */

export function Table({
  className,
  wrapperClassName,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement> & { wrapperClassName?: string }) {
  return (
    <div className={cn(TABLE.wrapper, wrapperClassName)}>
      <table className={cn(TABLE.table, className)} {...props} />
    </div>
  );
}

export function TableHead({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn(TABLE.head, className)} {...props} />;
}

export function TableBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn(TABLE.body, className)} {...props} />;
}

/** `head` drops the rule and the hover tint: a header row is not a data row. */
export function TableRow({
  head,
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { head?: boolean }) {
  return <tr className={cn(head ? TABLE.headRow : TABLE.row, className)} {...props} />;
}

export function TableHeaderCell({
  className,
  scope = "col",
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope={scope} className={cn(TABLE.headerCell, className)} {...props} />;
}

/**
 * `mono` for anything an operator will compare character by character — an
 * IMEI, an id, an address. `faint` for a value that is context rather than the
 * answer to the question the row is being read for.
 */
export function TableCell({
  mono,
  faint,
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { mono?: boolean; faint?: boolean }) {
  return <td className={cn(tableCellClass({ mono, faint }), className)} {...props} />;
}
