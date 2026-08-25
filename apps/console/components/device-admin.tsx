"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ButtonRow } from "@/components/ui/button-row";
import { Button } from "@/components/ui/button";
import { Field, FormError, FormHint, InlineForm, Input } from "@/components/ui/form";
import { PAGE } from "@/lib/tokens";

type Labels = Record<string, string>;

/**
 * Renaming and removing a device.
 *
 * Only the name is editable. Everything else about a device is reported by the
 * device, and letting someone edit those fields invites writing down what they
 * wish were true.
 */
export function DeviceAdmin({
  deviceId,
  name,
  labels,
}: {
  deviceId: string;
  name: string;
  labels: Labels;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch(`/v1/devices/${deviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: draft }),
    });
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || labels.failed);
      return;
    }
    router.refresh();
  }

  async function remove() {
    // Typing the name is the confirmation. A device's journal is the record of
    // everything it ever reported and none of it comes back, so a dialog
    // someone can dismiss by reflex is not enough friction.
    const typed = window.prompt(labels.confirmDelete.replace("{name}", name));
    if (typed !== name) return;
    setBusy(true);
    const response = await fetch(`/v1/devices/${deviceId}`, { method: "DELETE" });
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || labels.failed);
      return;
    }
    router.push("/devices");
    router.refresh();
  }

  return (
    <div className={PAGE.stack}>
      <InlineForm onSubmit={rename}>
        <Field inline label={labels.name}>
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={128}
            required
          />
        </Field>
        <Button type="submit" disabled={busy || draft === name || draft.trim() === ""}>
          {labels.rename}
        </Button>
      </InlineForm>

      {error ? <FormError>{error}</FormError> : null}

      {/*
        `variant="risk"` rather than `className="risk"`, and the difference is
        not a rename. `.risk` is declared only as `.button-row button.risk` and
        `.row-actions button.risk`, so it drew here — inside a `.button-row` —
        and does not draw in the four places this console puts one somewhere
        else. The variant needs no ancestor, so the same control looks the same
        wherever it is moved to.

        The confirmation is unchanged and deliberately so: typing the device's
        name is the strongest guard in this console, and a device's journal is
        every reading it ever reported. A dialog dismissed by reflex is not the
        same thing.
      */}
      <ButtonRow>
        <Button variant="risk" disabled={busy} onClick={remove}>
          {labels.delete}
        </Button>
      </ButtonRow>
      <FormHint>{labels.deleteNote}</FormHint>
    </div>
  );
}
