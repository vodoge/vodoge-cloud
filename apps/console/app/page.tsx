import { LiveReload } from "@/components/live-reload";
import { fetchDevices, type DeviceRow } from "@/lib/catalog";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function DevicesPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let devices: DeviceRow[] = [];
  let loadError = false;
  try {
    devices = await fetchDevices(host, token);
  } catch {
    loadError = true;
  }

  return (
    <section>
      <LiveReload />
      <h1 className="page-title">{t("devices.title", locale)}</h1>
      <p className="page-desc">{t("devices.desc", locale)}</p>
      {loadError ? <p className="danger">{t("devices.loadError", locale)}</p> : null}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("devices.colName", locale)}</th>
              <th>{t("devices.colId", locale)}</th>
              <th>{t("devices.colState", locale)}</th>
              <th>{t("devices.colLastSeen", locale)}</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty">
                  {t("devices.empty", locale)}
                </td>
              </tr>
            ) : (
              devices.map((device) => (
                <tr key={device.id}>
                  <td>{device.name}</td>
                  <td>{device.id}</td>
                  <td>{device.state}</td>
                  <td>{device.lastSeen ? new Date(device.lastSeen).toISOString() : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="hint">{devices.length === 0 ? t("devices.emptyHint", locale) : t("devices.liveHint", locale)}</p>
    </section>
  );
}
