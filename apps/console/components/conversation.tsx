"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonRow } from "@/components/ui/button-row";
import { ConfirmDialog, type ConfirmLabels } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/form";
import type { ThreadMessage } from "@/lib/catalog";
import { cn } from "@/lib/cn";
import { interpolate } from "@/lib/i18n";
import { INBOX, toneForDeliveryStatus } from "@/lib/tokens";

type Labels = Record<string, string>;

/**
 * One conversation, read the way a conversation is read: oldest at the top,
 * both directions, the latest at the bottom.
 *
 * A sent message appears the moment it is queued, with an honest status. Its
 * final state arrives when the device says what happened — which can be
 * minutes, or never if the device is offline, and pretending otherwise would
 * mean showing a tick for a message still sitting in a queue.
 *
 * ## The two silent deletions
 *
 * Deleting the thread has always asked. Deleting **one message** and deleting
 * **the contact's name** did not, and both are `DELETE`s against the gateway:
 * the row is gone from the server for everyone, not hidden in this browser.
 * That reading — "it is just hidden here" — is the one an unannounced delete
 * invites, so the confirmations say the opposite in as many words.
 *
 * All three now use the same dialog, which has somewhere to put the
 * consequence. The thread's own confirmation was kept and rewritten rather than
 * kept as it was: `window.confirm` shows one string, and the Chinese one was
 * fourteen characters ending in a question mark.
 */
