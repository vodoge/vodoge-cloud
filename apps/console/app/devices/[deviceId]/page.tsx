import Link from "next/link";
import { DeviceAdmin } from "@/components/device-admin";
import { DeviceConsole, type DeviceLabelKey } from "@/components/device-console";
import { EsimPanel } from "@/components/esim-panel";
import { Card, EmptyState, StateBadge } from "@/components/ui";
import {
  fetchDevices,
  fetchEsimProfiles,
  fetchModems,
  type DeviceRow,
  type EsimProfileRow,
  type ModemRow,
} from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { isRoaming, operatorName, territoryName } from "@/lib/plmn";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

/**
 * One device, and everything that can be done to it.
 *
 * The old product's device detail page was where an operator spent a callout:
 * read the signal, try an AT command, check which network the card is on,
 * restart the module. All of that lived only on the edge panel here, behind a
 * shell on the box, until the command relay existed.
 */
export default async function DevicePage({
  params,
}: {
  params: Promise<{ deviceId: string }>;
}) {
  const { deviceId } = await params;
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();

  let devices: DeviceRow[] = [];
  let modems: ModemRow[] = [];
  let esim: EsimProfileRow[] = [];
  let loadError = false;
  try {
    [devices, modems, esim] = await Promise.all([
      fetchDevices(host, token),
      fetchModems(host, token),
      fetchEsimProfiles(host, token, deviceId),
    ]);
  } catch {
    loadError = true;
  }

  const device = devices.find((row) => row.id === deviceId);
  const own = modems.filter((row) => row.deviceId === deviceId);

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/devices" className="back-link">
            ← {t("device.back", locale)}
          </Link>
          <h1 className="page-title">{device?.name ?? t("device.title", locale)}</h1>
          <p className="page-desc mono">{deviceId}</p>
        </div>
        {device ? <StateBadge state={device.state} /> : null}
      </div>

      {loadError ? <p className="danger">{t("devices.loadError", locale)}</p> : null}

      <div className="card-grid">
        <Card
          title={t("devices.modems", locale)}
          note={t("devices.modemsNote", locale)}
          bodyless
        >
          {own.length === 0 ? (
            <EmptyState title={t("device.noModems", locale)} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("modems.colImei", locale)}</th>
                    <th>{t("modems.colIccid", locale)}</th>
                    <th>{t("modems.colNetwork", locale)}</th>
                    <th>{t("modems.colSignal", locale)}</th>
                    <th title={t("modems.qualityHint", locale)}>
                      {t("modems.colQuality", locale)}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {own.map((modem) => (
                    <tr key={modem.id}>
                      <td className="mono">
                        {modem.imei}
                        {/* Present but out of reach: the edge found it on its
                            AT port and QMI is unreachable, so it can be seen
                            and not operated. */}
                        {modem.manageable === false ? (
                          <span
                            className="badge badge-warn"
                            style={{ marginLeft: "var(--s2)" }}
                            title={t("modems.unmanagedHint", locale)}
                          >
                            {t("modems.unmanaged", locale)}
                          </span>
                        ) : null}
                      </td>
                      <td className="mono faint">{modem.iccid ?? "—"}</td>
                      <td>
                        <Network home={modem.homePlmn} serving={modem.servingPlmn} locale={locale} />
                      </td>
                      <td className="mono">
                        {modem.signalDbm === null ? "—" : `${modem.signalDbm} dBm`}
                      </td>
                      <td className="mono">
                        <ModemQuality rsrp={modem.rsrp} rsrq={modem.rsrq} sinr={modem.sinr} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>


        <Card title={t("device.host", locale)} note={t("device.hostNote", locale)}>
          {device && device.hostReportedAt !== null ? (
            <div className="table-wrap">
              <table>
                <tbody>
                  <tr>
                    <td>{t("device.hostPublicIp", locale)}</td>
                    <td className="mono">{device.publicIp ?? "—"}</td>
                  </tr>
                  <tr>
                    <td>{t("device.hostCpu", locale)}</td>
                    <td className="mono">
                      {device.cpuPercent === null ? "—" : `${device.cpuPercent.toFixed(1)}%`}
                    </td>
                  </tr>
                  <tr>
                    <td>{t("device.hostMemory", locale)}</td>
                    <td className="mono">
                      <HostMemory used={device.memoryUsedBytes} total={device.memoryTotalBytes} />
                    </td>
                  </tr>
                  <tr>
                    <td>{t("device.hostReportedAt", locale)}</td>
                    <td className="mono faint">
                      {new Date(device.hostReportedAt)
                        .toISOString()
                        .replace("T", " ")
                        .slice(0, 19)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            // Distinguished from a device with nothing to say: an agent older
            // than the host block checks in on every poll and would otherwise
            // render as a box reporting zeroes.
            <p className="faint">{t("device.hostUnreported", locale)}</p>
          )}
        </Card>
        <Card
          className="card-span-all"
          title={t("device.console", locale)}
          note={t("device.consoleNote", locale)}
        >
          <DeviceConsole deviceId={deviceId} modems={own} labels={deviceLabels(locale)} />
        </Card>
        <Card
          className="card-span-all"
          title={t("esim.title", locale)}
          note={t("esim.note", locale)}
        >
          <EsimPanel
            deviceId={deviceId}
            profiles={esim}
            modems={own.map((modem) => ({ imei: modem.imei }))}
            labels={{
              none: t("esim.none", locale),
              colEid: t("esim.colEid", locale),
              colIccid: t("esim.colIccid", locale),
              colState: t("esim.colState", locale),
              colNickname: t("esim.colNickname", locale),
              colCollected: t("esim.colCollected", locale),
              switch: t("esim.switch", locale),
              refresh: t("esim.refresh", locale),
              confirmSwitch: t("esim.confirmSwitch", locale),
            }}
          />
        </Card>

        <Card title={t("device.admin", locale)} note={t("device.adminNote", locale)}>
          <DeviceAdmin
            deviceId={deviceId}
            name={device?.name ?? deviceId}
            labels={{
              name: t("device.name", locale),
              rename: t("device.rename", locale),
              delete: t("device.delete", locale),
              deleteNote: t("device.deleteNote", locale),
              confirmDelete: t("device.confirmDelete", locale),
              failed: t("device.adminFailed", locale),
            }}
          />
        </Card>
      </div>
    </>
  );
}

function Network({
  home,
  serving,
  locale,
}: {
  home: string | null;
  serving: string | null;
  locale: Locale;
}) {
  if (!home && !serving) return <span className="faint">—</span>;
  const identity = home ?? serving!;
  const territory = territoryName(identity);
  const roaming = home !== null && serving !== null && isRoaming(home, serving);
  return (
    <span>
      {operatorName(identity)}
      {territory ? <span className="faint"> · {territory}</span> : null}
      {roaming ? (
        <span className="badge badge-warn" style={{ marginLeft: "var(--s2)" }}>
          {t("modems.roaming", locale)} → {operatorName(serving)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * RSRP / RSRQ / SINR as one cell.
 *
 * Kept together because no one of them means much alone: a strong RSRP with a
 * poor SINR is a loud cell with interference on it, and that is a different
 * problem from a weak signal. Each is rendered independently so a module that
 * reported two of the three does not show as having reported none.
 */
function ModemQuality({
  rsrp,
  rsrq,
  sinr,
}: {
  rsrp: number | null;
  rsrq: number | null;
  sinr: number | null;
}) {
  if (rsrp === null && rsrq === null && sinr === null) {
    return <span className="faint">—</span>;
  }
  return (
    <span>
      {rsrp === null ? "—" : `${rsrp}`}
      <span className="faint"> / </span>
      {rsrq === null ? "—" : `${rsrq}`}
      <span className="faint"> / </span>
      {sinr === null ? "—" : `${sinr}`}
      <span className="faint"> dB</span>
    </span>
  );
}

/**
 * Memory in bytes and as a share, because this page has room for both.
 *
 * The share is what says whether the box is in trouble; the absolute figures
 * are what say whether it is the box that is too small.
 */
function HostMemory({ used, total }: { used: number | null; total: number | null }) {
  if (used === null || total === null || total === 0) {
    return <span className="faint">—</span>;
  }
  return (
    <span>
      {formatBytes(used)} / {formatBytes(total)}
      <span className="faint"> ({Math.round((used / total) * 100)}%)</span>
    </span>
  );
}

/** Binary units, matching what `free -h` on the box itself reports. */
function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * The label keys DeviceConsole draws, each pointing at its catalogue entry.
 *
 * Typed as a total Record, so leaving one out is a compile error and naming
 * one the component does not read is another. It used to be a bare object
 * literal with no relation to what the component looked up: a control that
 * reached for a key nobody had listed here got `undefined`, and React renders
 * undefined as nothing — an empty button, in both locales, silently. That
 * defect cost the proxy export control a delivery (T055) before the same gate
 * was put in front of it (T071); this console was the last panel without one,
 * and the USSD follow-up added seven stage labels at once.
 *
 * The value is the catalogue key rather than `true` because these come from
 * two namespaces: the controls are `device.*` and the command names, which the
 * log shares with the buttons, are `cmd.*`.
 */
const DEVICE_LABEL_KEYS: Record<DeviceLabelKey, string> = {
  modem: "device.modem",
  noModems: "device.noModems",
  noCommands: "device.noCommands",
  waiting: "device.waiting",
  failed: "device.failed",
  run: "device.run",
  send: "device.send",
  cancel: "device.cancel",
  atCommand: "device.atCommand",
  ussdCode: "device.ussdCode",
  ussdSession: "device.ussdSession",
  ussdSessionModem: "device.ussdSessionModem",
  ussdReply: "device.ussdReply",
  ussdContinue: "device.ussdContinue",
  ussdExpired: "device.ussdExpired",
  ussdStageComplete: "device.ussdStageComplete",
  ussdStageNeedsReply: "device.ussdStageNeedsReply",
  ussdStageTerminated: "device.ussdStageTerminated",
  ussdStageOtherClient: "device.ussdStageOtherClient",
  ussdStageNotSupported: "device.ussdStageNotSupported",
  ussdStageNetworkTimeout: "device.ussdStageNetworkTimeout",
  ussdStageOther: "device.ussdStageOther",
  selectOperator: "device.selectOperator",
  pin: "device.pin",
  automatic: "device.automatic",
  radioOn: "device.radioOn",
  dataOn: "device.dataOn",
  usbnetMode: "device.usbnetMode",
  usbnetWarning: "device.usbnetWarning",
  confirmUsbnet: "device.confirmUsbnet",
  confirmDisruptive: "device.confirmDisruptive",
  modem_report: "cmd.modem_report",
  list_esim_profiles: "cmd.list_esim_profiles",
  restart_modem: "cmd.restart_modem",
  reset_modem_usb: "cmd.reset_modem_usb",
  scan_operators: "cmd.scan_operators",
  rotate_ip: "cmd.rotate_ip",
  set_radio: "cmd.set_radio",
  set_data_network: "cmd.set_data_network",
  reregister_network: "cmd.reregister_network",
  refresh_modems: "cmd.refresh_modems",
  run_at_command: "cmd.run_at_command",
  send_ussd: "cmd.send_ussd",
  select_operator: "cmd.select_operator",
  send_sms: "cmd.send_sms",
  switch_esim_profile: "cmd.switch_esim_profile",
  set_usbnet_mode: "cmd.set_usbnet_mode",
};

/**
 * Resolves each of those against the message catalogue for this request.
 *
 * A key with no catalogue entry comes back as ⟦device.whatever⟧ from t(),
 * which is loud on the page rather than blank. The two remaining ways this can
 * be wrong are a missing key, which must be visible, and a key present in only
 * one locale, which check-i18n refuses.
 */
function deviceLabels(locale: Locale): Record<DeviceLabelKey, string> {
  const names = Object.keys(DEVICE_LABEL_KEYS) as DeviceLabelKey[];
  return Object.fromEntries(
    names.map((key) => [key, t(DEVICE_LABEL_KEYS[key], locale)]),
  ) as Record<DeviceLabelKey, string>;
}
