"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  parseEsimAuthentication,
  parseEsimDownload,
  parseEsimInfoResult,
  parseRetrievedNotification,
  type EsimAuthentication,
  type EsimDownload,
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
  // Held only until the request goes out. An activation code is a one-time
  // credential, so it lives in this component and nowhere else -- not in the
  // URL, not in a form that survives a reload, and not in the command result
  // the edge sends back.
  const [activationCode, setActivationCode] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");

  const pending = commands.some(
    (row) => isEsimRead(row.kind) && !TERMINAL.has(row.status),
  );
  // Tracked separately from the chip reads. An ES9+ round trip runs for a
  // second or two against a server on another continent, and folding it into
  // the same flag would leave the chip section saying "waiting" for a command
  // that has nothing to do with it.
  const authPending = commands.some(
    (row) => row.kind === "initiate_esim_authentication" && !TERMINAL.has(row.status),
  );
  // A download runs for tens of seconds: an ES9+ round trip on either side of
  // a profile package fed to the card in 255-byte blocks. Its own flag, so the
  // page keeps polling for it after the shorter commands have settled.
  const downloadPending = commands.some(
    (row) => row.kind === "download_esim_profile" && !TERMINAL.has(row.status),
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
    if (!pending && !authPending && !downloadPending) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [pending, authPending, downloadPending, refresh]);

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
  const authentications = latestAuthentications(commands);
  // Only if it is more recent than every success. A banner saying the last
  // authentication failed, sitting above a table of an exchange that worked,
  // is a page arguing with itself -- and the reader has no way to tell which
  // half is stale.
  const failedAuthentication = newestFailureAfterSuccess(
    commands,
    "initiate_esim_authentication",
  );
  const downloads = latestDownloads(commands);
  const failedDownload = newestFailureAfterSuccess(commands, "download_esim_profile");

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

      <h4 className="section-title">{t("esim.authTitle", locale)}</h4>
      <div className="button-row">
        {modems.map((modem) => (
          <button
            key={`auth-${modem.imei}`}
            type="button"
            disabled={busy}
            onClick={() =>
              void issue("initiate_esim_authentication", { modem_imei: modem.imei })
            }
          >
            {t("esim.authStart", locale)} — {modem.imei}
          </button>
        ))}
      </div>
      {authPending ? <p className="faint">{t("esim.authBusy", locale)}</p> : null}
      {failedAuthentication ? (
        <p className="error">
          {t("esim.authFailed", locale)}: {failedAuthentication.result?.reason ?? ""}
        </p>
      ) : null}
      {authentications.length === 0 ? (
        <p className="faint">{t("esim.authNone", locale)}</p>
      ) : (
        authentications.map(({ authentication, completedAt }) => (
          <AuthenticationSection
            key={`${authentication.eid}-${authentication.transactionId}`}
            authentication={authentication}
            completedAt={completedAt}
            locale={locale}
          />
        ))
      )}

      <h4 className="section-title">{t("esim.dlTitle", locale)}</h4>
      <p className="faint">{t("esim.dlSecret", locale)}</p>
      <div className="stack">
        <label>
          {t("esim.dlCode", locale)}
          <input
            type="text"
            value={activationCode}
            spellCheck={false}
            autoComplete="off"
            placeholder="LPA:1$smdp.example.com$MATCHING-ID"
            onChange={(event) => setActivationCode(event.target.value)}
          />
        </label>
        <label>
          {t("esim.dlConfirm", locale)}
          <input
            type="text"
            value={confirmationCode}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setConfirmationCode(event.target.value)}
          />
        </label>
      </div>
      <div className="button-row">
        {modems.map((modem) => (
          <button
            key={`download-${modem.imei}`}
            type="button"
            className="risk"
            disabled={busy || activationCode.trim() === ""}
            onClick={() => {
              if (!window.confirm(t("esim.dlWarn", locale))) return;
              const code = activationCode.trim();
              const confirmation = confirmationCode.trim();
              // Cleared before the request rather than after it. The code is a
              // one-time credential and leaving it in a field invites a second
              // click that spends an order which no longer exists.
              setActivationCode("");
              setConfirmationCode("");
              void issue("download_esim_profile", {
                modem_imei: modem.imei,
                activation_code: code,
                ...(confirmation === "" ? {} : { confirmation_code: confirmation }),
              });
            }}
          >
            {t("esim.dlStart", locale)} — {modem.imei}
          </button>
        ))}
      </div>
      {downloadPending ? <p className="faint">{t("esim.dlBusy", locale)}</p> : null}
      {failedDownload ? (
        <p className="error">
          {t("esim.dlFailed", locale)}: {failedDownload.result?.reason ?? ""}
        </p>
      ) : null}
      {downloads.length === 0 ? (
        <p className="faint">{t("esim.dlNone", locale)}</p>
      ) : (
        downloads.map(({ download, completedAt }) => (
          <DownloadSection
            key={`${download.eid}-${download.transactionId}`}
            download={download}
            completedAt={completedAt}
            locale={locale}
          />
        ))
      )}
    </div>
  );
}

