import { LiveReload } from "@/components/live-reload";
import { SendSmsForm } from "@/components/send-sms";
import { Card, EmptyState } from "@/components/ui";
import Link from "next/link";
import { fetchDevices, fetchThreads, type ThreadRow } from "@/lib/catalog";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function InboxPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let threads: ThreadRow[] = [];
  let devices: { id: string; name: string }[] = [];
  let loadError = false;
  try {
    threads = await fetchThreads(host, token);
    devices = (await fetchDevices(host, token)).map((device) => ({
      id: device.id,
      name: device.name,
    }));
  } catch {
    loadError = true;
  }

  return (
    <>
      <LiveReload />
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("inbox.title", locale)}</h1>
          <p className="page-desc">{t("inbox.desc", locale)}</p>
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
                      <td className="mono">
                        <Link href={`/inbox/${encodeURIComponent(thread.peer)}`}>
                          {thread.peer}
                        </Link>
                      </td>
                      <td>
                        {/* Which way the last message went is what says
                            whether this conversation is waiting on you. */}
                        <span className="faint">{thread.lastInbound ? "← " : "→ "}</span>
                        {thread.lastBody}
                      </td>
                      <td>
                        {thread.messages}
                        {thread.unsent > 0 ? (
                          <span className="badge badge-warn" style={{ marginLeft: "var(--s2)" }}>
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
