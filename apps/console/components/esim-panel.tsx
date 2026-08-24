"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  parseEsimInfoResult,
  parseRetrievedNotification,
  type EsimInfoResult,
  type EsimProfileRow,
  type RetrievedNotification,
} from "@/lib/catalog";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, t, type Locale } from "@/lib/i18n";

type Labels = Record<string, string>;

/** One relayed command, as `GET /v1/commands` reports it. */
type CommandRow = {
  id: string;
  kind: string;
  status: string;
  completed_at: number | null;
  payload: Record<string, unknown> | null;
  result: { status?: string; reason?: string; details?: unknown } | null;
};

const TERMINAL = new Set(["succeeded", "failed", "expired", "cancelled", "unknown"]);

/**
 * What each eUICC holds, and switching between profiles.
 *
 * Deleted profiles are shown rather than hidden. Which ICCID used to be on a
 * chip is exactly what someone needs when a card stops working after a switch,
 * and an inventory that agrees with the chip while disagreeing with history
 * answers the easy question and not the hard one.
 *
 * The chip information below the inventory is not a projection. It is read
 * straight out of the last `read_esim_info` command's result, because a
 * projection would need a table, a writer and a migration to show something
 * that is already in the command log and is only ever looked at right after
 * the button that produced it.
 */
export function EsimPanel({
  deviceId,
  profiles,
  modems,
  labels,
}: {
  deviceId: string;
  profiles: EsimProfileRow[];
  modems: { imei: string }[];
  labels: Labels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandRow[]>([]);
  // The strings the page does not pass down. This component is reached from a
  // server page that hands it a fixed label set, so the ones added here read
  // the locale the same way the device console does.
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  const pending = commands.some(
    (row) => isEsimRead(row.kind) && !TERMINAL.has(row.status),
  );

  const refresh = useCallback(async () => {
    const query = new URLSearchParams({ device_id: deviceId, limit: "60" });
    const response = await fetch(`/v1/commands?${query}`, { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { commands?: CommandRow[] };
    setCommands(body.commands ?? []);
  }, [deviceId]);

  useEffect(() => {
    setLocale(localeFromCookie(document.cookie));
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  async function issue(kind: string, extra: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const response = await fetch("/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, kind, ...extra }),
    });
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || "failed");
      return;
    }
    await refresh();
    router.refresh();
  }

  const byEid = new Map<string, EsimProfileRow[]>();
  for (const profile of profiles) {
    byEid.set(profile.eid, [...(byEid.get(profile.eid) ?? []), profile]);
  }

  const chips = latestChipReads(commands);
  const failedRead = commands.find(
    (row) => row.kind === "read_esim_info" && row.status === "failed",
  );
  const retrieved = latestRetrieval(commands);

  return (
    <div className="stack">
      <div className="button-row">
        {modems.map((modem) => (
          <button
            key={modem.imei}
            type="button"
            disabled={busy}
            onClick={() => void issue("list_esim_profiles", { modem_imei: modem.imei })}
          >
            {labels.refresh} — {modem.imei}
          </button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {profiles.length === 0 ? (
        <p className="faint">{labels.none}</p>
      ) : (
        [...byEid.entries()].map(([eid, rows]) => (
          <section key={eid} className="stack">
            <h4 className="section-title mono">
              {labels.colEid} {eid}
            </h4>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{labels.colIccid}</th>
                    <th>{labels.colNickname}</th>
                    <th>{labels.colState}</th>
                    <th>{labels.colCollected}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((profile) => (
                    <tr key={profile.iccid}>
                      <td className="mono">{profile.iccid}</td>
                      <td>{profile.nickname ?? <span className="faint">—</span>}</td>
                      <td>
                        <StateBadge state={profile.state} />
                      </td>
                      <td className="mono faint">
                        {new Date(profile.collectedAt)
                          .toISOString()
                          .replace("T", " ")
                          .slice(0, 16)}
                      </td>
                      <td className="row-actions">
                        {/* Only a disabled profile can be switched to, and a
                            deleted one is not on the chip at all. */}
                        {profile.state === "disabled" && profile.modemImei ? (
                          <button
                            type="button"
                            className="risk"
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm(labels.confirmSwitch)) return;
                              void issue("switch_esim_profile", {
                                modem_imei: profile.modemImei,
                                target_iccid: profile.iccid,
                              });
                            }}
                          >
                            {labels.switch}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      <h4 className="section-title">{t("esim.chipTitle", locale)}</h4>
      <div className="button-row">
        {modems.map((modem) => (
          <button
            key={`chip-${modem.imei}`}
            type="button"
            disabled={busy}
            onClick={() => void issue("read_esim_info", { modem_imei: modem.imei })}
          >
            {t("esim.readChip", locale)} — {modem.imei}
          </button>
        ))}
      </div>
      {pending ? <p className="faint">{t("esim.chipBusy", locale)}</p> : null}
      {failedRead ? (
        <p className="error">
          {t("esim.chipFailed", locale)}: {failedRead.result?.reason ?? ""}
        </p>
      ) : null}

      {chips.length === 0 ? (
        <p className="faint">{t("esim.noChip", locale)}</p>
      ) : (
        chips.map(({ info, completedAt }) => (
          <section key={info.eid} className="stack">
            <h4 className="section-title mono">
              {labels.colEid} {info.eid}
            </h4>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("esim.colField", locale)}</th>
                    <th>{t("esim.colValue", locale)}</th>
                  </tr>
                </thead>
                <tbody>
                  {chipFields(info, locale).map(([field, value]) => (
                    <tr key={field}>
                      <td>{field}</td>
                      <td className="mono">{value}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>{t("esim.readAt", locale)}</td>
                    <td className="mono faint">
                      {completedAt
                        ? new Date(completedAt).toISOString().replace("T", " ").slice(0, 19)
                        : "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h4 className="section-title">{t("esim.notifications", locale)}</h4>
            {info.notificationsError ? (
              <p className="error">{info.notificationsError}</p>
            ) : null}
            {info.notifications.length === 0 ? (
              <p className="faint">{t("esim.noNotifications", locale)}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("esim.colSeq", locale)}</th>
                      <th>{t("esim.colOperation", locale)}</th>
                      <th>{t("esim.colAddress", locale)}</th>
                      <th>{labels.colIccid}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {info.notifications.map((notification) => (
                      <tr key={`${info.eid}-${notification.sequenceNumber}`}>
                        <td className="mono">{notification.sequenceNumber}</td>
                        <td>{notification.operations.join(", ") || "—"}</td>
                        <td className="mono">{notification.address}</td>
                        <td className="mono">{notification.iccid ?? "—"}</td>
                        <td className="row-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void issue("retrieve_esim_notification", {
                                modem_imei: info.imei,
                                sequence_number: notification.sequenceNumber,
                              })
                            }
                          >
                            {t("esim.retrieve", locale)}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))
      )}

      {retrieved ? (
        <p className="faint">
          {t("esim.retrieved", locale, {
            seq: retrieved.sequenceNumber,
            bytes: retrieved.payloadBytes,
            address: retrieved.address,
          })}{" "}
          {retrieved.delivered ? null : (
            <strong>
              {t("esim.notDelivered", locale, { why: retrieved.deliveryBlockedBy ?? "" })}
            </strong>
          )}
        </p>
      ) : null}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "enabled"
      ? "badge-ok"
      : state === "deleted"
        ? "badge-bad"
        : "badge-idle";
  return <span className={`badge ${tone}`}>{state}</span>;
}

function isEsimRead(kind: string): boolean {
  return kind === "read_esim_info" || kind === "retrieve_esim_notification";
}

/**
 * The most recent successful chip reading per EID.
 *
 * Per EID rather than per IMEI on purpose: the EID is the chip, and a module
 * that was read twice should not produce two entries that disagree.
 */
function latestChipReads(
  commands: CommandRow[],
): { info: EsimInfoResult; completedAt: number | null }[] {
  const seen = new Map<string, { info: EsimInfoResult; completedAt: number | null }>();
  for (const row of commands) {
    if (row.kind !== "read_esim_info" || row.status !== "succeeded") continue;
    const info = parseEsimInfoResult(row.result?.details);
    if (!info) continue;
    const existing = seen.get(info.eid);
    if (existing && (existing.completedAt ?? 0) >= (row.completed_at ?? 0)) continue;
    seen.set(info.eid, { info, completedAt: row.completed_at });
  }
  return [...seen.values()].sort((left, right) => left.info.eid.localeCompare(right.info.eid));
}

function latestRetrieval(commands: CommandRow[]): RetrievedNotification | null {
  let best: { row: CommandRow; value: RetrievedNotification } | null = null;
  for (const row of commands) {
    if (row.kind !== "retrieve_esim_notification" || row.status !== "succeeded") continue;
    const value = parseRetrievedNotification(row.result?.details);
    if (!value) continue;
    if (best && (best.row.completed_at ?? 0) >= (row.completed_at ?? 0)) continue;
    best = { row, value };
  }
  return best?.value ?? null;
}

/**
 * Every field the chip reported, in one list.
 *
 * Rendered from the decoded values rather than from a fixed subset: the free
 * non-volatile memory decides whether a profile will fit, and the CI key list
 * decides whether it can be verified at all. Both were invisible while this
 * command only said whether the read succeeded.
 */
function chipFields(info: EsimInfoResult, locale: Locale): [string, string][] {
  const chip = info.chip;
  const rows: [string, string | null][] = [
    [t("esim.fProfileVersion", locale), chip.profileVersion],
    [t("esim.fSgp22", locale), chip.sgp22Version],
    [t("esim.fFirmware", locale), chip.firmwareVersion],
    [t("esim.fInstalledApps", locale), numberOrNull(chip.installedApplications)],
    [t("esim.fFreeNvm", locale), bytesOrNull(chip.freeNonVolatileMemory, locale)],
    [t("esim.fFreeVolatile", locale), bytesOrNull(chip.freeVolatileMemory, locale)],
    [t("esim.fGp", locale), chip.globalPlatformVersion],
    [t("esim.fTs102241", locale), chip.ts102241Version],
    [t("esim.fCategory", locale), numberOrNull(chip.category)],
    [t("esim.fPpVersion", locale), chip.ppVersion],
    [t("esim.fSas", locale), chip.sasAccreditationNumber],
    [t("esim.fRsp", locale), listOrNull(chip.rspCapabilities)],
    [t("esim.fUicc", locale), listOrNull(chip.uiccCapabilities)],
    [t("esim.fCiVerify", locale), listOrNull(chip.ciKeyIdsForVerification)],
    [t("esim.fCiSign", locale), listOrNull(chip.ciKeyIdsForSigning)],
    [t("esim.fForbiddenPpr", locale), listOrNull(chip.forbiddenProfilePolicyRules)],
    [t("esim.fDecoded", locale), String(chip.decodedFields)],
  ];
  return rows.map(([field, value]) => [field, value ?? "—"]);
}

function numberOrNull(value: number | null): string | null {
  return value === null ? null : String(value);
}

function bytesOrNull(value: number | null, locale: Locale): string | null {
  return value === null ? null : t("esim.bytes", locale, { count: value.toLocaleString("en-US") });
}

function listOrNull(values: string[]): string | null {
  return values.length === 0 ? null : values.join(", ");
}

function localeFromCookie(cookies: string): Locale {
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LOCALE_COOKIE) {
      const value = decodeURIComponent(rest.join("="));
      if (isLocale(value)) return value;
    }
  }
  return DEFAULT_LOCALE;
}
