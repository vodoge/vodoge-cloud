import Link from "next/link";
import { DeviceAdmin } from "@/components/device-admin";
import { DeviceConsole } from "@/components/device-console";
import { Card, EmptyState, StateBadge } from "@/components/ui";
import { fetchDevices, fetchModems, type DeviceRow, type ModemRow } from "@/lib/catalog";
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
  let loadError = false;
  try {
    [devices, modems] = await Promise.all([
      fetchDevices(host, token),
      fetchModems(host, token),
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
                  </tr>
                </thead>
                <tbody>
                  {own.map((modem) => (
                    <tr key={modem.id}>
                      <td className="mono">{modem.imei}</td>
                      <td className="mono faint">{modem.iccid ?? "—"}</td>
                      <td>
                        <Network home={modem.homePlmn} serving={modem.servingPlmn} locale={locale} />
                      </td>
                      <td className="mono">
                        {modem.signalDbm === null ? "—" : `${modem.signalDbm} dBm`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
