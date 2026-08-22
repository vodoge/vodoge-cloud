import { Card, EmptyState, StateBadge } from "@/components/ui";
import { fetchRules, type RuleRow } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

export default async function RulesPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let rules: RuleRow[] = [];
  let loadError = false;
  try {
    rules = await fetchRules(host, token);
  } catch {
    loadError = true;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("rules.title", locale)}</h1>
          <p className="page-desc">{t("rules.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className="danger">{t("rules.loadError", locale)}</p> : null}

      <Card bodyless>
        {rules.length === 0 ? (
          <EmptyState
            title={t("empty.rules.title", locale)}
            desc={t("empty.rules.desc", locale)}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("rules.colName", locale)}</th>
                  <th>{t("rules.colId", locale)}</th>
                  <th>{t("rules.colEnabled", locale)}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.name}</td>
                    <td className="mono faint">{rule.id}</td>
                    <td>
                      <StateBadge
                        state={rule.enabled ? "online" : "offline"}
                        label={t(rule.enabled ? "rules.on" : "rules.off", locale)}
                      />
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
