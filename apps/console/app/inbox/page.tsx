import { LiveReload } from "@/components/live-reload";
import { fetchMessages, type MessageRow } from "@/lib/catalog";
import { requestHost } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function InboxPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  let messages: MessageRow[] = [];
  let loadError = false;
  try {
    messages = await fetchMessages(host);
  } catch {
    loadError = true;
  }

  return (
    <section>
      <LiveReload />
      <h1 className="page-title">{t("inbox.title", locale)}</h1>
      <p className="page-desc">{t("inbox.desc", locale)}</p>
      {loadError ? <p className="danger">{t("inbox.loadError", locale)}</p> : null}
      <div className="panel">
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
            {messages.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  {t("inbox.empty", locale)}
                </td>
              </tr>
            ) : (
              messages.map((message) => (
                <tr key={message.id}>
                  <td>{message.peer}</td>
                  <td>{message.body}</td>
                  <td>{message.bearer}</td>
                  <td>{message.deviceId}</td>
                  <td>{new Date(message.receivedAt).toISOString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {messages.length === 0 ? <p className="hint">{t("inbox.emptyHint", locale)}</p> : null}
    </section>
  );
}
