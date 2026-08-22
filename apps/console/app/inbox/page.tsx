import { LiveReload } from "@/components/live-reload";
import { SendSmsForm } from "@/components/send-sms";
import { Card, EmptyState } from "@/components/ui";
import { fetchDevices, fetchMessages, type MessageRow } from "@/lib/catalog";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function InboxPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let messages: MessageRow[] = [];
  let devices: { id: string; name: string }[] = [];
  let loadError = false;
  try {
    messages = await fetchMessages(host, token);
    devices = (await fetchDevices(host, token)).map((device) => ({
      id: device.id,
      name: device.name,
    }));
  } catch {
    loadError = true;
  }

  // Newest first. A message list ordered by arrival makes the reader scroll to
  // find what just happened, which is the only thing they usually want.
  const ordered = [...messages].sort((left, right) => right.receivedAt - left.receivedAt);

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
          title={t("inbox.title", locale)}
          note={t("overview.recentNote", locale)}
          bodyless
        >
          {ordered.length === 0 ? (
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
                    <th>{t("inbox.colBody", locale)}</th>
                    <th>{t("inbox.colBearer", locale)}</th>
                    <th>{t("inbox.colDevice", locale)}</th>
                    <th>{t("inbox.colReceived", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((message) => (
                    <tr key={message.id}>
                      <td className="mono">{message.peer}</td>
                      <td>{message.body}</td>
                      <td>
                        <span className="badge badge-info">{message.bearer}</span>
                      </td>
                      <td className="mono faint">{message.deviceId}</td>
                      <td className="mono faint">
                        {new Date(message.receivedAt)
                          .toISOString()
                          .replace("T", " ")
                          .slice(0, 19)}
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
