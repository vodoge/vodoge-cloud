import { ProxyManager, type ProxyLabelKey } from "@/components/proxy-manager";
import { Card, EmptyState } from "@/components/ui";
import {
  fetchConsoleRole,
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
import { mayWrite } from "@/lib/session";
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

  // Asked for separately, and outside the try. It is not catalogue data: it
  // decides whether one control is drawn, it already fails closed to
  // read-only, and folding it into the Promise.all above would let a slow
  // session lookup turn the whole page into a load error.
  const canExport = mayWrite(await fetchConsoleRole(host, token));

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
            canExport={canExport}
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

/**
 * The label keys ProxyManager draws, one entry each.
 *
 * An object rather than an array, and typed as a total Record, so that leaving
 * one out is a compile error. It used to be a bare string[] with no relation
 * to what the component read: a control that reached for a key nobody had
 * listed here got `undefined`, and React renders undefined as nothing — an
 * empty button, in both locales, silently. That cost the export control a
 * delivery once already, so the list is now checked instead of remembered.
 *
 * The value is unused; only the key set matters.
 */
const PROXY_LABEL_KEYS: Record<ProxyLabelKey, true> = {
  upstreams: true,
  instances: true,
  noUpstreams: true,
  noInstances: true,
  colName: true,
  colAddress: true,
  colProbe: true,
  colListen: true,
  colModem: true,
  colUpstream: true,
  add: true,
  remove: true,
  start: true,
  stop: true,
  restart: true,
  direct: true,
  device: true,
  port: true,
  username: true,
  password: true,
  probeFrom: true,
  neverProbed: true,
  failed: true,
  confirmRemove: true,
  countryRules: true,
  noCountryRules: true,
  colCountry: true,
  export: true,
  exportNote: true,
  exportHost: true,
  exportHostHint: true,
  exportEmpty: true,
  exportUnexportable: true,
  exportFailed: true,
  exportClose: true,
  copy: true,
  copyAll: true,
  copied: true,
  copyFailed: true,
};

/**
 * Resolves each of those against the message catalogue for this request.
 *
 * A key with no catalogue entry comes back as ⟦proxy.whatever⟧ from t(), which
 * is loud on the page and in a snapshot. That is deliberate: the two ways this
 * can be wrong are a missing key, which must be visible, and a key present in
 * only one locale, which check-i18n refuses.
 */
function labels(locale: Locale): Record<ProxyLabelKey, string> {
  const names = Object.keys(PROXY_LABEL_KEYS) as ProxyLabelKey[];
  return Object.fromEntries(
    names.map((key) => [key, t(`proxy.${key}`, locale)]),
  ) as Record<ProxyLabelKey, string>;
}
