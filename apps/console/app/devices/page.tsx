import { Card, EmptyState, StateBadge } from "@/components/ui";
import { fetchDevices, type DeviceRow } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

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
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("devices.title", locale)}</h1>
          <p className="page-desc">{t("devices.desc", locale)}</p>
        </div>
      </div>

      {loadError ? <p className="danger">{t("devices.loadError", locale)}</p> : null}

      <Card bodyless>
        {devices.length === 0 ? (
          <EmptyState
            title={t("empty.devices.title", locale)}
            desc={t("empty.devices.desc", locale)}
          />
        ) : (
          <div className="table-wrap">
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
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td>{device.name}</td>
                    <td className="mono faint">{device.id}</td>
                    <td>
                      <StateBadge
                        state={device.state}
                        label={t(`state.${device.state}`, locale)}
                      />
                    </td>
                    <td className="mono faint">
                      {device.lastSeen
                        ? new Date(device.lastSeen).toISOString().replace("T", " ").slice(0, 19)
                        : t("common.never", locale)}
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
