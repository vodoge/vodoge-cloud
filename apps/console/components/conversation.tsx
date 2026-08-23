"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
  name,
  messages,
  labels,
}: {
  peer: string;
  name: string;
  messages: ThreadMessage[];
  labels: Labels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const unread = messages.some(
    (message) => message.direction === "inbound" && message.readAt == null,
  );

  // Opening the conversation is what marks it read.
  //
  // Done here rather than in the page, because the page is a server component
  // and Next renders those more than once — on a prefetch, and again on the
  // real navigation. A read that happened during rendering would clear the
  // badge for a conversation nobody opened.
  const marked = useRef(false);
  useEffect(() => {
    if (!unread || marked.current) return;
    marked.current = true;
    void (async () => {
      await fetch("/v1/messages/thread/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peer }),
      });
      router.refresh();
    })();
  }, [peer, unread, router]);

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
        <ContactName peer={peer} name={name} busy={busy} setBusy={setBusy} labels={labels} />
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
            {message.encoding === "8bit" ? (
              // Binary: SIM toolkit or OTA traffic, shown as hex because it
              // is not text. Saying so matters -- unexplained hex reads as a
              // broken decoder, which is how four real decoding faults
              // stayed hidden for weeks.
              <>
                <p className="msg-body mono faint">{message.body}</p>
                <p className="msg-binary">{labels["encoding.8bit"]}</p>
              </>
            ) : (
              <p className="msg-body">{message.body}</p>
            )}
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
 * Names the number, or renames it.
 *
 * Kept next to the conversation rather than on a contacts screen of its own:
 * the moment anyone knows who a number belongs to is the moment they are
 * reading what it said.
 */
function ContactName({
  peer,
  name,
  busy,
  setBusy,
  labels,
}: {
  peer: string;
  name: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  labels: Labels;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  async function save() {
    const trimmed = draft.trim();
    setBusy(true);
    if (trimmed === "") {
      // Clearing the field means "forget the name", not "store a blank one":
      // a blank name would render as an empty heading where the number was.
      await fetch("/v1/messages/contact", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peer }),
      });
    } else {
      await fetch("/v1/messages/contact", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peer, name: trimmed }),
      });
    }
    setBusy(false);
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <button type="button" disabled={busy} onClick={() => setEditing(true)}>
        {name ? labels.renameContact : labels.nameContact}
      </button>
    );
  }
  return (
    <span className="button-row">
      <input
        type="text"
        value={draft}
        maxLength={128}
        placeholder={labels.contactName}
        aria-label={labels.contactName}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="button" disabled={busy} onClick={() => void save()}>
        {labels.save}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setDraft(name);
          setEditing(false);
        }}
      >
        {labels.cancel}
      </button>
    </span>
  );
}

/**
 * What happened to a sent message.
 *
 * `queued` is shown as its own state rather than as a pending tick: the device
 * may be offline, and a message that has not left yet is a different thing
 * from one that has.
 *
 * So are `sent` and `delivered`. `sent` is the modem reporting that it took
 * the message; `delivered` is the network reporting that the recipient got it,
 * and it arrives separately and later. Showing the first as if it were the
 * second is the specific claim this badge exists to avoid making.
 */
function DeliveryBadge({ message, labels }: { message: ThreadMessage; labels: Labels }) {
  const tone =
    message.status === "delivered"
      ? "badge-ok"
      : message.status === "sent"
        ? "badge-ok"
        : message.status === "failed" || message.status === "undelivered"
          ? "badge-bad"
          : "badge-warn";
  return (
    <span>
      <span className={`badge ${tone}`}>{labels[`status.${message.status}`] ?? message.status}</span>
      {/* When the network says it handed the message over. This is the
          discharge time from the report, not when the report reached us. */}
      {message.status === "delivered" && message.deliveredAt ? (
        <span className="mono faint">
          {" "}
          {new Date(message.deliveredAt).toISOString().replace("T", " ").slice(5, 16)}
        </span>
      ) : null}
      {/* Why it failed is the half that says what to do about it. */}
      {message.failureReason ? (
        <span className="faint"> — {message.failureReason}</span>
      ) : null}
    </span>
  );
}
