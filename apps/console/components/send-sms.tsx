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

/** 一根可以用来发的模组。收件人看到的是**这张卡**的号码。 */
export type SendModem = {
  imei: string;
  /** 卡上的号码。null 有两种意思，靠下面那一位分开。 */
  msisdn: string | null;
  /**
   * 号码为空时，空的是哪一种：true = 换了卡还没读出来，false = 问过了、这张卡
   * 就是没有号码。
   *
   * 🔴 在这里合成一句话是错的：运维正是靠号码认卡的，「待读」会让他等一个
   * 永远不来的答案，而对一张真读不到号码的卡说「无号码」又是替它下了结论。
   */
  msisdnPending: boolean;
};

export type SendDevice = {
  id: string;
  name: string;
  /** Empty for a device with nothing known against it. */
  blocked: BlockedModule[];
  /**
   * 这台设备上可以发的模组。
   *
   * 🔴 表单以前不问这个，只发 {device_id, to, body}，而网关的 send_sms 是
   * NeedsModem（catalogue.go:188），没有 15 位 IMEI 直接 400 —— 收件箱这个
   * 表单因此**一条都发不出去**。设备页和计划任务那两条路一直带着它。
   *
   * 也不能替运维随便挑一根：收件人看到的是那张卡的号码，费用记在那个订阅上，
   * 挑错了是一个看起来成功的错答案。
   */
  modems: SendModem[];
};

export type SendLabels = {
  /** 「从哪根模组发」那个选择框的标签。 */
  modem: string;
  /** 这台设备上一根可发的模组都没有时，选择框里那句话。 */
  noModem: string;
  /** 号码还没为这张卡读出来时说的话。 */
  msisdnPending: string;
  /** 问过了、这张卡就是没有号码时说的话。和上一句不能合并。 */
  msisdnNone: string;
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
type Draft = { device_id: string; modem_imei: string; to: string; body: string };

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
  // 换设备就把模组选择清掉：上一台的 IMEI 在这一台上不存在，留着它会让
  // 表单看起来选好了、然后被网关以 400 拒掉。
  const [modemImei, setModemImei] = useState("");

  const chosen = devices.find((device) => device.id === deviceId) ?? devices[0];
  const blockedImeis = new Set((chosen?.blocked ?? []).map((module) => module.imei));
  const sendable = (chosen?.modems ?? []).filter((modem) => !blockedImeis.has(modem.imei));
  // 选中的那根还在不在当前设备上；不在就回落到第一根可发的。
  const activeImei = sendable.some((modem) => modem.imei === modemImei)
    ? modemImei
    : (sendable[0]?.imei ?? "");
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
      modem_imei: String(form.get("modem_imei") ?? ""),
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
        // 网关的 send_sms 是 NeedsModem：少了它就是 400，而不是「随便挑一根」。
        modem_imei: draft.modem_imei,
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

        {/* 从哪根模组发。**必须由人选**：收件人看到的是这张卡的号码，费用记在
            这个订阅上，替他挑一根是个看起来成功的错答案。网关那边它也是必填
            （send_sms 是 NeedsModem），少了就是 400。 */}
        <Field label={labels.modem}>
          <Select
            name="modem_imei"
            required
            value={activeImei}
            disabled={sendable.length === 0}
            onChange={(event) => setModemImei(event.target.value)}
          >
            {sendable.length === 0 ? (
              <option value="">{labels.noModem}</option>
            ) : (
              sendable.map((modem) => (
                <option key={modem.imei} value={modem.imei}>
                  {modem.imei}
                  {/* 号码为空时说清是哪一种空。留白读起来像「这张卡没有号码」，
                      而那两种情况要运维做的事相反：一个再等一轮，一个到此为止。 */}
                  {` · ${
                    modem.msisdn ??
                    (modem.msisdnPending ? labels.msisdnPending : labels.msisdnNone)
                  }`}
                </option>
              ))
            )}
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
