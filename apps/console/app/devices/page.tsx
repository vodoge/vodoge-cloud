import Link from "next/link";
import { Card, EmptyState, StateBadge } from "@/components/ui";
import { CardPolicies } from "@/components/card-policies";
import {
  fetchCardPolicies,
  fetchDevices,
  fetchModems,
  type CardPolicyRow,
  type DeviceRow,
  type ModemRow,
} from "@/lib/catalog";
import { isRoaming, operatorName, territoryName } from "@/lib/plmn";
import {t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

export default async function DevicesPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();

  let devices: DeviceRow[] = [];
  let modems: ModemRow[] = [];
  let policies: CardPolicyRow[] = [];
  let loadError = false;
  try {
    [devices, modems, policies] = await Promise.all([
      fetchDevices(host, token),
      fetchModems(host, token),
      fetchCardPolicies(host, token),
    ]);
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
                  <th>{t("devices.colVersionShort", locale)}</th>
                  <th>{t("devices.colQueue", locale)}</th>
                  <th>{t("devices.colPublicIp", locale)}</th>
                  <th>{t("devices.colHostCpu", locale)}</th>
                  <th>{t("devices.colHostMemory", locale)}</th>
                  <th>{t("devices.colLastSeen", locale)}</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <Link href={`/devices/${device.id}`}>{device.name}</Link>
                    </td>
                    <td className="mono faint">{device.id}</td>
                    <td>
                      <StateBadge
                        state={device.state}
                        label={t(`state.${device.state}`, locale)}
                      />
                    </td>
                    <td className="mono faint">{device.edgeVersion ?? "—"}</td>
                    <td className="mono">
                      {/* A backlog is the number worth seeing at a glance:
                          a device that is online and behind looks healthy
                          everywhere else. */}
                      {device.queueRecords === null ? (
                        "—"
                      ) : device.queueRecords > 0 ? (
                        <span className="badge badge-warn">{device.queueRecords}</span>
                      ) : (
                        <span className="faint">0</span>
                      )}
                    </td>
                    {/* The one fact about the egress path the box cannot
                        work out for itself: every interface it owns has a
                        private address. */}
                    <td className="mono">{device.publicIp ?? "—"}</td>
                    <td className="mono">
                      {device.cpuPercent === null ? "—" : `${device.cpuPercent.toFixed(1)}%`}
                    </td>
                    <td className="mono">
                      <HostMemory
                        used={device.memoryUsedBytes}
                        total={device.memoryTotalBytes}
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

      <div style={{ marginTop: "var(--s5)" }}>
        <Card
          title={t("devices.modems", locale)}
          note={t("devices.modemsNote", locale)}
          bodyless
        >
          {modems.length === 0 ? (
            <EmptyState
              title={t("empty.modems.title", locale)}
              desc={t("empty.modems.desc", locale)}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("modems.colImei", locale)}</th>
                    <th>{t("modems.colIccid", locale)}</th>
                    <th>{t("modems.colNetwork", locale)}</th>
                    <th>{t("modems.colState", locale)}</th>
                    <th>{t("modems.colSignal", locale)}</th>
                    <th title={t("modems.qualityHint", locale)}>
                      {t("modems.colQuality", locale)}
                    </th>
                    <th>{t("modems.colSms", locale)}</th>
                    <th>{t("modems.colSeen", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {modems.map((modem) => (
                    <tr key={modem.id}>
                      <td className="mono">
                        {modem.imei}
                        {/* Visible but not drivable. Before the edge enumerated
                            AT ports as a second path, a module in this state
                            did not appear at all. */}
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
                        <ModemNetwork
                          home={modem.homePlmn}
                          serving={modem.servingPlmn}
                          locale={locale}
                        />
                      </td>
                      <td>
                        <StateBadge state={modem.state ?? "unknown"} />
                      </td>
                      <td className="mono">
                        {modem.signalDbm === null ? "—" : `${modem.signalDbm} dBm`}
                      </td>
                      <td className="mono">
                        <ModemQuality rsrp={modem.rsrp} rsrq={modem.rsrq} sinr={modem.sinr} />
                      </td>
                      <td>
                        {/* The bearer the edge resolved. A blank here means the
                            matrix has no answer for this combination, which is
                            different from "cannot send". */}
                        <span className="badge badge-idle">
                          {modem.smsMt ?? "—"}
                        </span>
                      </td>
                      <td className="mono faint">
                        {modem.lastSeen
                          ? new Date(modem.lastSeen).toISOString().replace("T", " ").slice(0, 19)
                          : t("common.never", locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: "var(--s5)" }}>
        <Card title={t("cards.title", locale)} note={t("cards.note", locale)}>
          <CardPolicies
            policies={policies}
            // Only cards the fleet has actually reported. A policy for a card
            // that does not exist matches nothing on any device and says so
            // nowhere.
            knownCards={modems
              .filter((modem) => modem.iccid)
              .map((modem) => ({
                iccid: modem.iccid!,
                label: `${modem.iccid} — ${modem.imei}`,
              }))}
            labels={{
              none: t("cards.none", locale),
              colIccid: t("cards.colIccid", locale),
              colCellular: t("cards.colCellular", locale),
              colVertical: t("cards.colVertical", locale),
              colApn: t("cards.colApn", locale),
              on: t("cards.on", locale),
              off: t("cards.off", locale),
              add: t("cards.add", locale),
              addFor: t("cards.addFor", locale),
              remove: t("cards.remove", locale),
              failed: t("cards.failed", locale),
              confirmRemove: t("cards.confirmRemove", locale),
            }}
          />
        </Card>
      </div>
    </>
  );
}

/**
 * The card's identity, then where it actually is. Home comes first because it
 * answers "whose card is this"; the serving network only appears when it is a
 * different operator, which is exactly the roaming case worth noticing.
 */
function ModemNetwork({
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
 * Memory as a share of the box rather than a byte count.
 *
 * A raw figure means nothing without knowing the machine; a percentage is
 * comparable across a fleet at a glance. The exact bytes are on the device
 * page, where there is room to say what they are out of.
 */
function HostMemory({ used, total }: { used: number | null; total: number | null }) {
  if (used === null || total === null || total === 0) {
    return <span className="faint">—</span>;
  }
  return <span>{Math.round((used / total) * 100)}%</span>;
}
