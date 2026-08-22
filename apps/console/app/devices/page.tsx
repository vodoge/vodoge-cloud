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
                    <th>{t("modems.colSms", locale)}</th>
                    <th>{t("modems.colSeen", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {modems.map((modem) => (
                    <tr key={modem.id}>
                      <td className="mono">{modem.imei}</td>
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
