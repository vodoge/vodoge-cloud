import Link from "next/link";
import { LiveReload } from "@/components/live-reload";
import { SendSmsForm, type SendDevice } from "@/components/send-sms";
import { Badge } from "@/components/ui/badge";
import { CardEmpty, CardPanel as Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import {
  fetchContacts,
  fetchDevices,
  fetchModems,
  fetchThreads,
  type ContactRow,
  type ThreadRow,
} from "@/lib/catalog";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import {
  bearerHeader,
  mayWrite,
  roleFromSessionBody,
  SESSION_ENDPOINT,
  type ConsoleRole,
} from "@/lib/session";
import { blockedSendModules } from "@/lib/sms-safety";
import { gatewayBaseUrl } from "@/lib/tenant";
import { INBOX, PAGE } from "@/lib/tokens";

/**
 * The inbox: send a message, name a number, open a conversation.
 *
 * This is the page that gets installed on a phone, so it is the one where the
 * narrow-screen decisions have to actually hold. The three cards stack rather
 * than sitting in a grid — all three were `card-span-all` in the old layout,
 * which is a grid of one column written the long way round.
 *
 * ## The module the send form will not use
 *
 * `/v1/commands` takes a `device_id` and no module, so which module carries a
 * message is decided at the edge — and with nothing to aim it, the edge takes
 * the first entry out of its modem map. One module in this fleet leaves the USB
 * bus on every MO submit (`SMS_BLOCKED_MODULES` in `lib/sms-safety.ts`), so the
 * device holding it is a device this page cannot promise anything about. That
 * is why the module list is read here at all: without it the refusal has
 * nothing to match against, and the operator finds out by losing a module.
 *
 * Its own `try`, deliberately. Folding it into the one below would turn a
 * failed module read into "could not load messages", and leaving it out of a
 * `try` altogether would turn it into a page that does not render.
 *
 * ⚠️ **A failed read now holds the send** rather than leaving it live with a
 * note. That is a change of behaviour and the reasoning is in `sendHold`.
 *
 * ## The read-only gate, which this page did not have
 *
 * It has one now, copied from `app/settings/page.tsx` rather than invented:
 * the same `GET /v1/auth/session`, the same `mayWrite`, the same fail-closed
 * `catch`. Until this card the page drew the send form for every account, and
 * `viewer@vodoge.com` could fill it in — the gateway refused the POST at its
 * one read-only chokepoint (`cmd/gateway/main.go:858`), so nothing was ever
 * sent by an account that may not send. This is not a hole being closed. It is
 * a control being taken off the screen because the server was always going to
 * say no to it, which is courtesy rather than a permission model; the model is
 * the gateway's, and `/v1` is reachable with curl and a token whatever this
 * page draws.
 */
export default async function InboxPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  const writable = mayWrite(await currentRole(host, token));
  let threads: ThreadRow[] = [];
  let contacts: ContactRow[] = [];
  let devices: { id: string; name: string }[] = [];
  let loadError = false;
  try {
    threads = await fetchThreads(host, token);
    contacts = await fetchContacts(host, token);
    devices = (await fetchDevices(host, token)).map((device) => ({
      id: device.id,
      name: device.name,
    }));
  } catch {
    loadError = true;
  }

  let modems: { deviceId: string; imei: string }[] = [];
  let modemsUnknown = false;
  try {
    modems = await fetchModems(host, token);
  } catch {
    // Empty and "not read" are the same array, so the difference is carried
    // beside it. The audit page shipped that bug for months.
    modemsUnknown = true;
  }

  const sendDevices: SendDevice[] = devices.map((device) => ({
    ...device,
    blocked: blockedSendModules(modems, device.id).map((module) => ({
      imei: module.imei,
      why: t(module.why, locale, { imei: module.imei }),
      cost: t(module.cost, locale),
    })),
  }));

  const unread = threads.reduce((total, thread) => total + thread.unread, 0);

  return (
    <>
      <LiveReload />
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("inbox.title", locale)}</h1>
          <p className={PAGE.description}>{t("inbox.desc", locale)}</p>
        </div>
        <div className={PAGE.actions}>
          {unread > 0 ? (
            <Badge tone="warn" dot={false}>
              {unread} {t("inbox.unread", locale)}
            </Badge>
          ) : null}
          {writable ? null : (
            <Badge tone="warn" dot={false}>
              {t("role.readOnlyBadge", locale)}
            </Badge>
          )}
        </div>
      </div>
      {loadError ? <p className={PAGE.error}>{t("inbox.loadError", locale)}</p> : null}

      <div className={PAGE.stack}>
        {/* Read-only keeps the card and loses the form. Hiding the whole card
            would take away the answer to "why is there nowhere to send from";
            a paragraph in its place says which of the two it is. The same
            shape as the settings page, which renders values where a read-only
            account would otherwise get a Save button that can only 403. */}
        <Card title={t("inbox.send", locale)}>
          {writable ? (
            <SendSmsForm
              devices={sendDevices}
              modemsUnknown={modemsUnknown}
              confirmLabels={{
                question: t("confirm.question", locale),
                proceed: t("confirm.proceed", locale),
                cancel: t("confirm.cancel", locale),
              }}
              labels={{
                device: t("inbox.colDevice", locale),
                to: t("inbox.colPeer", locale),
                body: t("inbox.colBody", locale),
                send: t("inbox.send", locale),
                queued: t("inbox.queued", locale),
                failed: t("inbox.sendFailed", locale),
                blockedBadge: t("inbox.sendBlockedBadge", locale),
                blockedTitle: t("inbox.sendBlockedTitle", locale),
                blockedDevice: t("inbox.sendBlockedDevice", locale),
                modemsUnknownTitle: t("inbox.smsModemsUnknownTitle", locale),
                modemsUnknown: t("inbox.smsModemsUnknown", locale),
                // Templates: the number and the device are only known once the
                // operator has typed one and chosen the other.
                confirmTitle: t("inbox.confirmSendTitle", locale),
                confirmConsequence: t("inbox.confirmSend", locale),
              }}
            />
          ) : (
            <p className={INBOX.note}>{t("role.readOnlyInbox", locale)}</p>
          )}
        </Card>

        {/* The phone book. Separate from the thread list because a contact
            can exist without a conversation -- a number named before anyone
            has written to it is the ordinary case for a new SIM -- and a
            list derived from messages could never show one. */}
        <Card
          title={t("inbox.contacts", locale)}
          note={t("inbox.contactsNote", locale)}
          bodyless
        >
          {contacts.length === 0 ? (
            <CardEmpty
              title={t("empty.contacts.title", locale)}
              description={t("empty.contacts.desc", locale)}
            />
          ) : (
            <Table>
              <TableHead>
                <TableRow head>
                  <TableHeaderCell>{t("inbox.contactName", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("inbox.colPeer", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("inbox.colUnread", locale)}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {contacts.map((contact) => {
                  const thread = threads.find((row) => row.peer === contact.peer);
                  return (
                    <TableRow key={contact.peer}>
                      <TableCell>
                        <Link href={`/inbox/${encodeURIComponent(contact.peer)}`}>
                          {contact.name}
                        </Link>
                      </TableCell>
                      <TableCell mono faint>
                        {contact.peer}
                      </TableCell>
                      <TableCell>
                        {thread && thread.unread > 0 ? (
                          <Badge tone="warn" dot={false}>
                            {thread.unread}
                          </Badge>
                        ) : (
                          <span className={INBOX.lastRead}>—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card title={t("inbox.threads", locale)} note={t("inbox.threadsNote", locale)} bodyless>
          {threads.length === 0 ? (
            <CardEmpty
              title={t("empty.messages.title", locale)}
              description={t("empty.messages.desc", locale)}
            />
          ) : (
            <Table>
              <TableHead>
                <TableRow head>
                  <TableHeaderCell>{t("inbox.colPeer", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("inbox.colLast", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("inbox.messages", locale)}</TableHeaderCell>
                  {/* The timestamp is context rather than the answer, and it
                      is the widest fixed column. It drops on a phone; the
                      three that say who wrote, what they said and whether it
                      is waiting on you do not. */}
                  <TableHeaderCell secondary>{t("inbox.colReceived", locale)}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {threads.map((thread) => (
                  <TableRow key={thread.peer}>
                    <TableCell mono={!thread.name}>
                      <Link href={`/inbox/${encodeURIComponent(thread.peer)}`}>
                        {thread.name || thread.peer}
                      </Link>
                      {thread.name ? (
                        <div className={INBOX.peerUnder}>{thread.peer}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className={INBOX.lastBody}>
                      {/* Which way the last message went is what says
                          whether this conversation is waiting on you. */}
                      <span className={INBOX.lastDirection}>
                        {thread.lastInbound ? "← " : "→ "}
                      </span>
                      {/* Unread is emphasised rather than badged alone: the
                          body is what the operator is scanning, and a count
                          in another column does not make it stand out. */}
                      <span className={thread.unread > 0 ? INBOX.lastUnread : INBOX.lastRead}>
                        {thread.lastBody}
                      </span>
                    </TableCell>
                    <TableCell>
                      {/* A `<span>` rather than the cell itself: `display:
                          flex` on a `<td>` takes it out of the table layout
                          and the browser puts an anonymous cell back. */}
                      <span className={INBOX.countCell}>
                        {thread.messages}
                        {thread.unread > 0 ? (
                          <Badge tone="warn" dot={false}>
                            {thread.unread} {t("inbox.unread", locale)}
                          </Badge>
                        ) : null}
                        {thread.unsent > 0 ? (
                          <Badge tone="bad" dot={false}>
                            {thread.unsent} {t("inbox.unsent", locale)}
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell mono faint secondary>
                      {new Date(thread.lastAt).toISOString().replace("T", " ").slice(0, 19)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * The role for this request, from the gateway.
 *
 * Failing closed. If the gateway cannot be asked, the page draws its read-only
 * self: the account may lose a send form it was entitled to, which is
 * recoverable by reloading, and the gateway is the thing that actually decides.
 *
 * ⚠️ Copied from `app/settings/page.tsx`, which had the only correct gate in
 * this console when this card started, and copied rather than adapted so the
 * two cannot drift into two different ideas of what "cannot ask" means. There
 * are three of these now — settings, here, and `app/inbox/[peer]/page.tsx` —
 * and it belongs in `lib/session.ts` beside `mayWrite`. No card has owned that
 * file yet; `lib/tokens.test.ts` holds all three to the same two returns until
 * one does.
 */
async function currentRole(host: string, token: string | undefined): Promise<ConsoleRole> {
  try {
    const response = await fetch(`${gatewayBaseUrl()}${SESSION_ENDPOINT}`, {
      headers: {
        accept: "application/json",
        "x-forwarded-host": host,
        ...bearerHeader(token),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return "readonly";
    return roleFromSessionBody(await response.json());
  } catch {
    return "readonly";
  }
}
