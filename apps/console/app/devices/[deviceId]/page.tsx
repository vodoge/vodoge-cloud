import Link from "next/link";
import { DeviceAdmin } from "@/components/device-admin";
import { DeviceConsole } from "@/components/device-console";
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
          <DeviceConsole
            deviceId={deviceId}
            modems={own}
            labels={{
              modem: t("device.modem", locale),
              noModems: t("device.noModems", locale),
              noCommands: t("device.noCommands", locale),
              waiting: t("device.waiting", locale),
              failed: t("device.failed", locale),
              run: t("device.run", locale),
              send: t("device.send", locale),
              cancel: t("device.cancel", locale),
              atCommand: t("device.atCommand", locale),
              ussdCode: t("device.ussdCode", locale),
              selectOperator: t("device.selectOperator", locale),
              pin: t("device.pin", locale),
              automatic: t("device.automatic", locale),
              radioOn: t("device.radioOn", locale),
              confirmDisruptive: t("device.confirmDisruptive", locale),
              modem_report: t("cmd.modem_report", locale),
              list_esim_profiles: t("cmd.list_esim_profiles", locale),
              restart_modem: t("cmd.restart_modem", locale),
              reset_modem_usb: t("cmd.reset_modem_usb", locale),
              scan_operators: t("cmd.scan_operators", locale),
              set_radio: t("cmd.set_radio", locale),
              rotate_ip: t("cmd.rotate_ip", locale),
              run_at_command: t("cmd.run_at_command", locale),
              send_ussd: t("cmd.send_ussd", locale),
              select_operator: t("cmd.select_operator", locale),
              send_sms: t("cmd.send_sms", locale),
              switch_esim_profile: t("cmd.switch_esim_profile", locale),
              set_data_network: t("cmd.set_data_network", locale),
              reregister_network: t("cmd.reregister_network", locale),
              refresh_modems: t("cmd.refresh_modems", locale),
              set_usbnet_mode: t("cmd.set_usbnet_mode", locale),
              dataOn: t("device.dataOn", locale),
              usbnetMode: t("device.usbnetMode", locale),
              usbnetWarning: t("device.usbnetWarning", locale),
              confirmUsbnet: t("device.confirmUsbnet", locale),
            }}
          />
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