/**
 * One ES9+ exchange, rendered as evidence rather than as a status.
 *
 * The checks are listed individually and by name. A green tick that means
 * "the command returned" is exactly the failure this project has hit before:
 * four buttons rendering perfectly while every request behind them was 401.
 */
function AuthenticationSection({
  authentication,
  completedAt,
  locale,
}: {
  authentication: EsimAuthentication;
  completedAt: number | null;
  locale: Locale;
}) {
  const checks: [string, boolean][] = [
    [t("esim.checkCert", locale), authentication.certificateSignedByCi],
    [t("esim.checkSignature", locale), authentication.serverSignatureValid],
    [t("esim.checkChallenge", locale), authentication.challengeEchoed],
    [t("esim.checkCiKey", locale), authentication.ciKeyAcceptedByChip],
  ];
  return (
    <section className="stack">
      <h4 className="section-title mono">
        {t("esim.aSmdp", locale)} {authentication.smdpAddress} · {authentication.eid}
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
            {authenticationFields(authentication, locale).map(([field, value]) => (
              <tr key={field}>
                <td>{field}</td>
                <td className="mono">{value}</td>
              </tr>
            ))}
            <tr>
              <td>{t("esim.authAt", locale)}</td>
              <td className="mono faint">
                {completedAt
                  ? new Date(completedAt).toISOString().replace("T", " ").slice(0, 19)
                  : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h4 className="section-title">{t("esim.checksTitle", locale)}</h4>
      <div className="table-wrap">
        <table>
          <tbody>
            {checks.map(([label, passed]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  <span className={`badge ${passed ? "badge-ok" : "badge-bad"}`}>
                    {passed ? t("esim.checkYes", locale) : t("esim.checkNo", locale)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="section-title">{t("esim.aAnchors", locale)}</h4>
      <div className="table-wrap">
        <table>
          <tbody>
            {authentication.trustAnchors.map((anchor) => (
              <tr key={anchor.label}>
                <td className="mono">{anchor.label}</td>
                <td className="mono">{anchor.keyId}</td>
                <td className="mono faint">{anchor.notAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {authentication.profileDownloaded ? null : (
        <p className="faint">
          <strong>
            {t("esim.authStopped", locale, { why: authentication.stoppedAfter ?? "" })}
          </strong>
        </p>
      )}
    </section>
  );
}

function authenticationFields(
  authentication: EsimAuthentication,
  locale: Locale,
): [string, string][] {
  const source =
    authentication.smdpAddressSource === "request"
      ? t("esim.aSourceRequest", locale)
      : authentication.smdpAddressSource === "euicc_configured_addresses"
        ? t("esim.aSourceConfigured", locale)
        : authentication.smdpAddressSource === "pending_notification"
          ? t("esim.aSourceNotification", locale)
          : authentication.smdpAddressSource;
  const rows: [string, string | null][] = [
    // Also in the heading above, but the heading is styled uppercase and a
    // host name in capitals is not the string anyone should be comparing
    // against a notification address or an activation code.
    [t("esim.aSmdp", locale), authentication.smdpAddress],
    [t("esim.aSmdpSource", locale), source],
    [t("esim.aTransaction", locale), authentication.transactionId],
    [t("esim.aChallenge", locale), authentication.euiccChallenge],
    [t("esim.aEchoed", locale), authentication.echoedEuiccChallenge],
    [t("esim.aServerChallenge", locale), authentication.serverChallenge],
    [t("esim.aCiChosen", locale), authentication.euiccCiPkidToBeUsed],
    [t("esim.aCertKey", locale), authentication.certificateKeyId],
    [t("esim.aCertAuthority", locale), authentication.certificateAuthorityKeyId],
    [t("esim.aCertSha", locale), authentication.certificateSha256],
    [t("esim.aCertExpiry", locale), authentication.certificateNotAfter],
    [t("esim.aAnchorUsed", locale), authentication.trustAnchorLabel],
    [t("esim.aTrustDir", locale), authentication.trustDirectory],
    [t("esim.aTls", locale), authentication.negotiatedTls],
    [t("esim.aAdminProtocol", locale), authentication.adminProtocol],
    [
      t("esim.aElapsed", locale),
      t("esim.aMs", locale, { count: authentication.elapsedMs }),
    ],
  ];
  return rows.map(([field, value]) => [field, value ?? "—"]);
}

/**
 * The most recent successful exchange per EID.
 *
 * Keyed by EID for the same reason the chip readings are: the chip is what a
 * transaction was about, and one module read twice should not appear twice
 * with different answers.
 */
function latestAuthentications(
  commands: CommandRow[],
): { authentication: EsimAuthentication; completedAt: number | null }[] {
  const seen = new Map<
    string,
    { authentication: EsimAuthentication; completedAt: number | null }
  >();
  for (const row of commands) {
    if (row.kind !== "initiate_esim_authentication" || row.status !== "succeeded") continue;
    const authentication = parseEsimAuthentication(row.result?.details);
    if (!authentication) continue;
    const existing = seen.get(authentication.eid);
    if (existing && (existing.completedAt ?? 0) >= (row.completed_at ?? 0)) continue;
    seen.set(authentication.eid, { authentication, completedAt: row.completed_at });
  }
  return [...seen.values()].sort((left, right) =>
    left.authentication.eid.localeCompare(right.authentication.eid),
  );
}


/**
 * One download, rendered as before-and-after rather than as a verdict.
 *
 * The command reporting success is the weakest thing on this page. The strong
 * things are next to it: a profile list that grew by one, a free-memory figure
 * that fell by roughly the size of the package, and a notification the card no
 * longer owes anybody. Those came off the chip.
 */
function DownloadSection({
  download,
  completedAt,
  locale,
}: {
  download: EsimDownload;
  completedAt: number | null;
  locale: Locale;
}) {
  const before = download.before;
  const after = download.after;
  const rows: [string, string | null][] = [
    [t("esim.dlProfile", locale), download.profileName],
    [t("esim.dlProvider", locale), download.serviceProviderName],
    [t("esim.dlIccid", locale), download.installationIccid ?? download.profileIccid],
    [
      t("esim.dlPolicy", locale),
      download.policyRules.length === 0 ? t("esim.dlNoPolicy", locale) : download.policyRules.join(", "),
    ],
    [t("esim.dlFreeBefore", locale), bytesOrNull(before.freeNonVolatileMemory, locale)],
    [t("esim.dlFreeAfter", locale), bytesOrNull(after?.freeNonVolatileMemory ?? null, locale)],
    [t("esim.dlConsumed", locale), bytesOrNull(download.freeMemoryConsumed, locale)],
    [t("esim.dlBppBytes", locale), bytesOrNull(download.boundProfilePackageBytes, locale)],
    [
      t("esim.dlBppBlocks", locale),
      `${download.boundProfilePackageBlocks} (${download.boundProfilePackageSegments.length} ${t("esim.dlSegments", locale)})`,
    ],
    [t("esim.dlAuthBlocks", locale), numberOrNull(download.authenticateServerBlocks)],
    [t("esim.dlPrepareBlocks", locale), numberOrNull(download.prepareDownloadBlocks)],
    [t("esim.dlNotifSeq", locale), numberOrNull(download.notificationSequenceNumber)],
    [
      t("esim.dlNotifPending", locale),
      after
        ? `${download.notificationsPendingBefore} → ${download.notificationsPendingAfter ?? "?"}`
        : null,
    ],
    [t("esim.aTransaction", locale), download.transactionId],
    [t("esim.aSmdp", locale), download.smdpAddress],
    [t("esim.aTls", locale), download.negotiatedTls],
  ];
  const checks: [string, boolean][] = [
    [t("esim.dlInstalled", locale), download.installed],
    // Rendered as a check that has to be *false*. Installing and enabling are
    // separate operations and only one of them was asked for; a page that left
    // this out would let "downloaded" be read as "in use".
    [t("esim.dlNotEnabled", locale), !download.enabled],
    [t("esim.dlNotifDelivered", locale), download.notificationDelivered],
    [t("esim.dlNotifRemoved", locale), download.notificationRemovedCode === 0],
    [t("esim.checkCert", locale), download.certificateSignedByCi],
    [t("esim.checkCiKey", locale), download.ciKeyAcceptedByChip],
  ];
  return (
    <section className="stack">
      <h4 className="section-title mono">
        {download.eid} · {download.imei}
      </h4>
      {download.refusedPolicyRules.length > 0 ? (
        <p className="error">
          <strong>
            {t("esim.dlRefused", locale, { rules: download.refusedPolicyRules.join(", ") })}
          </strong>
        </p>
      ) : null}
      {download.installationError ? (
        <p className="error">
          {t("esim.dlError", locale)}: {download.installationError}
          {download.failedBppCommand ? ` (${download.failedBppCommand})` : ""}
        </p>
      ) : null}
      {download.notificationDeliveryError ? (
        <p className="error">{download.notificationDeliveryError}</p>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("esim.colField", locale)}</th>
              <th>{t("esim.colValue", locale)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([field, value]) => (
              <tr key={field}>
                <td>{field}</td>
                <td className="mono">{value ?? "—"}</td>
              </tr>
            ))}
            <tr>
              <td>{t("esim.authAt", locale)}</td>
              <td className="mono faint">
                {completedAt
                  ? new Date(completedAt).toISOString().replace("T", " ").slice(0, 19)
                  : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="table-wrap">
        <table>
          <tbody>
            {checks.map(([label, passed]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  <span className={`badge ${passed ? "badge-ok" : "badge-bad"}`}>
                    {passed ? t("esim.checkYes", locale) : t("esim.checkNo", locale)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="section-title">{t("esim.dlProfilesAfter", locale)}</h4>
      {after === null || after.profiles.length === 0 ? (
        <p className="faint">—</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("esim.colIccid", locale)}</th>
                <th>{t("esim.colNickname", locale)}</th>
                <th>{t("esim.colState", locale)}</th>
              </tr>
            </thead>
            <tbody>
              {after.profiles.map((profile) => (
                <tr key={profile.iccid}>
                  <td className="mono">{profile.iccid}</td>
                  <td>{profile.label}</td>
                  <td>
                    <StateBadge state={profile.enabled ? "enabled" : "disabled"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {download.stoppedAfter ? (
        <p className="faint">
          <strong>{t("esim.dlStopped", locale, { why: download.stoppedAfter })}</strong>
        </p>
      ) : null}
    </section>
  );
}

/**
 * The most recent download per EID.
 *
 * Keyed by EID rather than by module, for the same reason the chip readings
 * are: the chip is what a download was about.
 */
function latestDownloads(
  commands: CommandRow[],
): { download: EsimDownload; completedAt: number | null }[] {
  const seen = new Map<string, { download: EsimDownload; completedAt: number | null }>();
  for (const row of commands) {
    if (row.kind !== "download_esim_profile" || row.status !== "succeeded") continue;
    const download = parseEsimDownload(row.result?.details);
    if (!download) continue;
    const existing = seen.get(download.eid);
    if (!existing || (row.completed_at ?? 0) >= (existing.completedAt ?? 0)) {
      seen.set(download.eid, { download, completedAt: row.completed_at });
    }
  }
  return [...seen.values()];
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

/**
 * The most recent failure of `kind`, unless a later attempt succeeded.
 *
 * A command list holds every attempt, so "is there a failed one" is almost
 * always yes once anything has ever gone wrong. What a reader needs is
 * whether the situation is currently broken.
 */
function newestFailureAfterSuccess(commands: CommandRow[], kind: string): CommandRow | null {
  let failure: CommandRow | null = null;
  let newestSuccess = -1;
  for (const row of commands) {
    if (row.kind !== kind) continue;
    const at = row.completed_at ?? 0;
    if (row.status === "succeeded" && at > newestSuccess) newestSuccess = at;
    if (row.status === "failed" && (!failure || at > (failure.completed_at ?? 0))) failure = row;
  }
  if (!failure) return null;
  return (failure.completed_at ?? 0) > newestSuccess ? failure : null;
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
