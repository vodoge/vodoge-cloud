"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, type ConfirmLabels } from "@/components/ui/confirm-dialog";
import { Field, Form, FormError, FormHint, Input, Select } from "@/components/ui/form";
import { interpolate } from "@/lib/i18n";
import { sendHold } from "@/lib/sms-safety";

/**
 * The one control in this console that spends money on the operator's behalf.
 *
 * ## What was wrong with it
 *
 * Three things, and the third is the one that matters.
 *
 * 1. It asked nothing. A text message is billed, leaves the fleet, and cannot
 *    be recalled or edited once it has gone, and the button that did it sat
 *    beside two text fields with no confirmation of any kind.
 * 2. It was never styled. `className="panel"` and `className="primary"` name
 *    classes that exist in no stylesheet and never have, so this form has been
 *    an unstyled box with an unstyled button since it was written. Nobody sees
 *    that in review; it took asking the build.
 * 3. It would happily send from a module that must not send. See
 *    `SMS_BLOCKED_MODULES` in `lib/sms-safety.ts` for what that costs and —
 *    more importantly — for what it does *not* cost, because the obvious
 *    wording is a lie that produces duplicate messages at the far end.
 *
 * ## What T032 changed, and it is a change of behaviour
 *
 * A module list that failed to load used to leave this form live with a note
 * under the field saying it had not been checked. It now holds the send. The
 * argument is in `sendHold`: the list is read in order to stop one send from
 * costing a module on hardware nobody can reach, so "could not find out" must
 * not be the answer that lets that send through.
 *
 * The copy for it says the list could not be read. It must never say the send
 * failed — a failure is the thing operators respond to by sending again.
 *
 * The read-only gate is not here. Whether the account may write at all is
 * decided on the server in `app/inbox/page.tsx`, which renders a note instead
 * of this form; a client component cannot be the place that decision is made,
 * because the props it would read arrive from the same page.
 *
 * ## What did not change
 *
 * The request. Same endpoint, same method, same three fields in the same order.
 * The confirmation sits in front of it and the refusals sit in front of that;
 * none of them touches what is sent.
 */

/** A module on the chosen device that this console will not send from. */
export type BlockedModule = {
  imei: string;
  /** Why, in the operator's language. Resolved on the server. */
  why: string;
  /** And what it actually costs, which is not what it looks like. */
  cost: string;
};

export type SendDevice = {
  id: string;
  name: string;
  /** Empty for a device with nothing known against it. */
  blocked: BlockedModule[];
};

export type SendLabels = {
  to: string;
  body: string;
  send: string;
  queued: string;
  failed: string;
  device: string;
  /** Marks a blocked device in the picker, so it is known before the tap. */
  blockedBadge: string;
  blockedTitle: string;
  blockedDevice: string;
  /**
   * The module list could not be read, so sending is held. Two strings and
   * neither of them is "the send failed": see `sendHold`.
   */
  modemsUnknownTitle: string;
  modemsUnknown: string;
  /**
   * Templates, not sentences: `{to}` and `{device}` are filled in on the
   * client, because a confirmation that says "this sends a message" without
   * saying to whom is the shape of confirmation this console is being fixed of.
   */
  confirmTitle: string;
  confirmConsequence: string;
};

/** Exactly the body `POST /v1/commands` took before, unchanged. */
type Draft = { device_id: string; to: string; body: string };

export function SendSmsForm({
  devices,
  labels,
  confirmLabels,
  modemsUnknown,
}: {
  devices: SendDevice[];
  labels: SendLabels;
  confirmLabels: ConfirmLabels;
  /**
   * `true` when the module list failed to load: nothing below was checked.
   *
   * Required, and deliberately not optional. An omitted boolean is `undefined`,
   * `!undefined` is "known", and a caller that forgot this prop would get the
   * permissive branch silently — which is the exact shape of the fail-open this
   * card was opened to remove.
   */
  modemsUnknown: boolean;
}) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");

  const chosen = devices.find((device) => device.id === deviceId) ?? devices[0];
  const blocked = chosen?.blocked ?? [];
  const hold = sendHold({ modemsKnown: !modemsUnknown, blocked });

  // Read here, sent on confirm. `currentTarget` is only the form during the
  // handler, so the draft is taken now rather than after the question.
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Checked here as well as on the button. A guard that lives only in a
    // disabled attribute is one Return key and one stale render away from not
    // existing, and the edge panel learned that on this same module.
    if (hold !== null) return;
    const form = new FormData(event.currentTarget);
    setPending({
      device_id: String(form.get("device_id") ?? ""),
      to: String(form.get("to") ?? ""),
      body: String(form.get("body") ?? ""),
    });
  }

  async function sendMessage(draft: Draft) {
    setBusy(true);
    const response = await fetch("/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: draft.device_id,
        to: draft.to,
        body: draft.body,
      }),
    });
    setBusy(false);
    setPending(null);
    setStatus({ ok: response.ok, text: response.ok ? labels.queued : labels.failed });
  }

  if (devices.length === 0) {
    return null;
  }

  return (
    <>
      <Form onSubmit={onSubmit}>
        <Field label={labels.device}>
          <Select
            name="device_id"
            required
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} ({device.id})
                {device.blocked.length > 0 ? ` — ${labels.blockedBadge}` : ""}
              </option>
            ))}
          </Select>
        </Field>

        {/* The refusal, in the place the choice was made, with the reason and
            the correction on screen rather than behind the button. */}
        {hold === "blocked-module" ? (
          <div className="m-0 flex flex-col gap-2 rounded border border-solid border-bad bg-bad-wash p-3 text-sm text-destructive">
            <span className="font-semibold">
              <Badge tone="bad">{labels.blockedBadge}</Badge> {labels.blockedTitle}
            </span>
            <p className="m-0">{labels.blockedDevice}</p>
            {blocked.map((module) => (
              <p key={module.imei} className="m-0">
                {module.why} {module.cost}
              </p>
            ))}
          </div>
        ) : null}

        {/* The other refusal, and it used to be a hint under a live button.
            Same box as the one above so it reads as a refusal, a different
            colour because it is a different claim: that one is settled, this
            one is "nobody could find out". */}
        {hold === "modules-unknown" ? (
          <div className="m-0 flex flex-col gap-2 rounded border border-solid border-warn bg-warn-wash p-3 text-sm text-warn">
            <span className="font-semibold">{labels.modemsUnknownTitle}</span>
            <p className="m-0">{labels.modemsUnknown}</p>
          </div>
        ) : null}

        <Field label={labels.to}>
          <Input name="to" required placeholder="+86138..." />
        </Field>
        <Field label={labels.body}>
          <Input name="body" required />
        </Field>
        <Button type="submit" disabled={busy || hold !== null}>
          {labels.send}
        </Button>
        {status ? (
          status.ok ? (
            <FormHint>{status.text}</FormHint>
          ) : (
            // A send that failed is not a note about what a control will do.
            <FormError>{status.text}</FormError>
          )
        ) : null}
      </Form>

      <ConfirmDialog
        open={pending !== null}
        title={interpolate(labels.confirmTitle, { to: pending?.to ?? "" })}
        consequence={interpolate(labels.confirmConsequence, {
          to: pending?.to ?? "",
          // The name if it has one, and the id either way: two devices can
          // share a name, and the id is what the command is aimed at.
          device: chosen ? `${chosen.name} (${chosen.id})` : (pending?.device_id ?? ""),
        })}
        labels={confirmLabels}
        confirmLabel={labels.send}
        busy={busy}
        onConfirm={() => {
          if (pending) void sendMessage(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
