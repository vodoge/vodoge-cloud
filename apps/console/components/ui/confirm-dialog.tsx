"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ButtonRow } from "@/components/ui/button-row";
import { cn } from "@/lib/cn";
import { CONFIRM, assertConsequence } from "@/lib/tokens";

/**
 * A confirmation that has somewhere to put the consequence.
 *
 * ## Why this replaces `window.confirm`
 *
 * Every confirmation in this console is `window.confirm(oneString)`, and one
 * string is why `device.confirmDisruptive` — "This takes the module off the
 * network. Continue?" — is shared by seven different commands and names none
 * of them. One of those seven is `restart_modem`, which can leave a module in
 * `+CFUN: 7`, and the operator cannot walk over and unplug it. The two
 * confirmations in this console that *do* state a consequence
 * (`device.confirmUsbnet`, `esim.dlWarn`) had to smuggle it into the question,
 * and both are long paragraphs inside a native dialog as a result.
 *
 * ## Why `consequence` is required, and checked
 *
 * A prop that may be omitted is a prop that gets omitted, and the seven
 * confirmations that have to be written next are being written by a different
 * card than this one. So:
 *
 * - the type has no `?`, which is the compiler refusing an omission;
 * - `assertConsequence` throws on the ones a type cannot catch — empty, a
 *   question with nothing behind it, a fragment too short to name what is
 *   about to happen;
 * - `tokens.test.ts` runs the same rule over every consequence key in the
 *   message catalogues, in both languages, so a consequence written in Chinese
 *   and skipped in English fails the build rather than the operator.
 *
 * Throwing while rendering is deliberate and is the right way round here. A
 * dialog that crashes gets fixed in the first minute; a dialog that asks
 * "Continue?" over a command that strands hardware gets clicked for a year.
 *
 * The dialog asks the question itself, from the shared catalogue — which is
 * also what lets the check reject a consequence that turns out to be another
 * question.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */

export type ConfirmLabels = {
  /** `confirm.question` — "Continue?", asked the same way everywhere. */
  question: string;
  /** `confirm.proceed` */
  proceed: string;
  /** `confirm.cancel` */
  cancel: string;
};

export function ConfirmDialog({
  open,
  title,
  consequence,
  labels,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  className,
}: {
  open: boolean;
  /** What is about to happen, named: the command, the instance, the number. */
  title: string;
  /**
   * What it will do — required, and a statement rather than a question.
   *
   * Name the object, say what changes, and say whether it can be undone. The
   * two worked examples are `device.confirmUsbnet` and `esim.dlWarn`.
   */
  consequence: string;
  labels: ConfirmLabels;
  /** Overrides `labels.proceed` where the verb is worth repeating: "Send", "Delete". */
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus lands on the way out, not on the way through. A dialog that opens
  // with the destructive button focused turns a stray Return into the command.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  // Not in an effect and not behind a flag: the check has to run on the render
  // that shows the dialog, which is the only render where being wrong matters.
  const stated = assertConsequence(consequence);

  return (
    <div className={cn(CONFIRM.overlay, className)} role="dialog" aria-modal="true">
      <div className={CONFIRM.scrim} onClick={onCancel} aria-hidden="true" />
      <div className={CONFIRM.panel}>
        <h2 className={CONFIRM.title}>{title}</h2>
        <p className={CONFIRM.consequence}>{stated}</p>
        <p className={CONFIRM.question}>{labels.question}</p>
        <ButtonRow className={CONFIRM.actions}>
          <Button ref={cancelRef} variant="outline" onClick={onCancel} disabled={busy}>
            {labels.cancel}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {confirmLabel ?? labels.proceed}
          </Button>
        </ButtonRow>
      </div>
    </div>
  );
}
