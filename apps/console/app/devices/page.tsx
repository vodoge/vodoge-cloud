import Link from "next/link";
import { Badge, StateBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardEmpty, CardPanel as Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
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
  fetchAlerts,
  fetchModems,
  type CardPolicyRow,
  type DeviceRow,
  alertTone,
  type AlertRow,
  type ModemRow,
} from "@/lib/catalog";
import { isRoaming, operatorName, territoryFlag, territoryName } from "@/lib/plmn";
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
/**
 * Search and ordering live in the URL rather than in component state.
 *
 * This page is a server component that renders three tables from one load, and
 * a filter box would have made it a client one — pulling the whole thing, and
 * the fetches it does, across the boundary to hide rows that are already on
 * screen. In the URL the work stays on the server, a filtered view is a link
 * somebody can send, and the page keeps working with no JavaScript at all.
 */
export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const query = await searchParams;
  const needle = (query.q ?? "").trim().toLowerCase();
  const order = query.sort === "signal" || query.sort === "seen" ? query.sort : "imei";
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  const writable = mayWrite(await fetchConsoleRole(host, token));

  let devices: DeviceRow[] = [];
  let modems: ModemRow[] = [];
  let policies: CardPolicyRow[] = [];
  // What the agents announced, without anybody having to go and read a log.
  // On this page rather than the landing page on purpose: the install
  // screenshots are of the landing page, and a card added there would make
  // the PWA's install dialog advertise chrome this tree no longer renders.
  let alerts: AlertRow[] = [];
  let loadError = false;
  try {
    [devices, modems, policies, alerts] = await Promise.all([
      fetchDevices(host, token),
      fetchModems(host, token),
      fetchCardPolicies(host, token),
      fetchAlerts(host, token, undefined, 20),
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
        <Card title={t("alerts.title", locale)} note={t("alerts.note", locale)} bodyless>
          {alerts.length === 0 ? (
            <CardEmpty title={t("alerts.none", locale)} />
          ) : (
            <Table>
              <TableHead>
                <TableRow head>
                  <TableHeaderCell>{t("alerts.colLevel", locale)}</TableHeaderCell>
                  <TableHeaderCell>{t("alerts.colCode", locale)}</TableHeaderCell>
                  <TableHeaderCell secondary>{t("alerts.colMessage", locale)}</TableHeaderCell>
                  <TableHeaderCell secondary>{t("alerts.colWhen", locale)}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {alerts.map((alert) => (
                  <TableRow key={alert.id}>
                    <TableCell>
                      <Badge tone={alertTone(alert.level)}>{alert.level}</Badge>
                    </TableCell>
                    <TableCell mono>
                      <span className={TABLE.cellInline}>
                        {alert.code}
                        {/* How many were held back since this code was last
                            announced. The number that says "still happening"
                            rather than "happened again". */}
                        {typeof alert.context.repeats === "number" ? (
                          <span className={TABLE.cellFaint}>
                            ×{alert.context.repeats + 1}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell mono faint secondary>
                      {alert.message}
                    </TableCell>
                    <TableCell mono faint secondary>
                      {new Date(alert.occurredAt)
                        .toISOString()
                        .replace("T", " ")
                        .slice(0, 19)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

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
          {/* A plain GET form: the filter is the URL, so this works with no
              JavaScript and a filtered view is a link. */}
          <form className={PAGE.section} method="get">
            <Field label={t("modems.search", locale)} inline>
              <Input name="q" defaultValue={needle} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label={t("modems.sort", locale)} inline>
              <Select compact name="sort" defaultValue={order}>
                <option value="imei">{t("modems.sortImei", locale)}</option>
                <option value="signal">{t("modems.sortSignal", locale)}</option>
                <option value="seen">{t("modems.sortSeen", locale)}</option>
              </Select>
            </Field>
            <Button type="submit">{t("modems.apply", locale)}</Button>
          </form>
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
                {orderModems(matchingModems(modems, needle), order).map((modem) => (
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
                      {/* Both directions. Receiving was shown alone here for a
                          while, which made a card that can take a message and
                          not send one look fully capable — and that pair is
                          exactly what the Club profile on this bench is.
                          A transport is a category rather than a state, so it
                          takes no dot. */}
                      <span className={TABLE.cellInline}>
                        <Badge tone="neutral" dot={false}>
                          ↓ {modem.smsMt ?? "—"}
                        </Badge>
                        <Badge tone="neutral" dot={false}>
                          ↑ {modem.smsMo ?? "—"}
                        </Badge>
                        {/* Not a rule but a fallback: nobody has characterised
                            this (family, carrier) pair at all, which is the one
                            state a new ledger entry would fix. */}
                        {modem.capabilityOrigin === "fallback" ? (
                          <Badge tone="warn" title={t("modems.uncharacterisedHint", locale)}>
                            {t("modems.uncharacterised", locale)}
                          </Badge>
                        ) : null}
                      </span>
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
  // Decorative: the territory name beside it already says the same thing, and
  // a screen reader spelling out "regional indicator symbol letter U" helps
  // nobody.
  const flag = territoryFlag(identity);
  const roaming = home !== null && serving !== null && isRoaming(home, serving);
  return (
    <span className={TABLE.cellInline}>
      <span>
        {flag ? <span aria-hidden="true">{flag} </span> : null}
        {operatorName(identity)}
        {territory ? <span className={TABLE.cellFaint}> · {territory}</span> : null}
      </span>
      {roaming ? (
        <Badge tone="warn">
          {t("modems.roaming", locale)} → {territoryFlag(serving) ? (
            <span aria-hidden="true">{territoryFlag(serving)} </span>
          ) : null}
          {operatorName(serving)}
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

/**
 * The modules whose identity contains `needle`.
 *
 * Matches across IMEI, ICCID, family and both networks, because an operator
 * looking for a stick has whichever of those they happen to be holding — a
 * label off the hardware, a number off a bill, or an operator name from a
 * screenshot. An empty needle matches everything rather than nothing: a blank
 * search box is not a filter.
 */
function matchingModems(modems: ModemRow[], needle: string): ModemRow[] {
  if (needle === "") return modems;
  return modems.filter((modem) =>
    [modem.imei, modem.iccid, modem.family, modem.homePlmn, modem.servingPlmn, modem.msisdn]
      .some((field) => (field ?? "").toLowerCase().includes(needle)),
  );
}

/**
 * Ordering, with a total order in every case.
 *
 * Each comparison falls through to the IMEI, so two modules with the same
 * signal or no reading at all still come out in a stable order. Without that
 * the list reshuffles between polls and a row moves under the cursor.
 *
 * A missing reading sorts last rather than as zero: a module that could not be
 * measured is not a module with the worst signal in the fleet.
 */
function orderModems(modems: ModemRow[], order: string): ModemRow[] {
  const sorted = modems.slice();
  sorted.sort((left, right) => {
    if (order === "signal") {
      const a = left.signalDbm ?? Number.NEGATIVE_INFINITY;
      const b = right.signalDbm ?? Number.NEGATIVE_INFINITY;
      if (a !== b) return b - a;
    }
    if (order === "seen") {
      const a = left.lastSeen ?? 0;
      const b = right.lastSeen ?? 0;
      if (a !== b) return b - a;
    }
    return left.imei.localeCompare(right.imei);
  });
  return sorted;
}
