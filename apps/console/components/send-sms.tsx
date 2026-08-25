"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, type ConfirmLabels } from "@/components/ui/confirm-dialog";
import { Field, Form, FormError, FormHint, Input, Select } from "@/components/ui/form";
import { interpolate } from "@/lib/i18n";
import { INBOX } from "@/lib/tokens";

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
 *    `SMS_BLOCKED_MODULES` in `lib/tokens.ts` for what that costs and — more
 *    importantly — for what it does *not* cost, because the obvious wording is
 *    a lie that produces duplicate messages at the far end.
 *
 * ## What did not change
 *
 * The request. Same endpoint, same method, same three fields in the same order.
 * The confirmation sits in front of it and the refusal sits in front of that;
 * neither touches what is sent.
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
  /** The module list could not be read, so nothing here was checked. */
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
  /** `true` when the module list failed to load: nothing below was checked. */
  modemsUnknown?: boolean;
}) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");

  const chosen = devices.find((device) => device.id === deviceId) ?? devices[0];
  const blocked = chosen?.blocked ?? [];

  // Read here, sent on confirm. `currentTarget` is only the form during the
  // handler, so the draft is taken now rather than after the question.
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Checked here as well as on the button. A guard that lives only in a
    // disabled attribute is one Return key and one stale render away from not
    // existing, and the edge panel learned that on this same module.
    if (blocked.length > 0) return;
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
        {blocked.length > 0 ? (
          <div className={INBOX.blocked}>
            <span className={INBOX.blockedTitle}>
              <Badge tone="bad">{labels.blockedBadge}</Badge> {labels.blockedTitle}
            </span>
            <p className={INBOX.blockedBody}>{labels.blockedDevice}</p>
            {blocked.map((module) => (
              <p key={module.imei} className={INBOX.blockedBody}>
                {module.why} {module.cost}
              </p>
            ))}
          </div>
        ) : null}

        {modemsUnknown ? <FormHint>{labels.modemsUnknown}</FormHint> : null}

        <Field label={labels.to}>
          <Input name="to" required placeholder="+86138..." />
        </Field>
        <Field label={labels.body}>
          <Input name="body" required />
        </Field>
        <Button type="submit" disabled={busy || blocked.length > 0}>
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
