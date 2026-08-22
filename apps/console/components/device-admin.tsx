"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
    <div className="stack">
      <form className="inline-form" onSubmit={rename}>
        <label className="field grow">
          <span>{labels.name}</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={128}
            required
          />
        </label>
        <button type="submit" disabled={busy || draft === name || draft.trim() === ""}>
          {labels.rename}
        </button>
      </form>

      {error ? <p className="error">{error}</p> : null}

      <div className="button-row">
        <button type="button" className="risk" disabled={busy} onClick={remove}>
          {labels.delete}
        </button>
      </div>
      <p className="faint">{labels.deleteNote}</p>
    </div>
  );
}
