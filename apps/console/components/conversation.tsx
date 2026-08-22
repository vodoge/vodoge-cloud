"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ThreadMessage } from "@/lib/catalog";

type Labels = Record<string, string>;

/**
 * One conversation, read the way a conversation is read: oldest at the top,
 * both directions, the latest at the bottom.
 *
 * A sent message appears the moment it is queued, with an honest status. Its
 * final state arrives when the device says what happened — which can be
 * minutes, or never if the device is offline, and pretending otherwise would
 * mean showing a tick for a message still sitting in a queue.
 */
export function Conversation({
  peer,
  messages,
  labels,
}: {
  peer: string;
  messages: ThreadMessage[];
  labels: Labels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function removeThread() {
    if (!window.confirm(labels.confirmDeleteThread)) return;
    setBusy(true);
    // The number travels in the body, not the URL: a phone number in a path
    // ends up in every access log between here and the browser.
    await fetch("/v1/messages/thread", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer }),
    });
    setBusy(false);
    router.push("/inbox");
    router.refresh();
  }

  async function removeMessage(id: string) {
    setBusy(true);
    await fetch(`/v1/messages/${id}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="stack">
      <div className="button-row">
        <button type="button" className="risk" disabled={busy} onClick={removeThread}>
          {labels.deleteThread}
        </button>
      </div>

      <ol className="conversation">
        {messages.map((message) => (
          <li
            key={message.id}
            className={message.direction === "inbound" ? "msg msg-in" : "msg msg-out"}
          >
            <p className="msg-body">{message.body}</p>
            <div className="msg-meta">
              <span className="mono faint">
                {new Date(message.receivedAt).toISOString().replace("T", " ").slice(5, 16)}
              </span>
              {message.direction === "outbound" ? (
                <DeliveryBadge message={message} labels={labels} />
              ) : null}
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => void removeMessage(message.id)}
              >
                {labels.remove}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What happened to a sent message.
 *
 * `queued` is shown as its own state rather than as a pending tick: the device
 * may be offline, and a message that has not left yet is a different thing
 * from one that has.
 */
function DeliveryBadge({ message, labels }: { message: ThreadMessage; labels: Labels }) {
  const tone =
    message.status === "sent"
      ? "badge-ok"
      : message.status === "failed"
        ? "badge-bad"
        : "badge-warn";
  return (
    <span>
      <span className={`badge ${tone}`}>{labels[`status.${message.status}`] ?? message.status}</span>
      {/* Why it failed is the half that says what to do about it. */}
      {message.failureReason ? (
        <span className="faint"> — {message.failureReason}</span>
      ) : null}
    </span>
  );
}