export function Conversation({
  peer,
  name,
  messages,
  labels,
  confirmLabels,
}: {
  peer: string;
  name: string;
  messages: ThreadMessage[];
  labels: Labels;
  confirmLabels: ConfirmLabels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  /** Which deletion has been asked for and not yet answered. */
  const [pending, setPending] = useState<{ kind: "thread" } | { kind: "message"; id: string } | null>(
    null,
  );
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
    setBusy(true);
    // The number travels in the body, not the URL: a phone number in a path
    // ends up in every access log between here and the browser.
    await fetch("/v1/messages/thread", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer }),
    });
    setBusy(false);
    setPending(null);
    router.push("/inbox");
    router.refresh();
  }

  async function removeMessage(id: string) {
    setBusy(true);
    await fetch(`/v1/messages/${id}`, { method: "DELETE" });
    setBusy(false);
    setPending(null);
    router.refresh();
  }

  const asked =
    pending?.kind === "thread"
      ? {
          title: labels.deleteThread,
          consequence: interpolate(labels.confirmDeleteThread, { peer }),
        }
      : {
          title: labels.confirmDeleteMessageTitle,
          consequence: labels.confirmDeleteMessage,
        };

  return (
    <div className={INBOX.stack}>
      <ButtonRow>
        <ContactName
          peer={peer}
          name={name}
          busy={busy}
          setBusy={setBusy}
          labels={labels}
          confirmLabels={confirmLabels}
        />
        <Button
          variant="risk"
          disabled={busy}
          onClick={() => setPending({ kind: "thread" })}
        >
          {labels.deleteThread}
        </Button>
      </ButtonRow>

      <ol className={INBOX.list}>
        {messages.map((message) => (
          <li
            key={message.id}
            className={cn(
              INBOX.message,
              message.direction === "inbound" ? INBOX.messageIn : INBOX.messageOut,
            )}
          >
            {message.encoding === "8bit" ? (
              // Binary: SIM toolkit or OTA traffic, shown as hex because it
              // is not text. Saying so matters -- unexplained hex reads as a
              // broken decoder, which is how four real decoding faults
              // stayed hidden for weeks.
              <>
                <p className={cn(INBOX.body, INBOX.metaTime)}>{message.body}</p>
                <p className={INBOX.binaryNote}>{labels["encoding.8bit"]}</p>
              </>
            ) : (
              <p className={INBOX.body}>{message.body}</p>
            )}
            <div className={INBOX.meta}>
              <span className={INBOX.metaTime}>
                {new Date(message.receivedAt).toISOString().replace("T", " ").slice(5, 16)}
              </span>
              {message.direction === "outbound" ? (
                <DeliveryBadge message={message} labels={labels} />
              ) : null}
              <Button
                variant="subtle"
                size="sm"
                disabled={busy}
                onClick={() => setPending({ kind: "message", id: message.id })}
              >
                {labels.remove}
              </Button>
            </div>
          </li>
        ))}
      </ol>

      <ConfirmDialog
        open={pending !== null}
        title={asked.title}
        consequence={asked.consequence}
        labels={confirmLabels}
        confirmLabel={labels.remove}
        busy={busy}
        onConfirm={() => {
          if (pending?.kind === "thread") void removeThread();
          if (pending?.kind === "message") void removeMessage(pending.id);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

/**
 * Names the number, or renames it.
 *
 * Kept next to the conversation rather than on a contacts screen of its own:
 * the moment anyone knows who a number belongs to is the moment they are
 * reading what it said.
 *
 * Clearing the field means "forget the name", not "store a blank one" — and
 * that is a `DELETE`, which is why the empty case asks and the rename does not.
 */
function ContactName({
  peer,
  name,
  busy,
  setBusy,
  labels,
  confirmLabels,
}: {
  peer: string;
  name: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  labels: Labels;
  confirmLabels: ConfirmLabels;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [asking, setAsking] = useState(false);

  async function forgetContact() {
    setBusy(true);
    // A blank name would render as an empty heading where the number was, so
    // an emptied field removes the record instead of storing nothing.
    await fetch("/v1/messages/contact", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer }),
    });
    setBusy(false);
    setAsking(false);
    setEditing(false);
    router.refresh();
  }

  async function rename(trimmed: string) {
    setBusy(true);
    await fetch("/v1/messages/contact", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer, name: trimmed }),
    });
    setBusy(false);
    setEditing(false);
    router.refresh();
  }

  function save() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setAsking(true);
      return;
    }
    void rename(trimmed);
  }

  if (!editing) {
    return (
      <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
        {name ? labels.renameContact : labels.nameContact}
      </Button>
    );
  }
  return (
    <>
      <ButtonRow>
        <Input
          type="text"
          value={draft}
          maxLength={128}
          placeholder={labels.contactName}
          aria-label={labels.contactName}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button variant="ghost" disabled={busy} onClick={save}>
          {labels.save}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setDraft(name);
            setEditing(false);
          }}
        >
          {labels.cancel}
        </Button>
      </ButtonRow>

      <ConfirmDialog
        open={asking}
        title={interpolate(labels.confirmForgetContactTitle, { peer })}
        consequence={interpolate(labels.confirmForgetContact, { peer })}
        labels={confirmLabels}
        confirmLabel={labels.remove}
        busy={busy}
        onConfirm={() => void forgetContact()}
        onCancel={() => setAsking(false)}
      />
    </>
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
 *
 * The tone table moved to `toneForDeliveryStatus` in `lib/tokens.ts`, where a
 * test can read it. `StateBadge` is the wrong primitive here and it looked like
 * the right one: it runs the word through `toneForState`, which knows seven
 * modem states and none of these, so every badge would have come back neutral.
 */
function DeliveryBadge({ message, labels }: { message: ThreadMessage; labels: Labels }) {
  return (
    <span>
      <Badge tone={toneForDeliveryStatus(message.status)}>
        {labels[`status.${message.status}`] ?? message.status}
      </Badge>
      {/* When the network says it handed the message over. This is the
          discharge time from the report, not when the report reached us. */}
      {message.status === "delivered" && message.deliveredAt ? (
        <span className={INBOX.metaTime}>
          {" "}
          {new Date(message.deliveredAt).toISOString().replace("T", " ").slice(5, 16)}
        </span>
      ) : null}
      {/* Why it failed is the half that says what to do about it. */}
      {message.failureReason ? (
        <span className={INBOX.metaDetail}> — {message.failureReason}</span>
      ) : null}
    </span>
  );
}
