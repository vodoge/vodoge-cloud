import { cn } from "@/lib/cn";
import { Input as ShadcnInput } from "@/components/ui/input";
import { FORM } from "@/lib/tokens";

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
 * There is deliberately no `Textarea`. This console contains zero `<textarea>`
 * elements: the SMS body is an `<input>` (`send-sms.tsx:51`), and the one place
 * that carries multi-line meaning — the "one per line" list field in
 * `settings-form.tsx:170` — is a single-line input whose change would be a
 * change of behaviour, which the settings card forbids. `FORM.textarea` stays
 * as a recipe because the guard requires one for every element the legacy layer
 * styles bare; a component for it would be a control with no caller.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */

export function Form({ className, ...props }: React.FormHTMLAttributes<HTMLFormElement>) {
  return <form className={cn(FORM.root, className)} {...props} />;
}

/**
 * A field and its own submit on one line, wrapping to two when there is no
 * room. Sixteen of these in the console, five in `device-console.tsx` alone.
 */
export function InlineForm({ className, ...props }: React.FormHTMLAttributes<HTMLFormElement>) {
  return <form className={cn(FORM.inline, className)} {...props} />;
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
    <label className={cn(FORM.label, inline ? FORM.inlineField : undefined, className)} {...props}>
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
    <label className={cn(FORM.inlineLabel, className)}>
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
  return <input type="checkbox" className={cn(FORM.checkbox, className)} {...props} />;
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
        compact ? FORM.selectCompact : undefined,
        className,
      )}
      {...props}
    />
  );
}

/** A load or save failure, in the place the control that failed is. */
export function FormError({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn(FORM.error, className)} {...props} />;
}

/** Not a failure: a note about what a control will do. */
export function FormHint({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn(FORM.hint, className)} {...props} />;
}
