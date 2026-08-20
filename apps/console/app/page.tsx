import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

type DeviceRow = {
  id: string;
  name: string;
  state: string;
  lastSeen: number | null;
};

export default async function DevicesPage() {
  const locale = await getRequestLocale();
  const devices: DeviceRow[] = [];

  return (
    <section>
      <h1 className="page-title">{t("devices.title", locale)}</h1>
      <p className="page-desc">{t("devices.desc", locale)}</p>
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
      <p className="hint">{t("devices.emptyHint", locale)}</p>
    </section>
  );
}
