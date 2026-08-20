import { t } from "@/lib/i18n";
import { gatewayBaseUrl } from "@/lib/tenant.ts";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost } from "@/lib/tenant-headers";

type RuleRow = { id: string; name: string; enabled: boolean };

export default async function RulesPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  let rules: RuleRow[] = [];
  let loadError = false;
  try {
    const response = await fetch(`${gatewayBaseUrl()}/v1/rules`, {
      headers: { accept: "application/json", "x-forwarded-host": host },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) {
      const body = (await response.json()) as { rules?: RuleRow[] };
      rules = body.rules ?? [];
    }
  } catch {
    loadError = true;
  }

  return (
    <section>
      <h1 className="page-title">{t("rules.title", locale)}</h1>
      <p className="page-desc">{t("rules.desc", locale)}</p>
      {loadError ? <p className="danger">{t("rules.loadError", locale)}</p> : null}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("rules.colName", locale)}</th>
              <th>{t("rules.colEnabled", locale)}</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={2} className="empty">
                  {t("rules.empty", locale)}
                </td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.name}</td>
                  <td>{rule.enabled ? "yes" : "no"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
