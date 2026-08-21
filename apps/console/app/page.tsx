import Link from "next/link";
import { Card, EmptyState, StatCard } from "@/components/ui";
import { fetchDevices, fetchMessages, fetchSessions, type DeviceRow } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

/**
 * The landing page answers "is anything wrong, and what just happened".
 *
 * It leads with a few numbers that prove the fleet is working, then one list of
 * recent activity. Everything else is a click away: a home that renders every
 * table is one nobody reads.
 */
export default async function OverviewPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();

  let devices: DeviceRow[] = [];
  let messages: Awaited<ReturnType<typeof fetchMessages>> = [];
  let peers = 0;
  let loadError = false;
  try {
    [devices, messages, peers] = await Promise.all([
      fetchDevices(host, token),
      fetchMessages(host, token),
      fetchSessions(host, token).then((rows) => rows.length),
    ]);
  } catch {
    loadError = true;
  }

  const online = devices.filter((device) => device.state === "online").length;
  const recent = [...messages]
    .sort((left, right) => right.receivedAt - left.receivedAt)
    .slice(0, 8);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("overview.title", locale)}</h1>
          <p className="page-desc">{t("overview.desc", locale)}</p>
        </div>
      </div>

      {loadError ? <p className="danger">{t("inbox.loadError", locale)}</p> : null}

      <div className="grid">
        <StatCard
          label={t("overview.devices", locale)}
          value={online}
          hint={t("overview.devicesHint", locale, { total: devices.length })}
          tone={devices.length === 0 ? undefined : online === devices.length ? "ok" : "warn"}
        />
        <StatCard
          label={t("overview.messages", locale)}
          value={messages.length}
          hint={t("overview.messagesHint", locale)}
        />
        <StatCard
          label={t("overview.peers", locale)}
          value={peers}
          hint={t("overview.peersHint", locale)}
        />
      </div>

      <div className="grid grid-wide" style={{ marginTop: "var(--s4)" }}>
        <Card
          className="card-span-all"
          title={t("overview.recent", locale)}
          note={t("overview.recentNote", locale)}
          actions={
            <Link className="button ghost" href="/inbox">
              {t("overview.seeAll", locale)}
            </Link>
          }
        >
          {recent.length === 0 ? (
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
                    <th>{t("inbox.colReceived", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((message) => (
                    <tr key={message.id}>
                      <td className="mono">{message.peer}</td>
                      <td>{message.body}</td>
                      <td>
                        <span className="badge badge-info">{message.bearer}</span>
                      </td>
                      <td className="mono faint">
                        {new Date(message.receivedAt).toISOString().replace("T", " ").slice(0, 19)}
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
