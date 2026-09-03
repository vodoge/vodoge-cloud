"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RowActions } from "@/components/ui/button-row";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, FormError, FormHint, InlineForm, Input, Select } from "@/components/ui/form";
import { CardPanel } from "@/components/ui/card";

type Labels = Record<string, string>;

/**
 * Recording a measurement, and handing the ledger to the fleet.
 *
 * Two actions on one card because they are two halves of one habit: measure,
 * write it down, and — when a round of testing is finished — publish. They are
 * deliberately not one action. Saving a row changes nothing about what any
 * device will attempt; only publishing does, and a half-finished afternoon of
 * testing reaching hardware because somebody saved a form is the failure this
 * separation exists to prevent.
 *
 * Publishing asks first, and the question states the consequence rather than
 * asking whether to continue: it replaces what every device in the tenant is
 * currently routing by, and a pairing that has fallen out of the ledger stops
 * working the moment it lands.
 */
export function LedgerAdmin({
  writable,
  rowCount,
  labels,
}: {
  writable: boolean;
  rowCount: number;
  labels: Labels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState({
    modemFamily: "",
    carrier: "",
    smsMo: "",
    smsMt: "",
    data: "",
    voice: "",
    testedBy: "",
    note: "",
  });

  async function save() {
    // Refused in the function, not only in the render. A control that is not
    // drawn is not a control that cannot be reached.
    if (!writable) return;
    setBusy(true);
    setError(null);
    const body = {
      sms_mo: form.smsMo || null,
      sms_mt: form.smsMt || null,
      data: form.data || null,
      voice: form.voice || null,
      tested_by: form.testedBy,
      note: form.note,
      bearer: "cellular",
    };
    const response = await fetch(
      `/v1/support-ledger/${encodeURIComponent(form.modemFamily)}/${encodeURIComponent(form.carrier)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || labels.failed);
      return;
    }
    setForm({ ...form, smsMo: "", smsMt: "", data: "", voice: "", note: "" });
    router.refresh();
  }

  async function publish() {
    // Refused in the function, not only in the render. A control that is not
    // drawn is not a control that cannot be reached.
    if (!writable) return;
    setAsking(false);
    setBusy(true);
    setError(null);
    const response = await fetch("/v1/support-ledger/publish", { method: "POST" });
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || labels.failed);
      return;
    }
    router.refresh();
  }

  if (!writable) {
    return null;
  }

  return (
    <CardPanel title={labels.record} note={labels.recordNote}>
      <div className="flex flex-col gap-4">
        <InlineForm
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label={labels.modem} inline>
            <Input
              value={form.modemFamily}
              onChange={(event) => setForm({ ...form, modemFamily: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              required
            />
          </Field>
          <Field label={labels.carrier} inline>
            <Input
              value={form.carrier}
              onChange={(event) => setForm({ ...form, carrier: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              required
            />
          </Field>
          <Verdict
            label={labels.smsMo}
            labels={labels}
            value={form.smsMo}
            onChange={(smsMo) => setForm({ ...form, smsMo })}
          />
          <Verdict
            label={labels.smsMt}
            labels={labels}
            value={form.smsMt}
            onChange={(smsMt) => setForm({ ...form, smsMt })}
          />
          <Verdict
            label={labels.data}
            labels={labels}
            value={form.data}
            onChange={(data) => setForm({ ...form, data })}
          />
          <Verdict
            label={labels.voice}
            labels={labels}
            value={form.voice}
            onChange={(voice) => setForm({ ...form, voice })}
          />
          <Field label={labels.testedBy} inline>
            <Input
              value={form.testedBy}
              onChange={(event) => setForm({ ...form, testedBy: event.target.value })}
              autoComplete="off"
              required
            />
          </Field>
          <Field label={labels.note} inline>
            <Input
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              autoComplete="off"
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {labels.save}
          </Button>
        </InlineForm>
        <FormHint>{labels.publishNote}</FormHint>
        <RowActions>
          <Button
            variant="risk"
            disabled={busy || rowCount === 0}
            onClick={() => setAsking(true)}
          >
            {labels.publish}
          </Button>
        </RowActions>
        {error ? <FormError>{error}</FormError> : null}
      </div>
      {asking ? (
        <ConfirmDialog
          open
          title={labels.confirmPublishTitle}
          consequence={labels.confirmPublish}
          labels={{
            question: labels.question,
            proceed: labels.proceed,
            cancel: labels.cancel,
          }}
          busy={busy}
          onConfirm={() => void publish()}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </CardPanel>
  );
}

/**
 * One operation's verdict, with "not measured" as a real option.
 *
 * The empty value is not a placeholder for "choose something": it is the
 * answer for an operation this round of testing did not cover, and it travels
 * as `null` so the pairing stays untested for that operation. A select whose
 * blank meant "supported by omission" is exactly the shape this design exists
 * to refuse.
 */
function Verdict({
  label,
  labels,
  value,
  onChange,
}: {
  label: string;
  labels: Labels;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} inline>
      <Select compact value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{labels.unmeasured}</option>
        <option value="supported">{labels.supported}</option>
        <option value="unsupported">{labels.unsupported}</option>
        <option value="probe">{labels.probe}</option>
      </Select>
    </Field>
  );
}
