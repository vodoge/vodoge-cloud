import { LiveReload } from "@/components/live-reload";
import { Card, EmptyState } from "@/components/ui";
import { fetchSessions, type SessionRow } from "@/lib/catalog";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function SessionsPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let sessions: SessionRow[] = [];
  let loadError = false;
  try {
    sessions = await fetchSessions(host, token);
  } catch {
    loadError = true;
  }

  return (
    <>
      <LiveReload />
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("sessions.title", locale)}</h1>
          <p className="page-desc">{t("sessions.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className="danger">{t("sessions.loadError", locale)}</p> : null}

      <Card bodyless>
        {sessions.length === 0 ? (
          <EmptyState
            title={t("empty.sessions.title", locale)}
            desc={t("empty.sessions.desc", locale)}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("sessions.colPeer", locale)}</th>
                  <th>{t("sessions.colCount", locale)}</th>
                  <th>{t("sessions.colLastBody", locale)}</th>
                  <th>{t("sessions.colLastReceived", locale)}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((row) => (
                  <tr key={`${row.deviceId}:${row.peer}`}>
                    <td className="mono">{row.peer}</td>
                    <td className="mono">{row.count}</td>
                    <td>{row.lastBody}</td>
                    <td className="mono faint">
                      {new Date(row.lastReceivedAt).toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
