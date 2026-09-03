import { cn } from "@/lib/cn";
import { Input as ShadcnInput } from "@/components/ui/input";

/**
 * Form parts.
 *
 * These exist because the legacy stylesheet styles bare `form`, `label`,
 * `input` and `select` elements, and preflight is off. A migrated page that
 * renders a bare one of them looks correct today for the wrong reason and goes
 * naked the day `@layer legacy` is deleted — preflight puts none of it back, it
 * strips the border instead. `tokens.test.ts` fails a migrated file that
 * renders one of those elements without a class, so these are not a
 * convenience; they are the only way to render a form in a migrated page.
 *
 * ⚠️ **The note that stood here about `<textarea>` had gone stale twice over,
 * and it is corrected rather than carried.** It said this console contains
 * zero of them and that there is deliberately no `Textarea`. Both are now
 * false: the "one per line" list field at `settings-form.tsx:367` did become a
 * real `<textarea>` — it used to carry "one per line" as the placeholder of a
 * *single-line* box, so the one thing it told the operator to do was the one
 * thing it would not let them do — and `components/ui/textarea.tsx` exists
 * from the shadcn install. That component has no callers; the one textarea
 * writes its classes at its own call site. Wiring the two together is a
 * separate decision from this one.
 *
 * ⚠️ This used to add that the recipe `FORM.textarea` had to keep existing in
 * `lib/tokens.ts` because `tokens.test.ts` asserted a recipe for every form
 * element the console renders. **Both are gone**: the recipe and the guard that
 * read it were deleted together, because a guard reading a deleted object stops
 * measuring anything and stays green. What replaced it reads these `.tsx`
 * sources directly.
 *
 * The class strings used to live in `lib/tokens.ts` and are written out below
 * now. What guarded them survives the move: every `.tsx` under `app/` and
 * `components/` is on `MIGRATED_SOURCES`, so `lib/tokens.test.ts` reads this
 * source and puts every class in it to the real Tailwind build. (The pointer
 * that stood here at `button.tsx` is dropped: that file inlined its own
 * strings into `cva` when it moved to shadcn, so there is no note there to
 * see.)
 */

export function Form({ className, ...props }: React.FormHTMLAttributes<HTMLFormElement>) {
  return <form className={cn("flex flex-col gap-3", className)} {...props} />;
}

/**
 * A field and its own submit on one line, wrapping to two when there is no
 * room. Sixteen of these in the console, five in `device-console.tsx` alone.
 */
export function InlineForm({ className, ...props }: React.FormHTMLAttributes<HTMLFormElement>) {
  return <form className={cn("flex flex-wrap items-end gap-3", className)} {...props} />;
}

/**
 * A label above its control.
 *
 * A `<label>` wrapping its input rather than an `htmlFor`, which is what the
 * pages being migrated already do and what keeps the association correct
 * without inventing an id for every field on a mapped row.
 */
export function Field({
  label,
  inline,
  className,
  children,
  ...props
}: Omit<React.LabelHTMLAttributes<HTMLLabelElement>, "children"> & {
  label: React.ReactNode;
  children: React.ReactNode;
  /** `true` inside an `InlineForm`: the whole row on a phone, the rest of it above `sm`. */
  inline?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex flex-col gap-1 text-sm font-medium text-muted-foreground",
        inline ? "w-full sm:w-auto sm:flex-1" : undefined,
        className,
      )}
      {...props}
    >
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * A checkbox and its label on one line.
 *
 * 🔴 The checkbox carries its own size for a reason that is easy to miss: the
 * legacy stylesheet gives every `input` `width: 100%`, and the only thing
 * stopping this console's two checkboxes filling their container is
 * `.field-inline input` (`globals.css:920`) — which is in the layer that gets
 * deleted. One of the two lives in a table cell.
 */
export function InlineField({
  label,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: React.ReactNode }) {
  return (
    <label className={cn("flex items-center gap-2 text-sm font-medium text-foreground", className)}>
      <Checkbox {...props} />
      <span>{label}</span>
    </label>
  );
}

export function Checkbox({
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  // 保持原生 input[type=checkbox]。shadcn 的 Checkbox 是 Radix 的按钮，不是
  // 真正的 input——它不会随 form 提交，而这两处调用都在受控表单里。
  return <input
      type="checkbox"
      className={cn("size-4 min-h-4 shrink-0 cursor-pointer accent-primary disabled:opacity-50", className)}
      {...props}
    />;
}

/**
 * 输入框，委托给 shadcn 的。
 *
 * 保留这个名字而不是让 33 处调用改 import：两者 props 完全一致，改名只会
 * 制造一次没有收益的大规模改动。
 */
export function Input(props: React.ComponentPropsWithRef<typeof ShadcnInput>) {
  return <ShadcnInput {...props} />;
}

/**
 * The same box as `Input`, minus the placeholder a `select` cannot have.
 *
 * `compact` is the one in a table cell — `card-policies.tsx:100` sets a card's
 * routing from inside the row it belongs to — where a full-height full-width
 * control would push a five-column table wider than the phone it is read on.
 */
export function Select({
  compact,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }) {
  return (
    <select
      className={cn(
        // shadcn 输入框的外观，逐字取自 components/ui/input.tsx，让原生
        // select 和它旁边的 input 看起来是一套。
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        compact ? "min-h-8 w-auto px-2 text-xs" : undefined,
        className,
      )}
      {...props}
    />
  );
}

/**
 * A load or save failure, in the place the control that failed is.
 *
 * 🔴 `role="alert"` is not decoration. This element appears *after* the action
 * that failed, so a reader who is not looking at this exact spot — a screen
 * reader user, or anyone whose attention is still on the button they pressed —
 * gets no notification at all without it. The failure would be on screen and
 * unannounced, which is the same shape as the failure being invisible.
 *
 * It is on the component rather than at each of the call sites so that a new
 * one cannot be added without it. Overridable via `role` for the rare case
 * where the message is rendered before the action rather than in response to
 * it — nothing does that today.
 */
export function FormError({ className, role, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p role={role ?? "alert"} className={cn("m-0 text-sm text-destructive", className)} {...props} />
  );
}

/** Not a failure: a note about what a control will do. */
export function FormHint({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("m-0 text-sm text-muted-foreground", className)} {...props} />;
}
