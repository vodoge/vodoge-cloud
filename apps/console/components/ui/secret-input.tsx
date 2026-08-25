import { Input } from "@/components/ui/form";
import { secretInputProps } from "@/lib/tokens";

/**
 * A password box that knows the gateway may already be holding the password.
 *
 * The semantics are not new — `settings-form.tsx:161-172` has them, with the
 * comment "a secret that is already stored shows an empty box with the
 * placeholder as its hint: typing replaces it, leaving it keeps it". What is
 * new is that they are in one place. Four more password fields are about to be
 * migrated across three different cards, and if each of them decides for itself
 * what an already-stored secret looks like, one of them will echo the redaction
 * marker into the input's `value` — where it gets submitted, and saved, as the
 * new password, the first time somebody saves the form without touching that
 * field.
 *
 * ⚠️ **No count lives here, and none may.** The "seven notification channels"
 * this console is described by cannot be found in any `.tsx`: the fields come
 * from the gateway at runtime as a `Field[]` (`settings-form.tsx:64`), and
 * `kind === "secret"` is the server's answer, not ours. This component is told
 * about one value and answers about that one value.
 *
 * The decision of what to send back when the box is left empty stays with the
 * form — an untouched secret is omitted from the PUT, which is what tells the
 * gateway to keep the stored one — because that is a request shape, not a
 * control.
 */
export function SecretInput({
  value,
  ...props
}: Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "placeholder" | "autoComplete" | "spellCheck"
> & {
  /** Whatever the form is holding, including the gateway's redaction marker. */
  value: unknown;
}) {
  const { stored, ...attributes } = secretInputProps(value);
  return <Input {...attributes} {...props} />;
}
