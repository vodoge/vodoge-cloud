import { StateBadge } from "@/components/ui/badge";
import { Card, CardEmpty } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { fetchSchedules, type ScheduleRow } from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { PAGE, TABLE } from "@/lib/tokens";

/**
 * Read-only on purpose, for now.
 *
 * The page has to be server-rendered so the list is in the HTML: a schedule is
 * the kind of thing an operator checks by looking, and a client-rendered table
 * cannot be checked by fetching the page. Adding a create form would mean a
 * client component, and this feature's own tests are worth more than a form
 * that duplicates what `POST /v1/schedules` already validates and audits.
 *
 * Moved onto the design system. The fetch, the failure case, the empty case and
 * the four helpers below are untouched: the page reads nothing new and still
 * writes nothing, so what changed is the way it looks.
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
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("schedule.title", locale)}</h1>
          <p className={PAGE.description}>{t("schedule.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className={PAGE.error}>{t("schedule.loadError", locale)}</p> : null}

      <Card>
        {schedules.length === 0 ? (
          <CardEmpty
            title={t("empty.schedule.title", locale)}
            description={t("empty.schedule.desc", locale)}
          />
        ) : (
          <Table>
            <TableHead>
              {/*
                Eight columns, and the widest table on any read-only page here.
                Three of them are marked `secondary` and leave the phone: the
                target, the cadence and the last run are how a task was set up
                and what it did before, whereas the question this table is
                opened with is "is it on, when does it fire next, and did the
                last one work". The same mark goes on the header cell and the
                body cell of a column, which is what makes the pair drop
                together.
              */}
              <TableRow head>
                <TableHeaderCell>{t("schedule.colName", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("schedule.colAction", locale)}</TableHeaderCell>
                <TableHeaderCell secondary>{t("schedule.colTarget", locale)}</TableHeaderCell>
                <TableHeaderCell secondary>{t("schedule.colCadence", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("schedule.colNextDue", locale)}</TableHeaderCell>
                <TableHeaderCell secondary>{t("schedule.colLastRun", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("schedule.colLastResult", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("schedule.colEnabled", locale)}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {schedules.map((row) => (
                <TableRow key={row.id}>
                  {/*
                    `nowrap`, not `wrap`, and this table is why the pair
                    exists. At 390px eight columns cannot all fit, so every one
                    of them is laid out at its min-content width — and a
                    Chinese label's min-content width is one character, because
                    CJK breaks between any two of them. Measured: 保号短信-移动-每月
                    came out as a vertical strip. These four hold one reading
                    each and are told to stay on one line; the table gets wider
                    and scrolls inside its card, which is what a wide grid is
                    supposed to do.
                  */}
                  <TableCell nowrap>{row.name}</TableCell>
                  <TableCell mono nowrap>
                    {row.action === "public_ip_check"
                      ? t("schedule.actionPublicIp", locale)
                      : (row.commandKind ?? row.action)}
                  </TableCell>
                  <TableCell mono faint secondary>
                    {target(row, locale)}
                  </TableCell>
                  <TableCell secondary nowrap>
                    {cadence(row.intervalSeconds, locale)}
                  </TableCell>
                  <TableCell nowrap>
                    {row.enabled ? moment(row.nextDueAt, locale) : "—"}
                  </TableCell>
                  <TableCell secondary nowrap>
                    {moment(row.lastRunAt, locale)}
                  </TableCell>
                  <TableCell>
                    {row.lastStatus ? (
                      <>
                        <StateBadge
                          state={statusTone(row.lastStatus)}
                          label={t(`schedule.status.${row.lastStatus}`, locale)}
                        />
                        {row.lastDetail ? (
                          <span className={TABLE.cellNote}>{row.lastDetail}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className={TABLE.cellFaint}>{t("schedule.never", locale)}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StateBadge
                      state={row.enabled ? "online" : "offline"}
                      label={t(row.enabled ? "schedule.on" : "schedule.off", locale)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
