"use client";

import { useState } from "react";

export function SendSmsForm({
  devices,
  labels,
}: {
  devices: { id: string; name: string }[];
  labels: { to: string; body: string; send: string; queued: string; failed: string; device: string };
}) {
  const [status, setStatus] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: String(form.get("device_id") ?? ""),
        to: String(form.get("to") ?? ""),
        body: String(form.get("body") ?? ""),
      }),
    });
    setStatus(response.ok ? labels.queued : labels.failed);
  }

  if (devices.length === 0) {
    return null;
  }

  return (
    <form onSubmit={onSubmit} className="panel" style={{ padding: "1rem", marginBottom: "1rem" }}>
      <label>
        {labels.device}
        <select name="device_id" required>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name} ({device.id})
            </option>
          ))}
        </select>
      </label>
      <label>
        {labels.to}
        <input name="to" required placeholder="+86138..." />
      </label>
      <label>
        {labels.body}
        <input name="body" required />
      </label>
      <button type="submit" className="primary">
        {labels.send}
      </button>
      {status ? <p className="hint">{status}</p> : null}
    </form>
  );
}
