import { ProxyManager } from "@/components/proxy-manager";
import { Card, EmptyState } from "@/components/ui";
import {
  fetchCountryRules,
  fetchDevices,
  fetchProxyInstances,
  fetchTraffic,
  fetchUpstreams,
  type CountryRuleRow,
  type DeviceRow,
  type ProxyInstanceRow,
  type TrafficPoint,
  type UpstreamRow,
} from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

export default async function ProxyPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();

  let upstreams: UpstreamRow[] = [];
  let instances: ProxyInstanceRow[] = [];
  let devices: DeviceRow[] = [];
  let traffic: TrafficPoint[] = [];
  let countryRules: CountryRuleRow[] = [];
  let loadError = false;
  try {
    [upstreams, instances, devices, traffic, countryRules] = await Promise.all([
      fetchUpstreams(host, token),
      fetchProxyInstances(host, token),
      fetchDevices(host, token),
      fetchTraffic(host, token),
      fetchCountryRules(host, token),
    ]);
  } catch {
    loadError = true;
  }

  const byInstance = new Map(instances.map((instance) => [instance.id, instance.name]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("proxy.title", locale)}</h1>
          <p className="page-desc">{t("proxy.desc", locale)}</p>
        </div>
      </div>

      {loadError ? <p className="danger">{t("proxy.loadError", locale)}</p> : null}

      <div className="card-grid">
        <Card
          className="card-span-all"
          title={t("proxy.config", locale)}
          note={t("proxy.configNote", locale)}
        >
          <ProxyManager
            upstreams={upstreams}
            instances={instances}
            countryRules={countryRules}
            devices={devices.map((device) => ({ id: device.id, name: device.name }))}
            labels={labels(locale)}
          />
        </Card>

        <Card
          className="card-span-all"
          title={t("proxy.traffic", locale)}
          note={t("proxy.trafficNote", locale)}
          bodyless
        >
          {traffic.length === 0 ? (
            <EmptyState title={t("proxy.noTraffic", locale)} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("proxy.colHour", locale)}</th>
                    <th>{t("proxy.colName", locale)}</th>
                    <th>{t("proxy.colUp", locale)}</th>
                    <th>{t("proxy.colDown", locale)}</th>
                    <th>{t("proxy.colConns", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {traffic.map((point) => (
                    <tr key={`${point.instanceId}-${point.hour}`}>
                      <td className="mono faint">
                        {new Date(point.hour).toISOString().replace("T", " ").slice(0, 13)}:00
                      </td>
                      <td>{byInstance.get(point.instanceId) ?? point.instanceId}</td>
                      <td className="mono">{bytes(point.bytesUp)}</td>
                      <td className="mono">{bytes(point.bytesDown)}</td>
                      <td className="mono">{point.connections}</td>
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

/**
 * Bytes at the scale an operator reads them. Binary units, because that is
 * what every other tool in this stack reports.
 */
function bytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? scaled : scaled.toFixed(1)} ${units[unit]}`;
}

function labels(locale: Locale): Record<string, string> {
  const keys = [
    "upstreams", "instances", "noUpstreams", "noInstances",
    "colName", "colAddress", "colProbe", "colListen", "colModem", "colUpstream",
    "add", "remove", "start", "stop", "restart", "direct", "device", "port",
    "username", "password", "probeFrom", "neverProbed", "failed", "confirmRemove",
    "countryRules", "noCountryRules", "colCountry",
  ];
  return Object.fromEntries(keys.map((key) => [key, t(`proxy.${key}`, locale)]));
}
