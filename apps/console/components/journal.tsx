"use client";

import { useState } from "react";
import type { JournalEvent } from "@/lib/catalog";

type Labels = Record<string, string>;

/**
 * What the devices actually said.
 *
 * Every page in this console shows a projection — a modem's state, a message,
 * a traffic figure — and when one looks wrong the question is always whether
 * the device reported it that way or the projection mangled it. This is the
 * only place that answers it, so a row expands to the envelope verbatim rather
 * than to a summary.
 */
export function Journal({
  events,
  kinds,
  labels,
}: {
  events: JournalEvent[];
  kinds: string[];
  labels: Labels;
}) {
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [payloads, setPayloads] = useState<Record<string, unknown>>({});

  const shown = kind ? events.filter((event) => event.kind === kind) : events;

  async function expand(event: JournalEvent) {
    const key = rowKey(event);
    if (open === key) {
      setOpen(null);
      return;
    }
    setOpen(key);
    if (payloads[key] !== undefined) return;
    // Fetched per row rather than with the listing: a page of DeviceState
    // envelopes is a megabyte of JSON, and nearly all of it is never looked at.
    const query = new URLSearchParams({
      payload: "1",
      device_id: event.deviceId,
      limit: "200",
    });
    const response = await fetch(`/v1/journal?${query}`, { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { events?: JournalEvent[] };
    const match = (body.events ?? []).find(
      (candidate) => candidate.seq === event.seq && candidate.deviceId === event.deviceId,
    );
    setPayloads((current) => ({ ...current, [key]: match?.payload ?? null }));
  }

  return (
    <div className="stack">
      <div className="button-row">
        <button
          type="button"
          className={kind === "" ? "segmented-on" : ""}
          onClick={() => setKind("")}
        >
          {labels.all}
        </button>
        {kinds.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={kind === candidate ? "segmented-on" : ""}
            onClick={() => setKind(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{labels.colAt}</th>
              <th>{labels.colKind}</th>
              <th>{labels.colSeq}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((event) => {
              const key = rowKey(event);
              return (
                <tr key={key}>
                  <td className="mono faint">
                    {new Date(event.receivedAt).toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td>
                    <span className="badge badge-info">{event.kind}</span>
                  </td>
                  <td className="mono faint">{event.seq}</td>
                  <td>
                    <button type="button" className="link-button" onClick={() => void expand(event)}>
                      {open === key ? labels.hide : labels.show}
                    </button>
                    {open === key ? (
                      <pre className="output">
                        {payloads[key] === undefined
                          ? labels.loading
                          : JSON.stringify(payloads[key], null, 2)}
                      </pre>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {shown.length === 0 ? <p className="faint">{labels.none}</p> : null}
    </div>
  );
}

// A device's sequence is unique per device, not globally.
function rowKey(event: JournalEvent): string {
  return `${event.deviceId}:${event.seq}`;
}
