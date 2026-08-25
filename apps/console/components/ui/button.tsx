import { cn } from "@/lib/cn";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/lib/tokens";

/**
 * The button.
 *
 * No `"use client"`: a button with no handler is a server component, and the
 * pages that need an `onClick` are already client components. Marking it here
 * would pull every page that renders one across the boundary.
 *
 * The classes come from `lib/tokens.ts` rather than being written inline —
 * there is no way to run a `.tsx` in a test in this app, so a class string
 * that lives here cannot be checked, and one that lives in `lib/` can be.
 *
 * `type` defaults to `button`. The HTML default is `submit`, which turns any
 * button placed inside a form into an accidental submit.
 *
 * `ComponentPropsWithRef` rather than `ButtonHTMLAttributes`, so a caller can
 * take the ref: the confirmation dialog moves focus to its cancel button on
 * open, and a dialog that opens with the destructive button focused turns a
 * stray Return into the command. React 19 passes `ref` to a function component
 * as an ordinary prop, so no `forwardRef` is needed.
 */

export type ButtonProps = React.ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={cn(buttonClass({ variant, size }), className)} {...props} />
  );
}
