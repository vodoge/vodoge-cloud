import { LiveReload } from "@/components/live-reload";
import { SendSmsForm } from "@/components/send-sms";
import { Card, EmptyState } from "@/components/ui";
import Link from "next/link";
import {
  fetchContacts,
  fetchDevices,
  fetchThreads,
  type ContactRow,
  type ThreadRow,
} from "@/lib/catalog";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function InboxPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
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
  const unread = threads.reduce((total, thread) => total + thread.unread, 0);

  return (
    <>
      <LiveReload />
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("inbox.title", locale)}</h1>
          <p className="page-desc">{t("inbox.desc", locale)}</p>
        </div>
        <div>
          {unread > 0 ? (
            <span className="badge badge-warn">
              {unread} {t("inbox.unread", locale)}
            </span>
          ) : null}
        </div>
      </div>
      {loadError ? <p className="danger">{t("inbox.loadError", locale)}</p> : null}

      <div className="grid grid-wide">
        <Card className="card-span-all" title={t("inbox.send", locale)}>
          <SendSmsForm
            devices={devices}
            labels={{
              device: t("inbox.colDevice", locale),
              to: t("inbox.colPeer", locale),
              body: t("inbox.colBody", locale),
              send: t("inbox.send", locale),
              queued: t("inbox.queued", locale),
              failed: t("inbox.sendFailed", locale),
            }}
          />
        </Card>

        {/* The phone book. Separate from the thread list because a contact
            can exist without a conversation -- a number named before anyone
            has written to it is the ordinary case for a new SIM -- and a
            list derived from messages could never show one. */}
        <Card
          className="card-span-all"
          title={t("inbox.contacts", locale)}
          note={t("inbox.contactsNote", locale)}
          bodyless
        >
          {contacts.length === 0 ? (
            <EmptyState
              title={t("empty.contacts.title", locale)}
              desc={t("empty.contacts.desc", locale)}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("inbox.contactName", locale)}</th>
                    <th>{t("inbox.colPeer", locale)}</th>
                    <th>{t("inbox.colUnread", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((contact) => {
                    const thread = threads.find((row) => row.peer === contact.peer);
                    return (
                      <tr key={contact.peer}>
                        <td>
                          <Link href={`/inbox/${encodeURIComponent(contact.peer)}`}>
                            {contact.name}
                          </Link>
                        </td>
                        <td className="mono faint">{contact.peer}</td>
                        <td>
                          {thread && thread.unread > 0 ? (
                            <span className="badge badge-warn">{thread.unread}</span>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          className="card-span-all"
          title={t("inbox.threads", locale)}
          note={t("inbox.threadsNote", locale)}
          bodyless
        >
          {threads.length === 0 ? (
            <EmptyState
              title={t("empty.messages.title", locale)}
              desc={t("empty.messages.desc", locale)}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("inbox.colPeer", locale)}</th>
                    <th>{t("inbox.colLast", locale)}</th>
                    <th>{t("inbox.messages", locale)}</th>
                    <th>{t("inbox.colReceived", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {threads.map((thread) => (
                    <tr key={thread.peer}>
                      <td className={thread.name ? "" : "mono"}>
                        <Link href={`/inbox/${encodeURIComponent(thread.peer)}`}>
                          {thread.name || thread.peer}
                        </Link>
                        {thread.name ? (
                          <div className="mono faint">{thread.peer}</div>
                        ) : null}
                      </td>
                      <td>
                        {/* Which way the last message went is what says
                            whether this conversation is waiting on you. */}
                        <span className="faint">{thread.lastInbound ? "← " : "→ "}</span>
                        {/* Unread is emphasised rather than badged alone: the
                            body is what the operator is scanning, and a count
                            in another column does not make it stand out. */}
                        <span className={thread.unread > 0 ? "" : "faint"}>{thread.lastBody}</span>
                      </td>
                      <td>
                        {thread.messages}
                        {thread.unread > 0 ? (
                          <span className="badge badge-warn" style={{ marginLeft: "var(--s2)" }}>
                            {thread.unread} {t("inbox.unread", locale)}
                          </span>
                        ) : null}
                        {thread.unsent > 0 ? (
                          <span className="badge badge-bad" style={{ marginLeft: "var(--s2)" }}>
                            {thread.unsent} {t("inbox.unsent", locale)}
                          </span>
                        ) : null}
                      </td>
                      <td className="mono faint">
                        {new Date(thread.lastAt).toISOString().replace("T", " ").slice(0, 19)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
