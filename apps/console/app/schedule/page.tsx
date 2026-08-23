import { Card, EmptyState, StateBadge } from "@/components/ui";
import { fetchSchedules, type ScheduleRow } from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

/**
 * Read-only on purpose, for now.
 *
 * The page has to be server-rendered so the list is in the HTML: a schedule is
 * the kind of thing an operator checks by looking, and a client-rendered table
 * cannot be checked by fetching the page. Adding a create form would mean a
 * client component, and this feature's own tests are worth more than a form
 * that duplicates what `POST /v1/schedules` already validates and audits.
 */

/** A cadence read as "every two hours" rather than as 7200. */
function cadence(seconds: number, locale: Locale): string {
  if (seconds <= 0) return "—";
  if (seconds % 86400 === 0) {
    return t("schedule.everyDays", locale, { n: seconds / 86400 });
  }
  if (seconds % 3600 === 0) {
    return t("schedule.everyHours", locale, { n: seconds / 3600 });
  }
  return t("schedule.everyMinutes", locale, { n: Math.round(seconds / 60) });
}

function moment(value: number | null, locale: Locale): string {
  if (!value) return t("schedule.never", locale);
  return new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-GB", {
    timeZone: "Asia/Shanghai",
  });
}

/**
 * What the task acts on, in the terms it was configured with.
 *
 * A card schedule shows the ICCID because that is the thing being kept alive --
 * showing the module it happens to be in today would hide the fact that the
 * target is re-resolved on every run.
 */
function target(row: ScheduleRow, locale: Locale): string {
  if (row.selector.mode === "card" && row.selector.iccid) {
    return `${t("schedule.card", locale)} ${row.selector.iccid}`;
  }
  if (row.selector.mode === "device" && row.selector.deviceId) {
    const suffix = row.selector.modemImei ? ` / ${row.selector.modemImei}` : "";
    return `${t("schedule.device", locale)} ${row.selector.deviceId}${suffix}`;
  }
  return row.selector.mode;
}

/**
 * Only "issued" and "checked" are successes. Everything else is amber rather
 * than red, because a preparation failure is retried and a stale skip is the
 * system behaving correctly after an outage -- painting either as a fault would
 * train the reader to ignore the colour.
 */
function statusTone(status: string | null): string {
  if (!status) return "unknown";
  if (status === "issued" || status === "checked") return "online";
  // "busy" is the warn tone the badge palette already has; inventing a new
  // state string here would fall through to neutral and say nothing.
  return "busy";
}

export default async function SchedulePage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let schedules: ScheduleRow[] = [];
  let loadError = false;
  try {
    schedules = await fetchSchedules(host, token);
  } catch {
    loadError = true;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("schedule.title", locale)}</h1>
          <p className="page-desc">{t("schedule.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className="danger">{t("schedule.loadError", locale)}</p> : null}

      <Card bodyless>
        {schedules.length === 0 ? (
          <EmptyState
            title={t("empty.schedule.title", locale)}
            desc={t("empty.schedule.desc", locale)}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("schedule.colName", locale)}</th>
                  <th>{t("schedule.colAction", locale)}</th>
                  <th>{t("schedule.colTarget", locale)}</th>
                  <th>{t("schedule.colCadence", locale)}</th>
                  <th>{t("schedule.colNextDue", locale)}</th>
                  <th>{t("schedule.colLastRun", locale)}</th>
                  <th>{t("schedule.colLastResult", locale)}</th>
                  <th>{t("schedule.colEnabled", locale)}</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td className="mono">
                      {row.action === "public_ip_check"
                        ? t("schedule.actionPublicIp", locale)
                        : (row.commandKind ?? row.action)}
                    </td>
                    <td className="mono faint">{target(row, locale)}</td>
                    <td>{cadence(row.intervalSeconds, locale)}</td>
                    <td>{row.enabled ? moment(row.nextDueAt, locale) : "—"}</td>
                    <td>{moment(row.lastRunAt, locale)}</td>
                    <td>
                      {row.lastStatus ? (
                        <>
                          <StateBadge
                            state={statusTone(row.lastStatus)}
                            label={t(`schedule.status.${row.lastStatus}`, locale)}
                          />
                          {row.lastDetail ? (
                            <div className="mono faint">{row.lastDetail}</div>
                          ) : null}
                        </>
                      ) : (
                        <span className="faint">{t("schedule.never", locale)}</span>
                      )}
                    </td>
                    <td>
                      <StateBadge
                        state={row.enabled ? "online" : "offline"}
                        label={t(row.enabled ? "schedule.on" : "schedule.off", locale)}
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
