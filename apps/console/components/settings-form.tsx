"use client";

import { useState } from "react";

/**
 * The placeholder the gateway sends in place of a stored secret, and what it
 * accepts back to mean "leave it alone". The console never holds a real
 * credential — it would otherwise sit in the page's HTML on every visit.
 */
const REDACTED = "••••••••";

type Section = "notifications" | "sms" | "security" | "devices";

type Labels = Record<string, string>;

export function SettingsForm({
  section,
  initial,
  fields,
  labels,
}: {
  section: Section;
  initial: Record<string, unknown>;
  fields: Field[];
  labels: Labels;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map((field) => [field.path, read(initial, field.path)])),
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setMessage(null);
    const document: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.path];
      // An untouched secret is sent back as the placeholder, which is what
      // tells the gateway to keep the stored one.
      if (field.kind === "secret" && (value === "" || value === undefined)) continue;
      write(document, field.path, coerce(field, value));
    }
    const response = await fetch(`/v1/settings/${section}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(document),
    });
    if (!response.ok) {
      setStatus("error");
      setMessage((await response.text()).trim() || labels.saveFailed);
      return;
    }
    setStatus("saved");
    setMessage(labels.saved);
  }

  return (
    <form onSubmit={save} className="stack">
      {fields.map((field) => (
        <FieldInput
          key={field.path}
          field={field}
          label={labels[field.path] ?? field.path}
          value={values[field.path]}
          onChange={(next) => setValues((current) => ({ ...current, [field.path]: next }))}
        />
      ))}
      <div className="button-row">
        <button type="submit" disabled={status === "saving"}>
          {labels.save}
        </button>
        {message ? (
          <span className={status === "error" ? "error" : "faint"}>{message}</span>
        ) : null}
      </div>
    </form>
  );
}

export type Field = {
  path: string;
  kind: "text" | "secret" | "number" | "boolean" | "list";
};

function FieldInput({
  field,
  label,
  value,
  onChange,
}: {
  field: Field;
  label: string;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <label className="field-inline">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
    );
  }
  const stored = field.kind === "secret" && value === REDACTED;
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={field.kind === "secret" ? "password" : field.kind === "number" ? "number" : "text"}
        value={stored ? "" : String(value ?? "")}
        // A secret that is already stored shows an empty box with the
        // placeholder as its hint: typing replaces it, leaving it keeps it.
        placeholder={stored ? REDACTED : field.kind === "list" ? "one per line" : ""}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={field.kind === "secret" ? "new-password" : "off"}
        spellCheck={false}
      />
    </label>
  );
}

function coerce(field: Field, value: unknown): unknown {
  switch (field.kind) {
    case "number": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case "boolean":
      return value === true;
    case "list":
      return String(value ?? "")
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
    default:
      return value ?? "";
  }
}

function read(document: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let cursor: unknown = document;
  for (const key of keys) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  // A list is edited as one value per line, which is far easier to paste into
  // than a comma-separated field.
  return Array.isArray(cursor) ? cursor.join("\n") : cursor;
}

function write(document: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cursor = document;
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
}

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
    <form onSubmit={submit} className="stack">
      <label className="field">
        <span>{labels.currentPassword}</span>
        <input name="current" type="password" autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>{labels.newPassword}</span>
        <input
          name="next"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <div className="button-row">
        <button type="submit">{labels.changePassword}</button>
        {status ? <span className={failed ? "error" : "faint"}>{status}</span> : null}
      </div>
      {/* Every other session the account holds ends here, which is the point
          of changing a password that may have leaked. */}
      <p className="faint">{labels.passwordNote}</p>
    </form>
  );
}
