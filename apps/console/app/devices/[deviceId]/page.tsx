import Link from "next/link";
import { DeviceAdmin } from "@/components/device-admin";
import {
  DeviceConsole,
  DeviceDiagnostics,
  type DeviceLabelKey,
} from "@/components/device-console";
import { EsimPanel } from "@/components/esim-panel";
import { Badge, StateBadge } from "@/components/ui/badge";
import {
  Card as CardShell,
  CardContent,
  CardEmpty,
  CardHeader,
  CardNote,
  CardPanel as Card,
  CardTitle,
} from "@/components/ui/card";
import {
  SpecRow,
  SpecTable,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { Tab, TabList, TabPanel } from "@/components/ui/tabs";
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
import { CARD, DEVICE_TABS, PAGE, TABLE, deviceTab, deviceTabHref } from "@/lib/tokens";

/**
 * One device, and everything that can be done to it.
 *
 * The old product's device detail page was where an operator spent a callout:
 * read the signal, try an AT command, check which network the card is on,
 * restart the module. All of that lived only on the edge panel here, behind a
 * shell on the box, until the command relay existed.
 *
 * ## Why it is four tabs now
 *
 * Everything above used to be on one page, one card under another, and the two
 * interactive panels alone are 1679 lines — every dangerous command this
 * console can send is on this page. Reading a signal and restarting a module
 * were the same scroll.
 *
 * The four are `DEVICE_TABS` in `lib/tokens.ts` rather than markup here,
 * because a `.tsx` cannot be read by a test in this app and because the two
 * halves of this page were migrated by two cards: this one built the strip and
 * filled the two read-only panels, the next fills the console and the eSIM
 * panels. A shared list is what stops the second one from arriving with a
 * fifth tab or a different spelling.
 *
 * ## What is on which tab, and why
 *
 * `panelFor()` below is the only place that decides what a tab shows, and the
 * split is by what a control *does* rather than by which component it happens
 * to live in. Both of the seams T010 left are closed here:
 *
 * - **The two `READ_ONLY` commands and the command log** were in the console
 *   panel because that is the file they are written in. Both only read — a
 *   diagnostic report and an ES10c profile listing — so they are on the
 *   diagnostics tab with the other readings.
 * - **Renaming and removing the device** was on the overview tab, under the
 *   first table an operator sees. Removing a device deletes its whole journal,
 *   every message and every command it ever ran, so it is in the danger zone
 *   on the console tab. Its confirmation — typing the device's name verbatim,
 *   the strongest guard in this console — is untouched.
 *
 * ## What the tab strip does not change
 *
 * All three fetches still run on every request, whichever tab is asked for.
 * Rendering one panel is a change to what is drawn; fetching less would be a
 * change to what the page does, and the eSIM inventory is what tells the
 * overview whether this device has profiles at all.
 */
export default async function DevicePage({
  params,
  searchParams,
}: {
  params: Promise<{ deviceId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { deviceId } = await params;
  // A link, not client state: the page stays a server component, so its
  // language is right in the HTML rather than after hydration, and a tab
  // survives the reload an operator does while a command is in flight.
  const current = deviceTab((await searchParams).tab);
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

  function panelFor(tab: (typeof DEVICE_TABS)[number]["id"]) {
    switch (tab) {
      case "overview":
        return <OverviewPanel device={device} modems={own} locale={locale} />;
      case "diagnostics":
        return (
          <DiagnosticsPanel
            deviceId={deviceId}
            device={device}
            modems={own}
            locale={locale}
          />
        );
      case "console":
        return <ConsolePanel deviceId={deviceId} device={device} modems={own} locale={locale} />;
      case "esim":
        // The locale itself, not a nine-string subset of the catalogue. The
        // subset was the bug: the panel drew about a hundred strings and this
        // list named nine of them, so the other ninety-odd came from a locale
        // the component only learned after hydration and the server sent them
        // in the default language on every request.
        //
        // No wrapping card: the panel draws four of its own, one per section,
        // and a card inside a card is how a heading stops meaning anything.
        return (
          <EsimPanel
            deviceId={deviceId}
            profiles={esim}
            modems={own.map((modem) => ({ imei: modem.imei }))}
            locale={locale}
          />
        );
    }
  }

  return (
    <>
      <div className={PAGE.head}>
        <div>
          <Link href="/devices" className={PAGE.back}>
            ← {t("device.back", locale)}
          </Link>
          <h1 className={PAGE.title}>{device?.name ?? t("device.title", locale)}</h1>
          <p className={PAGE.identifier}>{deviceId}</p>
        </div>
        {device ? <StateBadge state={device.state} /> : null}
      </div>

      {loadError ? <p className={PAGE.error}>{t("devices.loadError", locale)}</p> : null}

      <TabList>
        {DEVICE_TABS.map((tab) => (
          <Tab
            key={tab.id}
            href={deviceTabHref(deviceId, tab.id)}
            current={tab.id === current}
          >
            {t(tab.key, locale)}
          </Tab>
        ))}
      </TabList>

      {/*
        `PAGE.stack` is the replacement for `className="card-grid"`, which this
        page carried since it was written and which **no stylesheet has ever
        defined** — not the legacy layer, not the Tailwind build. The markup
        said the cards were laid out in a grid and they were stacked in ordinary
        block flow with no gap between them at all. Three surveys read this file
        and none of them saw it; the check that computes the set of classes
        nothing defines is what found it.

        Its neighbour `card-span-all` is a different fault and was removed
        rather than replaced: that rule *does* exist (`grid-column: 1 / -1`) and
        did nothing here, because the container it was spanning was never a
        grid. A stack has one column, so full width is what a card gets.
      */}
      <TabPanel className={PAGE.stack}>{panelFor(current)}</TabPanel>
    </>
  );
}

/**
 * What the device is: its modules, and nothing that can be pressed.
 *
 * The module table is three columns here rather than the five it had, because
 * the two readings that were dropped — signal and LTE quality — are a
 * measurement rather than an identity, and they are the whole of the
 * diagnostics panel. At 390px five columns of IMEI, ICCID and dBm are a
 * sideways scroll on the first thing an operator sees.
 *
 * 🔴 The rename-and-remove card left this tab. T010 put it here because it was
 * where the admin card had always been, and flagged the contradiction: removing
 * a device deletes its entire journal, every message and every command, and it
 * was sitting under the first table an operator sees. It is in the danger zone
 * on the console tab now, beside the other things that cannot be undone.
 * `device-admin.tsx` itself is untouched by that move.
 */
function OverviewPanel({
  device,
  modems,
  locale,
}: {
  device: DeviceRow | undefined;
  modems: ModemRow[];
  locale: Locale;
}) {
  return (
    <>
      <Card title={t("devices.modems", locale)} note={t("devices.modemsNote", locale)} bodyless>
        {modems.length === 0 ? (
          <CardEmpty title={t("device.noModems", locale)} />
        ) : (
          <Table>
            <TableHead>
              <TableRow head>
                <TableHeaderCell>{t("modems.colImei", locale)}</TableHeaderCell>
                {/* The ICCID is the SIM's identity, not the module's, and the
                    controls on this page all address a module by IMEI. It is
                    the widest value in the table at twenty characters, so it is
                    the one that goes on a phone. */}
                <TableHeaderCell secondary>{t("modems.colIccid", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("modems.colNetwork", locale)}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {modems.map((modem) => (
                <TableRow key={modem.id}>
                  <TableCell mono>
                    <span className={TABLE.cellInline}>
                      {modem.imei}
                      {/* Present but out of reach: the edge found it on its
                          AT port and QMI is unreachable, so it can be seen
                          and not operated. */}
                      {modem.manageable === false ? (
                        <Badge tone="warn" title={t("modems.unmanagedHint", locale)}>
                          {t("modems.unmanaged", locale)}
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell mono faint secondary>
                    {modem.iccid ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Network home={modem.homePlmn} serving={modem.servingPlmn} locale={locale} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

    </>
  );
}

/**
 * Everything this page can *do*, and the zone where doing it cannot be undone.
 *
 * The console panel draws its own cards — a module picker, the AT box, USSD,
 * network and USB, the danger zone, and the log — so this branch adds one
 * thing: the device's own name and its removal, which is the most destructive
 * control in this console and was sitting on the overview tab beside a table.
 *
 * 🔴 It is drawn from the composed card parts rather than `CardPanel` for one
 * reason: the danger zone is a wash behind the header and a red title, and
 * `CardPanel` has nowhere to put a class on its header. **A red border was
 * the first answer and, when this was written, it would not have
 * rendered** — `CARD.root` asked for a border width and computed to
 * `none 0px` on that build, which was the whole of
 * `BORDER_WIDTH_WITHOUT_A_STYLE`, and shipping markup that reviewed as a
 * warning and painted nothing was the exact defect this card was sent to fix
 * on the USB-net button. **That reason is gone**: the reset in
 * `app/globals.css` now carries the style `CARD.root` was missing, and a red
 * border would draw today. `CardPanel`'s header still takes no class of its
 * own, though, so the composed parts are still what this needs regardless.
 *
 * `device-admin.tsx` itself is untouched: T010 migrated it and its
 * confirmation — typing the device's name verbatim, the strongest guard in
 * this console — is not this card's to weaken.
 */
function ConsolePanel({
  deviceId,
  device,
  modems,
  locale,
}: {
  deviceId: string;
  device: DeviceRow | undefined;
  modems: ModemRow[];
  locale: Locale;
}) {
  return (
    <>
      <DeviceConsole
        deviceId={deviceId}
        modems={modems}
        labels={deviceLabels(locale)}
        locale={locale}
      />

      <CardShell>
        <CardHeader className={CARD.dangerHeader}>
          <CardTitle className={CARD.dangerTitle}>{t("device.admin", locale)}</CardTitle>
          <CardNote>{t("device.adminNote", locale)}</CardNote>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </CardShell>
    </>
  );
}

/**
 * What the device is doing: the host's own vitals, and the radio readings.
 *
 * Both are numbers reported by the edge and nothing here writes anything, which
 * is what makes this half of the page one card's work while the commands are
 * another's.
 */
function DiagnosticsPanel({
  deviceId,
  device,
  modems,
  locale,
}: {
  deviceId: string;
  device: DeviceRow | undefined;
  modems: ModemRow[];
  locale: Locale;
}) {
  return (
    <>
      <Card title={t("device.host", locale)} note={t("device.hostNote", locale)} bodyless>
        {device && device.hostReportedAt !== null ? (
          // A `SpecTable`, not the data grid: four pairs of a name and a
          // reading, with no header row at all. The narrow-screen treatment
          // that turns a row into a labelled block using the header text does
          // nothing here, which is why there are two table shapes.
          <SpecTable>
            <TableBody>
              <SpecRow term={t("device.hostPublicIp", locale)} mono>
                {device.publicIp ?? "—"}
              </SpecRow>
              <SpecRow term={t("device.hostCpu", locale)} mono>
                {device.cpuPercent === null ? "—" : `${device.cpuPercent.toFixed(1)}%`}
              </SpecRow>
              <SpecRow term={t("device.hostMemory", locale)} mono>
                <HostMemory used={device.memoryUsedBytes} total={device.memoryTotalBytes} />
              </SpecRow>
              <SpecRow term={t("device.hostReportedAt", locale)} mono>
                <span className={TABLE.cellFaint}>
                  {new Date(device.hostReportedAt).toISOString().replace("T", " ").slice(0, 19)}
                </span>
              </SpecRow>
            </TableBody>
          </SpecTable>
        ) : (
          // Distinguished from a device with nothing to say: an agent older
          // than the host block checks in on every poll and would otherwise
          // render as a box reporting zeroes.
          <CardEmpty title={t("device.hostUnreported", locale)} />
        )}
      </Card>

      <Card title={t("device.radio", locale)} note={t("device.radioNote", locale)} bodyless>
        {modems.length === 0 ? (
          <CardEmpty title={t("device.noModems", locale)} />
        ) : (
          <Table>
            <TableHead>
              <TableRow head>
                <TableHeaderCell>{t("modems.colImei", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("modems.colSignal", locale)}</TableHeaderCell>
                <TableHeaderCell title={t("modems.qualityHint", locale)}>
                  {t("modems.colQuality", locale)}
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {modems.map((modem) => (
                <TableRow key={modem.id}>
                  <TableCell mono>{modem.imei}</TableCell>
                  <TableCell mono>
                    {modem.signalDbm === null ? "—" : `${modem.signalDbm} dBm`}
                  </TableCell>
                  <TableCell mono>
                    <ModemQuality rsrp={modem.rsrp} rsrq={modem.rsrq} sinr={modem.sinr} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/*
        The seam T010 left, closed. The two `READ_ONLY` commands and the log
        they answer in live in `device-console.tsx`, which that card's own
        `stop_if` forbade it from touching — so the diagnostics tab was built
        with the readings and without the two buttons that produce them. Both
        of these only read: a diagnostic report, and an ES10c profile listing.
      */}
      <DeviceDiagnostics
        deviceId={deviceId}
        modems={modems}
        labels={deviceLabels(locale)}
        locale={locale}
      />
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
  if (!home && !serving) return <span className={TABLE.cellFaint}>—</span>;
  const identity = home ?? serving!;
  const territory = territoryName(identity);
  const roaming = home !== null && serving !== null && isRoaming(home, serving);
  return (
    <span className={TABLE.cellInline}>
      <span>
        {operatorName(identity)}
        {territory ? <span className={TABLE.cellFaint}> · {territory}</span> : null}
      </span>
      {roaming ? (
        <Badge tone="warn">
          {t("modems.roaming", locale)} → {operatorName(serving)}
        </Badge>
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
    return <span className={TABLE.cellFaint}>—</span>;
  }
  return (
    <span>
      {rsrp === null ? "—" : `${rsrp}`}
      <span className={TABLE.cellFaint}> / </span>
      {rsrq === null ? "—" : `${rsrq}`}
      <span className={TABLE.cellFaint}> / </span>
      {sinr === null ? "—" : `${sinr}`}
      <span className={TABLE.cellFaint}> dB</span>
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
    return <span className={TABLE.cellFaint}>—</span>;
  }
  return (
    <span>
      {formatBytes(used)} / {formatBytes(total)}
      <span className={TABLE.cellFaint}> ({Math.round((used / total) * 100)}%)</span>
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
  modemNote: "device.modemNote",
  noModems: "device.noModems",
  noCommands: "device.noCommands",
  waiting: "device.waiting",
  failed: "device.failed",
  run: "device.run",
  send: "device.send",
  cancel: "device.cancel",
  console: "device.console",
  consoleNote: "device.consoleNote",
  diagTitle: "device.diagTitle",
  diagNote: "device.diagNote",
  atCommand: "device.atCommand",
  atNote: "device.atNote",
  atGuarded: "device.atGuarded",
  ussdNote: "device.ussdNote",
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
  networkTitle: "device.networkTitle",
  networkNote: "device.networkNote",
  pin: "device.pin",
  automatic: "device.automatic",
  radioOn: "device.radioOn",
  dataOn: "device.dataOn",
  danger: "device.danger",
  dangerNote: "device.dangerNote",
  recovery: "device.recovery",
  recoveryNote: "device.recoveryNote",
  logTitle: "device.logTitle",
  logNote: "device.logNote",
  usbnetMode: "device.usbnetMode",
  usbnetWarning: "device.usbnetWarning",
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
