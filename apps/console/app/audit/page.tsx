import { Card, EmptyState } from "@/components/ui";
import { fetchAudit, type AuditRow } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

export default async function AuditPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let events: AuditRow[] = [];
  let loadError = false;
  try {
    events = await fetchAudit(host, token);
  } catch {
    loadError = true;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("audit.title", locale)}</h1>
          <p className="page-desc">{t("audit.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className="danger">{t("audit.loadError", locale)}</p> : null}

      <Card bodyless>
        {events.length === 0 ? (
          <EmptyState
            title={t("empty.audit.title", locale)}
            desc={t("empty.audit.desc", locale)}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("audit.colActor", locale)}</th>
                  <th>{t("audit.colAction", locale)}</th>
                  <th>{t("audit.colTarget", locale)}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, index) => (
                  <tr key={`${event.action}:${index}`}>
                    <td className="mono">{event.actor || "—"}</td>
                    <td>{event.action}</td>
                    <td className="mono faint">{event.target || "—"}</td>
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
