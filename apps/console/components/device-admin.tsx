"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ButtonRow } from "@/components/ui/button-row";
import { Button } from "@/components/ui/button";
import { Field, FormError, FormHint, InlineForm, Input } from "@/components/ui/form";
import { SpecRow, SpecTable, TableBody } from "@/components/ui/table";
import { mayWrite, roleFromSessionBody, SESSION_ENDPOINT } from "@/lib/session";

type Labels = Record<string, string>;

/**
 * Renaming and removing a device.
 *
 * Only the name is editable. Everything else about a device is reported by the
 * device, and letting someone edit those fields invites writing down what they
 * wish were true.
 *
 * ## The read-only gate, which this component did not have
 *
 * Both of its writes — `PATCH /v1/devices/:id` and `DELETE /v1/devices/:id` —
 * were drawn for every account, so `viewer@vodoge.com` was offered a rename box
 * and a button labelled "Remove device" on a card whose own note says the
 * journal does not come back.
 *
 * ⚠️ **Nothing was ever removed by an account that may not remove things.** The
 * gateway refuses every state-changing request from a read-only session at one
 * chokepoint around its whole route table, so both of those were answered 403.
 * This is not a hole being closed; it is an offer being withdrawn, which is
 * courtesy rather than a permission model — the model is the gateway's, and
 * `/v1` is reachable with curl and a token whatever this component draws.
 *
 * ## Why it asks for itself rather than being told
 *
 * `/settings`, `/inbox` and `/devices` each resolve the role on the server and
 * hand a required `writable` prop down, and that is the better shape: a prop
 * exists before the first render, so there is no paint in which the controls
 * are present. This component cannot have it today. Its only caller is
 * `app/devices/[deviceId]/page.tsx`, which is being rewritten wholesale on
 * another branch — the card that holds this component has already moved into a
 * different card shell there — and adding an argument to a call site that has
 * moved is how a guard gets dropped in a merge. That is not hypothetical here:
 * the assertions holding the inbox's gate were lost in exactly that way and
 * nothing went red. See `notes/T034-devices-role-gating.md`.
 *
 * So it uses the *other* shape this page already has. `device-console.tsx`,
 * rendered a few hundred pixels above this, asks `GET /v1/auth/session` from an
 * effect and starts closed; copying it means one pattern on one page rather
 * than two, and `tokens.test.ts` pins the two copies to the same three states
 * so they cannot drift apart. Being handed a server-resolved `writable` is
 * still the better end state, and it belongs to the card that owns that page.
 *
 * `"unknown"` until the gateway has been asked, and the controls are drawn for
 * `"write"` only. Closed by default on purpose: this component renders on the
 * server before it can ask anything, and a delete button that appears for one
 * paint and is then taken away is a worse answer than one that appears a paint
 * late.
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
  const [permission, setPermission] = useState<"unknown" | "write" | "read">("unknown");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(SESSION_ENDPOINT, { cache: "no-store" });
        if (!alive) return;
        // A session the gateway will not confirm gets the smaller card. The
        // controls would only ever produce a refusal anyway.
        setPermission(
          response.ok && mayWrite(roleFromSessionBody(await response.json())) ? "write" : "read",
        );
      } catch {
        if (alive) setPermission("read");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function rename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Not only the missing control. The form is not drawn for a read-only
    // account, and this is the half of the guard that survives it being drawn
    // again by a later change.
    if (permission !== "write") return;
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
    // Before the prompt, not after it. Making an account that cannot delete
    // anything type a device's name out and then having the gateway refuse it
    // is the worst of both: all of the friction, none of the outcome.
    if (permission !== "write") return;
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

  // Read-only keeps what the card is about and loses what it offers. The name
  // stays, as the word it is rather than as a box nobody can type in — a
  // disabled control still reads as an offer — and the note about what removal
  // costs goes with the button it was warning about.
  //
  // Nothing here says "read-only" in words, and that is a gap rather than a
  // decision: the sentence is `role.readOnlyDevice`, it has to be resolved
  // against the request locale, and only the server knows that. Reading the
  // locale in an effect instead is the hydration bug this console has already
  // shipped twice. The page is not silent — `device-console.tsx` draws that
  // exact sentence above this card from the same answer — but this card should
  // say it too, on the day it is handed a locale.
  if (permission !== "write") {
    return (
      <div className="flex flex-col gap-6">
        <SpecTable>
          <TableBody>
            <SpecRow term={labels.name}>{name}</SpecRow>
          </TableBody>
        </SpecTable>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
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
