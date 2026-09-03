import * as React from "react"

import { cn } from "@/lib/cn"

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & { wrapperClassName?: string }
>(({ className, wrapperClassName, ...props }, ref) => (
  // `wrapperClassName` 是这个项目加的：包裹层负责横向滚动，而有几张表需要
  // 给它设最大高度做纵向滚动。shadcn 的版本把这层写死，调用方够不着。
  // 🔴 `tabIndex={0}` because this div scrolls. A region that scrolls and
  // cannot be focused is scrollable only with a pointer — a keyboard reaches
  // the rows before it and the rows after it, with the columns that overflowed
  // unreachable in between. WCAG 2.1.1, and on this console it bites hardest
  // exactly where the data is widest.
  <div className={cn("relative w-full overflow-auto", wrapperClassName)} tabIndex={0}>
    <table
      ref={ref}
      className={cn("w-full caption-bottom text-sm", className)}
      {...props}
    />
  </div>
))
Table.displayName = "Table"

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
))
TableBody.displayName = "TableBody"

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
      className
    )}
    {...props}
  />
))
TableFooter.displayName = "TableFooter"

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  // `head` 标出表头行。这个项目的表头行和数据行的边框、底色都不同，而
  // shadcn 只有一种行。
  React.HTMLAttributes<HTMLTableRowElement> & { head?: boolean }
>(({ className, head, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
      head && "border-b border-border",
      className
    )}
    {...props}
  />
))
TableRow.displayName = "TableRow"

/**
 * A column heading.
 *
 * 🔴 `label` names a column that shows no text — the eight `<TableHead />`
 * that head an actions or toggle column. Empty is right *visually*: a heading
 * over a row of buttons is noise. It is wrong to a screen reader, which reads
 * the column header when it reads a cell, and for these columns read nothing
 * at all — so a button in the last column announced itself with no indication
 * of which column it belonged to.
 *
 * The name goes here rather than as a bare `<span className="sr-only">` at
 * each site so the eight cannot drift into eight different spellings, and so
 * a ninth is a prop away rather than a pattern to remember.
 */
const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & { secondary?: boolean; label?: string }
>(({ className, secondary, label, children, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-8 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      secondary && "hidden sm:table-cell",
      className
    )}
    {...props}
  >
    {label !== undefined ? <span className="sr-only">{label}</span> : null}
    {children}
  </th>
))
TableHead.displayName = "TableHead"

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  /* 内容类型修饰，shadcn 没有这些。它们不是装饰：
   *   mono      标识符要等宽，IMEI 和 ICCID 是一位一位对着读的
   *   faint     次要信息压暗，不和主值抢
   *   secondary 手机上收起这一列
   *   wrap/nowrap  少数几列需要覆盖默认的换行行为 */
  React.TdHTMLAttributes<HTMLTableCellElement> & {
    mono?: boolean
    faint?: boolean
    secondary?: boolean
    wrap?: boolean
    nowrap?: boolean
  }
>(({ className, mono, faint, secondary, wrap, nowrap, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "px-2 py-1.5 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      // 🔴 原本是 `tableCellClass({ mono, faint })`，读 lib/tokens.ts 的 TABLE.cell
      // 那一组。那三个值里 `px-s4 py-s3` 从来没有真的生效过——这个 <td> 自己在上一
      // 行就写了 `px-2 py-1.5`，tailwind-merge 让后写的赢。所以只有 mono 和 faint
      // 两个修饰是活的，内联的就是它们。
      mono && "font-mono text-xs tabular-nums",
      faint && "text-muted-foreground",
      secondary && "hidden sm:table-cell",
      wrap && "break-all",
      nowrap && "whitespace-nowrap",
      className
    )}
    {...props}
  />
))
TableCell.displayName = "TableCell"

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-sm text-muted-foreground", className)}
    {...props}
  />
))
TableCaption.displayName = "TableCaption"

/* ── 这个产品自己的组合件 ────────────────────────────────────────────
 *
 * `SpecTable` / `SpecRow` 是「名称—值」两列的规格表，shadcn 没有对应物。
 */

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
    <div className={cn("w-full overflow-x-auto", wrapperClassName)}>
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
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
    <tr className={cn("border-b border-border last:border-0", className)} {...props}>
      <th scope="row" className="whitespace-nowrap px-4 py-2 text-left align-top font-mono text-xs font-medium uppercase tracking-eyebrow text-muted-foreground">
        {term}
      </th>
      <td className={cn("w-full px-4 py-2 align-top text-sm text-foreground", mono ? "font-mono text-xs tabular-nums" : undefined)}>{children}</td>
    </tr>
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
