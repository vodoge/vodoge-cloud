import Link from "next/link";
import { Badge, StateBadge } from "@/components/ui/badge";
import { CardEmpty, CardPanel as Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { CardPolicies } from "@/components/card-policies";
import {
  fetchCardPolicies,
  fetchConsoleRole,
  fetchDevices,
  fetchModems,
  type CardPolicyRow,
  type DeviceRow,
  type ModemRow,
} from "@/lib/catalog";
import { isRoaming, operatorName, territoryName } from "@/lib/plmn";
import { t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { mayWrite } from "@/lib/session";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { CARD_POLICY_CONFIRMATIONS, PAGE, TABLE, type CardPolicyGuard } from "@/lib/tokens";

/**
 * The fleet, its modules, and the policies that follow a SIM between them.
 *
 * ## The narrow-screen table pattern is settled on this page
 *
 * This is the widest table in the console — nine columns of UUIDs, addresses
 * and timestamps — so it is where the pattern the six page cards after this one
 * copy had to be proved. It is not invented here: `components/ui/table.tsx` was
 * sealed with it, and this page is the first caller.
 *
 * 1. The table scrolls sideways **inside its card**, never taking the page with
 *    it. A card that scrolls leaves the page's own layout alone.
 * 2. A column that is context rather than the answer carries `secondary`, on
 *    **both** its header cell and its body cell, and drops off below `sm`.
 * 3. 🔴 **A column containing a control is never `secondary`.** Hiding a link,
 *    a tick, a picker or a button on a phone is not deprioritising context; it
 *    is removing the ability to do the thing. Every column dropped below is a
 *    reading.
 *
 * Measured at 390 × 844, not reasoned about: with the widest real content this
 * page can hold — a 36-character device id, a public address, a 20-digit ICCID
 * — the page itself does not overflow, and the four columns left on the devices
 * table fit without the card needing to scroll either. See
 * `notes/T009-devices-table-pattern.md`.
 *
 * ## The read-only gate, which this page did not have
 *
 * Every write on this page is in the card policy card — five of them, each a
 * `PUT` or a `DELETE` that reaches every device in the tenant. Until this card
 * they were drawn for every account, and `viewer@vodoge.com` was offered a tick
 * that blocks a SIM's data fleet-wide and a button that deletes its policy.
 *
 * ⚠️ **Nothing was ever sent by an account that may not send.** The gateway
 * refuses every state-changing request from a read-only session at one
 * chokepoint around its whole route table, so each of those was answered 403.
 * This is not a hole being closed; it is an offer being withdrawn, which is
 * courtesy rather than a permission model. The model is the gateway's, and
 * `/v1` is reachable with curl and a token whatever this page draws.
 *
 * The role comes from `fetchConsoleRole`, which is the same eighteen lines
 * `/settings` and both inbox pages each keep a copy of, already extracted and
 * already used by `/proxy`. Calling the shared one rather than pasting a fourth
 * copy is the whole reason it exists; it fails closed and never throws, which
 * is why it sits outside the `try` below — a role that could not be established
 * is `readonly`, and that is an answer, while a catalogue read that failed is a
 * page saying it could not load.
 *
 * ## What did not change
 *
 * The three fetches, the failure case, both empty cases and every value shown
 * are what they were. `locale` is resolved on the server and passed down, never
 * read from a cookie in an effect — this console has shipped that bug twice and
 * it renders the server's HTML in the default language every time.
 */
export default async function DevicesPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  const writable = mayWrite(await fetchConsoleRole(host, token));

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
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("devices.title", locale)}</h1>
          <p className={PAGE.description}>{t("devices.desc", locale)}</p>
        </div>
        {/* The same badge, in the same slot, as `/settings` and both inbox
            pages. It says why the controls further down are missing, which is
            the question an operator asks before they ask anything else. */}
        {writable ? null : (
          <div className={PAGE.actions}>
            <Badge tone="warn" dot={false}>
              {t("role.readOnlyBadge", locale)}
            </Badge>
          </div>
        )}
      </div>

      {loadError ? <p className={PAGE.error}>{t("devices.loadError", locale)}</p> : null}

      <div className={PAGE.stack}>
        <Card bodyless>
          {devices.length === 0 ? (
            <CardEmpty
              title={t("empty.devices.title", locale)}
              description={t("empty.devices.desc", locale)}
            />
          ) : (
            <Table>
              <TableHead>
                <TableRow head>
                  <TableHeaderCell>{t("devices.colName", locale)}</TableHeaderCell>
                  <TableHeaderCell secondary>{t("devices.colId", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("devices.colState", locale)}</TableHeaderCell>
                  <TableHeaderCell secondary>
                    {t("devices.colVersionShort", locale)}
                  </TableHeaderCell>
                  <TableHeaderCell>{t("devices.colQueue", locale)}</TableHeaderCell>
                  <TableHeaderCell secondary>
                    {t("devices.colPublicIp", locale)}
                  </TableHeaderCell>
                  <TableHeaderCell secondary>{t("devices.colHostCpu", locale)}</TableHeaderCell>
                  <TableHeaderCell secondary>
                    {t("devices.colHostMemory", locale)}
                  </TableHeaderCell>
                  <TableHeaderCell>{t("devices.colLastSeen", locale)}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {devices.map((device) => (
                  <TableRow key={device.id}>
                    {/* The name is the way in to everything else about this
                        box, so it is the one column that survives every
                        breakpoint. */}
                    <TableCell>
                      <Link className={TABLE.cellLink} href={`/devices/${device.id}`}>
                        {device.name}
                      </Link>
                    </TableCell>
                    <TableCell mono faint secondary>
                      {device.id}
                    </TableCell>
                    <TableCell>
                      <StateBadge
                        state={device.state}
                        label={t(`state.${device.state}`, locale)}
                      />
                    </TableCell>
                    <TableCell mono faint secondary>
                      {device.edgeVersion ?? "—"}
                    </TableCell>
                    <TableCell mono>
                      {/* A backlog is the number worth seeing at a glance:
                          a device that is online and behind looks healthy
                          everywhere else. That is also why it stays on the
                          phone while the host readings do not. */}
                      {device.queueRecords === null ? (
                        "—"
                      ) : device.queueRecords > 0 ? (
                        <Badge tone="warn" dot={false}>
                          {device.queueRecords}
                        </Badge>
                      ) : (
                        <span className={TABLE.cellFaint}>0</span>
                      )}
                    </TableCell>
                    {/* The one fact about the egress path the box cannot
                        work out for itself: every interface it owns has a
                        private address. */}
                    <TableCell mono secondary>
                      {device.publicIp ?? "—"}
                    </TableCell>
                    <TableCell mono secondary>
                      {device.cpuPercent === null ? "—" : `${device.cpuPercent.toFixed(1)}%`}
                    </TableCell>
                    <TableCell mono secondary>
                      <HostMemory
                        used={device.memoryUsedBytes}
                        total={device.memoryTotalBytes}
                      />
                    </TableCell>
                    <TableCell mono faint>
                      {device.lastSeen
                        ? new Date(device.lastSeen).toISOString().replace("T", " ").slice(0, 19)
                        : t("common.never", locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card title={t("devices.modems", locale)} note={t("devices.modemsNote", locale)} bodyless>
          {modems.length === 0 ? (
            <CardEmpty
              title={t("empty.modems.title", locale)}
              description={t("empty.modems.desc", locale)}
            />
          ) : (
            <Table>
              <TableHead>
                <TableRow head>
                  <TableHeaderCell>{t("modems.colImei", locale)}</TableHeaderCell>
                  {/* The widest value in the console: nineteen or twenty
                      digits of monospace, and the identity of the
                      subscription rather than of the module the row is
                      about. */}
                  <TableHeaderCell secondary>{t("modems.colIccid", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("modems.colNetwork", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("modems.colState", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("modems.colSignal", locale)}</TableHeaderCell>
                  <TableHeaderCell secondary title={t("modems.qualityHint", locale)}>
                    {t("modems.colQuality", locale)}
                  </TableHeaderCell>
                  <TableHeaderCell secondary>{t("modems.colSms", locale)}</TableHeaderCell>
                  <TableHeaderCell secondary>{t("modems.colSeen", locale)}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {modems.map((modem) => (
                  <TableRow key={modem.id}>
                    <TableCell mono>
                      <span className={TABLE.cellInline}>
                        {modem.imei}
                        {/* Visible but not drivable. Before the edge enumerated
                            AT ports as a second path, a module in this state
                            did not appear at all. */}
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
                      <ModemNetwork
                        home={modem.homePlmn}
                        serving={modem.servingPlmn}
                        locale={locale}
                      />
                    </TableCell>
                    <TableCell>
                      <StateBadge state={modem.state ?? "unknown"} />
                    </TableCell>
                    <TableCell mono>
                      {modem.signalDbm === null ? "—" : `${modem.signalDbm} dBm`}
                    </TableCell>
                    <TableCell mono secondary>
                      <ModemQuality rsrp={modem.rsrp} rsrq={modem.rsrq} sinr={modem.sinr} />
                    </TableCell>
                    <TableCell secondary>
                      {/* The bearer the edge resolved. A blank here means the
                          matrix has no answer for this combination, which is
                          different from "cannot send" — and a transport is a
                          category rather than a state, so it takes no dot. */}
                      <Badge tone="neutral" dot={false}>
                        {modem.smsMt ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell mono faint secondary>
                      {modem.lastSeen
                        ? new Date(modem.lastSeen).toISOString().replace("T", " ").slice(0, 19)
                        : t("common.never", locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card title={t("cards.title", locale)} note={t("cards.note", locale)}>
          <CardPolicies
            policies={policies}
            // Required, not defaulted. An omitted boolean reads as `true` at
            // the only place it is tested, and "forgot to pass it" would then
            // draw exactly the five controls this gate exists to withhold.
            writable={writable}
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
              // Read-only keeps the table and loses the controls. Hiding the
              // whole card would take away the answer to "where did the
              // policies go"; a sentence in place of the add form says which
              // of the two it is.
              readOnly: t("role.readOnlyCards", locale),
            }}
            confirmLabels={{
              question: t("confirm.question", locale),
              proceed: t("confirm.proceed", locale),
              cancel: t("confirm.cancel", locale),
            }}
            // Resolved from the ledger rather than listed here, so a sixth kind
            // of edit cannot arrive with its consequence left in English or
            // left out. The ledger is what `tokens.test.ts` holds to the
            // consequence rule in both languages.
            confirmations={
              Object.fromEntries(
                Object.entries(CARD_POLICY_CONFIRMATIONS).map(([guard, keys]) => [
                  guard,
                  {
                    title: t(keys.title, locale),
                    consequence: t(keys.consequence, locale),
                  },
                ]),
              ) as Record<CardPolicyGuard, { title: string; consequence: string }>
            }
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
 * Memory as a share of the box rather than a byte count.
 *
 * A raw figure means nothing without knowing the machine; a percentage is
 * comparable across a fleet at a glance. The exact bytes are on the device
 * page, where there is room to say what they are out of.
 */
function HostMemory({ used, total }: { used: number | null; total: number | null }) {
  if (used === null || total === null || total === 0) {
    return <span className={TABLE.cellFaint}>—</span>;
  }
  return <span>{Math.round((used / total) * 100)}%</span>;
}
