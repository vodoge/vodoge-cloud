import * as React from "react"

import { cn } from "@/lib/cn"
import { TABLE, tableCellClass } from "@/lib/tokens"

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & { wrapperClassName?: string }
>(({ className, wrapperClassName, ...props }, ref) => (
  // `wrapperClassName` 是这个项目加的：包裹层负责横向滚动，而有几张表需要
  // 给它设最大高度做纵向滚动。shadcn 的版本把这层写死，调用方够不着。
  <div className={cn("relative w-full overflow-auto", wrapperClassName)}>
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
      head && TABLE.headRow,
      className
    )}
    {...props}
  />
))
TableRow.displayName = "TableRow"

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & { secondary?: boolean }
>(({ className, secondary, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-8 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      secondary && TABLE.cellSecondary,
      className
    )}
    {...props}
  />
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
      tableCellClass({ mono, faint }),
      secondary && TABLE.cellSecondary,
      wrap && TABLE.cellWrap,
      nowrap && TABLE.cellNowrap,
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
