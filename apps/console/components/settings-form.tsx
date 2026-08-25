"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonRow } from "@/components/ui/button-row";
import { CardDisclosure } from "@/components/ui/card";
import { ConfirmDialog, type ConfirmLabels } from "@/components/ui/confirm-dialog";
import { Field, Form, FormError, FormHint, InlineField, Input } from "@/components/ui/form";
import { SecretInput } from "@/components/ui/secret-input";
import {
  CARD,
  FORM,
  groupSettingsFields,
  settingsDocument,
  settingsFormValues,
  settingsGroupIsOn,
  type SettingsField,
  type SettingsGroup,
} from "@/lib/tokens";

/**
 * The densest form in this console, as a renderer and nothing else.
 *
 * ## What moved out of here, and why
 *
 * The request body, the field table, the channel derivation and the
 * stored-secret rule all live in `lib/tokens.ts` now. Nothing in this app can
 * run a `.tsx` in a test — no jsdom, no testing-library — so a rule written
 * here is a rule nothing can check, and the rules on this page are the ones
 * where being wrong is expensive: a mishandled secret saves eight bullet
 * characters as somebody's SMTP password, and a mis-assembled document writes a
 * tenant's whole notification configuration.
 *
 * ## The two things this page does that reach outside the browser
 *
 * Both were unguarded, and both now go through `ConfirmDialog`:
 *
 * - **Send test** — `POST /v1/settings/notifications/{channel}/test` dials the
 *   channel *now*, with the credential the gateway is holding, and a real
 *   notification arrives at a real recipient. It was one click with no question
 *   at all.
 * - **Save** — `PUT /v1/settings/{section}` writes every field of the section
 *   in one document, for the whole tenant.
 *
 * ## Grouping
 *
 * The fields arrive as a runtime `SettingsField[]`, so the channels are derived
 * from their paths rather than counted: this file contains no number of
 * channels and must not. Each named group folds into a `<details>` — the reason
 * `CardDisclosure` exists — and a folded group says on or off in its summary,
 * because a row of closed panels that will not say which ones are live is worse
 * than the wall of inputs it replaced.
 */

type Labels = Record<string, string>;

type Section = "notifications" | "sms" | "security" | "devices";

/** One channel's live test, with its confirmation already in the operator's language. */
export type ChannelTest = {
  /** The path segment the POST uses. */
  readonly channel: string;
  /** What to call it on the button. */
  readonly label: string;
  readonly title: string;
  readonly consequence: string;
};

type Pending = {
  readonly title: string;
  readonly consequence: string;
  readonly confirmLabel: string;
  readonly run: () => void;
};

