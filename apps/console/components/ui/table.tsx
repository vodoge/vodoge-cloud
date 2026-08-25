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
  secondary,
  className,
  scope = "col",
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { secondary?: boolean }) {
  return (
    <th
      scope={scope}
      className={cn(TABLE.headerCell, secondary ? TABLE.cellSecondary : undefined, className)}
      {...props}
    />
  );
}

/**
 * `mono` for anything an operator will compare character by character — an
 * IMEI, an id, an address. `faint` for a value that is context rather than the
 * answer to the question the row is being read for.
 */
export function TableCell({
  mono,
  faint,
  secondary,
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & {
  mono?: boolean;
  faint?: boolean;
  /** Drops off the phone. Put it on the header cell of the same column too. */
  secondary?: boolean;
}) {
  return (
    <td
      className={cn(
        tableCellClass({ mono, faint }),
        secondary ? TABLE.cellSecondary : undefined,
        className,
      )}
      {...props}
    />
  );
}

/**
 * The other table shape: a list of name/reading pairs.
 *
 * ## Why there have to be two
 *
 * Twenty-six tables were counted in the pages still to be migrated. **Five of
 * them have no `<th>` at all** — the device page's host details,
 * `app/settings`, and three in the eSIM panel — and **four are two columns of
 * a field and its value**. Any narrow-screen treatment that turns a row into a
 * labelled block using the header text does nothing on those five, and giving
 * a definition list the data grid's sticky header and uniform padding treats
 * it as a result set that happens to be two wide.
 *
 * So: `Table` is the data grid, which scrolls sideways inside its card and can
 * drop `secondary` columns on a phone. `SpecTable` is this — the term column
 * shrinks to its content and the detail column takes the rest, which needs no
 * width to be chosen and reads the same at 390px as at 1400px.
 *
 * It stays a real `<table>`. A `<dl>` would be the tidier element, but this
 * shape's whole advantage is that table layout sizes the term column from the
 * longest term for free, and every page that has one of these is rendering a
 * `<table>` today.
 */
export function SpecTable({
  className,
  wrapperClassName,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement> & { wrapperClassName?: string }) {
  return (
    <div className={cn(TABLE.wrapper, wrapperClassName)}>
      <table className={cn(TABLE.spec, className)} {...props} />
    </div>
  );
}

/** One pair. `mono` for a reading compared character by character. */
export function SpecRow({
  term,
  mono,
  className,
  children,
  ...props
}: Omit<React.HTMLAttributes<HTMLTableRowElement>, "children"> & {
  term: React.ReactNode;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <tr className={cn(TABLE.specRow, className)} {...props}>
      <th scope="row" className={TABLE.specTerm}>
        {term}
      </th>
      <td className={cn(TABLE.specDetail, mono ? TABLE.cellMono : undefined)}>{children}</td>
    </tr>
  );
}
