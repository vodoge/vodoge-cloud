import { cn } from "@/lib/cn";
import { BUTTON_ROW } from "@/lib/tokens";

/**
 * A row of buttons that wraps rather than stretching its column.
 *
 * Twenty of these across six components, and the page survey named the
 * arrangement as the main source of horizontal overflow on a phone — the
 * device detail page renders three at once. There was no recipe for it, so each
 * of the seven page migrations would have arrived at its own gap and its own
 * wrap behaviour.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function ButtonRow({ className, ...props }: DivProps) {
  return <div className={cn(BUTTON_ROW.root, className)} {...props} />;
}

/**
 * The same arrangement inside a table cell.
 *
 * A separate name because the buttons in one are `size="sm"` — seven of this
 * console's twenty-six tables carry a row of actions, and the heaviest is four
 * buttons wide (`proxy-manager.tsx:375-401`, start/stop/restart/remove on a
 * proxy instance). At `md` those four alone are wider than a phone.
 */
export function RowActions({ className, ...props }: DivProps) {
  return <div className={cn(BUTTON_ROW.rowActions, className)} {...props} />;
}
