import { cn } from "@/lib/cn";
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
  return <input type="checkbox" className={cn(FORM.checkbox, className)} {...props} />;
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FORM.input, className)} {...props} />;
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
      className={cn(FORM.select, compact ? FORM.selectCompact : undefined, className)}
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
