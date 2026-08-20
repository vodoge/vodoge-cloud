import { LiveReload } from "@/components/live-reload";
import { fetchSessions, type SessionRow } from "@/lib/catalog";
import { requestHost } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function SessionsPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  let sessions: SessionRow[] = [];
  let loadError = false;
  try {
    sessions = await fetchSessions(host);
  } catch {
    loadError = true;
  }

  return (
    <section>
      <LiveReload />
      <h1 className="page-title">{t("sessions.title", locale)}</h1>
      <p className="page-desc">{t("sessions.desc", locale)}</p>
      {loadError ? <p className="danger">{t("sessions.loadError", locale)}</p> : null}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("sessions.colPeer", locale)}</th>
              <th>{t("sessions.colCount", locale)}</th>
              <th>{t("sessions.colLast", locale)}</th>
              <th>{t("sessions.colDevice", locale)}</th>
              <th>{t("sessions.colReceived", locale)}</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  {t("sessions.empty", locale)}
                </td>
              </tr>
            ) : (
              sessions.map((session) => (
                <tr key={session.peer}>
                  <td>{session.peer}</td>
                  <td>{session.count}</td>
                  <td>{session.lastBody}</td>
                  <td>{session.deviceId}</td>
                  <td>{new Date(session.lastReceivedAt).toISOString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {sessions.length === 0 ? <p className="hint">{t("sessions.emptyHint", locale)}</p> : null}
    </section>
  );
}
