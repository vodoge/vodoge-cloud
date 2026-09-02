import { ProxyManager, type ProxyLabelKey } from "@/components/proxy-manager";
import { CardPanel as Card, CardEmpty } from "@/components/ui/card";
import type { ConfirmLabels } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
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
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("proxy.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{t("proxy.desc", locale)}</p>
        </div>
      </div>

      {loadError ? <p className="m-0 mb-4 text-sm text-destructive">{t("proxy.loadError", locale)}</p> : null}

      {/*
        This container said `card-grid` for as long as the page has existed and
        the stylesheet has never had a rule by that name, so the two cards below
        were stacked by ordinary block flow with nothing between them —
        markup claiming a layout it was not getting. `"flex flex-col gap-6"` is a real
        rule: `flex flex-col gap-s5`, checked against the Tailwind build like
        every other class in this file.
      */}
      <div className="flex flex-col gap-6">
        <Card title={t("proxy.config", locale)} note={t("proxy.configNote", locale)}>
          <ProxyManager
            upstreams={upstreams}
            instances={instances}
            countryRules={countryRules}
            devices={devices.map((device) => ({ id: device.id, name: device.name }))}
            labels={labels(locale)}
            confirmLabels={confirmLabels(locale)}
            canExport={canExport}
          />
        </Card>

        <Card title={t("proxy.traffic", locale)} note={t("proxy.trafficNote", locale)} bodyless>
          {traffic.length === 0 ? (
            <CardEmpty title={t("proxy.noTraffic", locale)} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow head>
                  <TableHead>{t("proxy.colHour", locale)}</TableHead>
                  <TableHead>{t("proxy.colName", locale)}</TableHead>
                  <TableHead>{t("proxy.colUp", locale)}</TableHead>
                  <TableHead>{t("proxy.colDown", locale)}</TableHead>
                  {/* The count is the least of the five: an operator reading
                      this on a phone is asking how much went out, not how
                      many times. */}
                  <TableHead secondary>{t("proxy.colConns", locale)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {traffic.map((point) => (
                  <TableRow key={`${point.instanceId}-${point.hour}`}>
                    <TableCell mono faint>
                      {new Date(point.hour).toISOString().replace("T", " ").slice(0, 13)}:00
                    </TableCell>
                    <TableCell>{byInstance.get(point.instanceId) ?? point.instanceId}</TableCell>
                    <TableCell mono>{bytes(point.bytesUp)}</TableCell>
                    <TableCell mono>{bytes(point.bytesDown)}</TableCell>
                    <TableCell mono secondary>
                      {point.connections}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
  // Five confirmations, each a title and a consequence. They replace a single
  // `proxy.confirmRemove` — "Remove this permanently?" — which was the whole
  // of the guard on two different objects and named neither, and they add one
  // where a country rule was deleted with no confirmation at all.
  confirmRemoveUpstreamTitle: true,
  confirmRemoveUpstream: true,
  confirmRemoveInstanceTitle: true,
  confirmRemoveInstance: true,
  confirmRemoveRuleTitle: true,
  confirmRemoveRule: true,
  confirmStopTitle: true,
  confirmStop: true,
  confirmRestartTitle: true,
  confirmRestart: true,
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

/**
 * The confirmation dialog's own chrome, resolved here rather than in the
 * component.
 *
 * Separate from the labels above because these three are shared with every
 * other confirmation in the console: the dialog asks the question itself, in
 * the same words everywhere, which is what lets the consequence check reject a
 * "consequence" that turns out to be another question. Resolved on the server
 * for the same reason every other string on this page is — a client component
 * that read the locale in an effect would render the server's HTML in the
 * default language every time.
 */
function confirmLabels(locale: Locale): ConfirmLabels {
  return {
    question: t("confirm.question", locale),
    proceed: t("confirm.proceed", locale),
    cancel: t("confirm.cancel", locale),
  };
}