export function SettingsForm({
  section,
  initial,
  fields,
  labels,
  confirm,
  saveTitle,
  saveConsequence,
  testable = [],
}: {
  section: Section;
  initial: Record<string, unknown>;
  fields: readonly SettingsField[];
  labels: Labels;
  /** The dialog's own chrome, so every confirmation asks in the same words. */
  confirm: ConfirmLabels;
  saveTitle: string;
  /** Assembled on the server by `settingsSaveConsequence`. */
  saveConsequence: string;
  /** Channels this section can send a live test through. */
  testable?: readonly ChannelTest[];
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    settingsFormValues(initial, fields),
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const groups = groupSettingsFields(fields);

  // Which panels start open, decided once from what the gateway sent. React
  // writes `open` to the element only when the prop *changes*, so a value that
  // is stable across renders leaves the operator's own folding alone — and this
  // form re-renders on every keystroke.
  const [openAtFirst] = useState(() => {
    const stored = settingsFormValues(initial, fields);
    return new Set(
      groupSettingsFields(fields)
        .filter((group) => settingsGroupIsOn(group, stored))
        .map((group) => group.name),
    );
  });

  async function saveSettings() {
    setStatus("saving");
    setMessage(null);
    const response = await fetch(`/v1/settings/${section}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settingsDocument(fields, values)),
    });
    if (!response.ok) {
      setStatus("error");
      setMessage((await response.text()).trim() || labels.saveFailed);
      return;
    }
    setStatus("saved");
    setMessage(labels.saved);
  }

  function askSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending({
      title: saveTitle,
      consequence: saveConsequence,
      confirmLabel: labels.save,
      run: () => void saveSettings(),
    });
  }

  const change = (path: string) => (next: unknown) =>
    setValues((current) => ({ ...current, [path]: next }));

  return (
    <>
      <Form onSubmit={askSave}>
        <div className={CARD.stack}>
          {groups.map((group) =>
            group.name === null ? (
              <FieldList
                key="flat"
                group={group}
                labels={labels}
                values={values}
                change={change}
              />
            ) : (
              <CardDisclosure
                key={group.name}
                open={openAtFirst.has(group.name)}
                title={labels[group.name] ?? group.name}
                hint={<GroupState group={group} labels={labels} values={values} />}
              >
                <FieldList group={group} labels={labels} values={values} change={change} />
              </CardDisclosure>
            ),
          )}
        </div>

        <ButtonRow>
          <Button type="submit" disabled={status === "saving"}>
            {labels.save}
          </Button>
          {message ? (
            status === "error" ? (
              <FormError>{message}</FormError>
            ) : (
              <FormHint>{message}</FormHint>
            )
          ) : null}
        </ButtonRow>

        {/* A channel is only really configured once something has arrived at
            the other end. Testing after saving, not before, because the test
            uses what is stored — including the secret the console never had. */}
        {testable.length > 0 ? (
          <ButtonRow>
            {testable.map((test) => (
              <TestButton key={test.channel} test={test} labels={labels} ask={setPending} />
            ))}
          </ButtonRow>
        ) : null}
      </Form>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ""}
        consequence={pending?.consequence ?? saveConsequence}
        confirmLabel={pending?.confirmLabel}
        labels={confirm}
        onConfirm={() => {
          pending?.run();
          setPending(null);
        }}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

/** On or off, in the summary of a panel that is folded shut. */
function GroupState({
  group,
  labels,
  values,
}: {
  group: SettingsGroup;
  labels: Labels;
  values: Record<string, unknown>;
}) {
  if (group.enabledPath === null) return null;
  const on = settingsGroupIsOn(group, values);
  return (
    <Badge tone={on ? "ok" : "neutral"}>{on ? labels.channelOn : labels.channelOff}</Badge>
  );
}

function FieldList({
  group,
  labels,
  values,
  change,
}: {
  group: SettingsGroup;
  labels: Labels;
  values: Record<string, unknown>;
  change: (path: string) => (next: unknown) => void;
}) {
  return (
    <div className={FORM.root}>
      {group.fields.map((field) => (
        <FieldInput
          key={field.path}
          field={field}
          label={labels[field.path] ?? field.path}
          hint={labels.listHint}
          value={values[field.path]}
          onChange={change(field.path)}
        />
      ))}
    </div>
  );
}

/**
 * Sends one real notification through one channel and reports what came back.
 *
 * The gateway answers synchronously for exactly this: a queued test that
 * reported success immediately would tell the person pressing it nothing.
 *
 * The POST is not reachable from the button. It runs from `run` on a pending
 * confirmation and from nowhere else, which is asserted rather than remembered.
 */
function TestButton({
  test,
  labels,
  ask,
}: {
  test: ChannelTest;
  labels: Labels;
  ask: (pending: Pending) => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "ok" | "failed">("idle");
  const [detail, setDetail] = useState<string | null>(null);

  async function sendTest() {
    setState("sending");
    setDetail(null);
    const response = await fetch(`/v1/settings/notifications/${test.channel}/test`, {
      method: "POST",
    });
    if (response.ok) {
      setState("ok");
      return;
    }
    setState("failed");
    // The channel's own error is the useful half: "connection refused" and
    // "authentication failed" need completely different fixes.
    setDetail((await response.text()).trim() || labels.testFailed);
  }

  function askTest() {
    ask({
      title: test.title,
      consequence: test.consequence,
      confirmLabel: labels.test,
      run: () => void sendTest(),
    });
  }

  return (
    <ButtonRow>
      <Button variant="ghost" onClick={askTest} disabled={state === "sending"}>
        {labels.test} · {test.label}
      </Button>
      {state === "ok" ? <Badge tone="ok">{labels.testSent}</Badge> : null}
      {state === "failed" ? <FormError>{detail}</FormError> : null}
    </ButtonRow>
  );
}

/**
 * One box.
 *
 * A secret is a `SecretInput` and can be nothing else: it is the one control
 * here that must never put back what it was given, because the gateway sends a
 * redaction marker in place of a stored credential and echoing it into `value`
 * saves the marker as the new credential the first time somebody presses Save
 * without touching the box.
 *
 * A list is a `<textarea>`, which is the only appearance change on this page
 * that was not a class swap. It carried "one per line" as the placeholder of a
 * **single-line** box, so the one thing it told the operator to do was the one
 * thing it would not let them do. The request is unchanged — same field, same
 * PUT, and `coerceSettingValue` still splits on commas as well as newlines, so
 * what an operator typed into the old box still means what it meant.
 */
function FieldInput({
  field,
  label,
  hint,
  value,
  onChange,
}: {
  field: SettingsField;
  label: string;
  hint: string;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <InlineField
        label={label}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  if (field.kind === "secret") {
    return (
      <Field label={label}>
        <SecretInput value={value} onChange={(event) => onChange(event.target.value)} />
      </Field>
    );
  }
  if (field.kind === "list") {
    return (
      <Field label={label}>
        <textarea
          className={FORM.textarea}
          rows={3}
          value={String(value ?? "")}
          placeholder={hint}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
        />
      </Field>
    );
  }
  if (field.kind === "number") {
    return (
      <Field label={label}>
        <Input
          type="number"
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    );
  }
  return (
    <Field label={label}>
      <Input
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    </Field>
  );
}

/**
 * Rotating your own password.
 *
 * Not gated on the tenant's write permission, and that is deliberate: the
 * gateway lets a read-only session change its own credential, and an account
 * that cannot respond to its own password leaking leaves nobody safer.
 *
 * No confirmation. It is the one write on this page that affects only the
 * person pressing it, it needs the current password to succeed, and the note
 * underneath already says what it costs — the other sessions.
 */
export function PasswordForm({ labels }: { labels: Labels }) {
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/v1/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        current_password: String(form.get("current") ?? ""),
        new_password: String(form.get("next") ?? ""),
      }),
    });
    setFailed(!response.ok);
    setStatus(response.ok ? labels.passwordChanged : (await response.text()).trim());
    if (response.ok) event.currentTarget.reset();
  }

  return (
    <Form onSubmit={submit}>
      <Field label={labels.currentPassword}>
        <Input name="current" type="password" autoComplete="current-password" required />
      </Field>
      <Field label={labels.newPassword}>
        <Input name="next" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <ButtonRow>
        <Button type="submit">{labels.changePassword}</Button>
        {status ? failed ? <FormError>{status}</FormError> : <FormHint>{status}</FormHint> : null}
      </ButtonRow>
      {/* Every other session the account holds ends here, which is the point
          of changing a password that may have leaked. */}
      <FormHint>{labels.passwordNote}</FormHint>
    </Form>
  );
}
