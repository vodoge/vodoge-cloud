import { t } from "@/lib/i18n";
import { gatewayBaseUrl } from "@/lib/tenant.ts";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost } from "@/lib/tenant-headers";

type AuditRow = { actor: string; action: string; target: string };

export default async function AuditPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  let events: AuditRow[] = [];
  let loadError = false;
  try {
    const response = await fetch(`${gatewayBaseUrl()}/v1/audit`, {
      headers: { accept: "application/json", "x-forwarded-host": host },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) {
      const body = (await response.json()) as { events?: AuditRow[] };
      events = body.events ?? [];
    }
  } catch {
    loadError = true;
  }

  return (
    <section>
      <h1 className="page-title">{t("audit.title", locale)}</h1>
      <p className="page-desc">{t("audit.desc", locale)}</p>
      {loadError ? <p className="danger">{t("audit.loadError", locale)}</p> : null}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("audit.colActor", locale)}</th>
              <th>{t("audit.colAction", locale)}</th>
              <th>{t("audit.colTarget", locale)}</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={3} className="empty">
                  {t("audit.empty", locale)}
                </td>
              </tr>
            ) : (
              events.map((event, index) => (
                <tr key={`${event.action}-${index}`}>
                  <td>{event.actor}</td>
                  <td>{event.action}</td>
                  <td>{event.target}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
