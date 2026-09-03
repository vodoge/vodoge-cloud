"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonRow, RowActions } from "@/components/ui/button-row";
import { CardEmpty, CardPanel as Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, FormError, FormHint, InlineForm, Input, Select } from "@/components/ui/form";
import {
  SpecRow,
  SpecTable,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import {
  ESIM_CHIP_COMMANDS,
  esimProfileRowsFromReads,
  esimReadFailures,
  latestEsimChipReads,
  latestEsimProfileListings,
  mergeCommandBatches,
  mergeEsimProfiles,
  parseEsimAuthentication,
  parseEsimDownload,
  parseRetrievedNotification,
  type EsimAuthentication,
  type EsimCommandRow,
  type EsimDownload,
  type EsimInfoResult,
  type EsimProfileRow,
  type RetrievedNotification,
} from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { mayWrite, roleFromSessionBody, SESSION_ENDPOINT } from "@/lib/session";
import {
  deviceCommandGuard,
  esimSwitchVerdict,
  toneForProfileState,
} from "@/lib/tokens";

/**
 * One relayed command, as `GET /v1/commands` reports it.
 *
 * The fields the eSIM helpers read are declared once in `lib/catalog.ts` and
 * borrowed here. This component has no test of its own and cannot have one --
 * there is no jsdom, no testing-library and no component runner in this
 * workspace -- so anything that decides something lives in the library, and
 * what is left here only renders.
 */
type CommandRow = EsimCommandRow & { id: string };

const TERMINAL = new Set(["succeeded", "failed", "expired", "cancelled", "unknown"]);

/** A command waiting for the operator to answer for it. */
type Pending = {
  readonly consequence: string;
  readonly title: string;
  readonly confirmLabel: string;
  readonly run: () => void;
};

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
 *
 * ## What T011 changed
 *
 * - **One module picker instead of a button per module.** Four controls times
 *   three sticks was twelve buttons before a single profile row was drawn, and
 *   the page survey counted forty-four on this page for that reason. The
 *   request is byte-identical: `modem_imei` is still on every body, it is just
 *   named by a `<select>` rather than by which of three identical buttons was
 *   pressed.
 * - **The switch is never reported as done because the command said so.** See
 *   `esimSwitchVerdict`.
 * - **Four cards, one per section.** The panel used to be one card holding
 *   four `<h4>`s and eight tables.
 */

export function EsimPanel({
  deviceId,
  profiles,
  modems,
  locale,
}: {
  deviceId: string;
  profiles: EsimProfileRow[];
  modems: { imei: string }[];
  /**
   * The locale of the request, resolved on the server.
   *
   * A prop rather than a cookie read in an effect, and that is a bug fix
   * rather than a preference. This panel used to take a handful of strings as
   * a `labels` object the page rendered for it and look every other one up
   * itself against a `useState(DEFAULT_LOCALE)` that became the real locale
   * only after mount. So the markup the server sent always said the default
   * language for those: an English request shipped `<html lang="en">` holding
   * "读取芯片信息", "发起 InitiateAuthentication" and "下载并安装" beside an
   * English "Read the chip", and it corrected itself only once the browser
   * hydrated. Whoever read the served HTML -- the first paint, a slow link, a
   * client with JavaScript off, anything fetching the page -- saw the wrong
   * language, with no error anywhere and no way to tell from the page itself.
   *
   * One locale, arriving before the first render, removes it. It also retires
   * the split label set: two mechanisms for the same sentence are what let
   * half of one panel be right and the other half be wrong at the same time.
   * With every string going through `t()`, a key this build has no entry for
   * renders as ⟦esim.whatever⟧ instead of the empty string an absent `labels`
   * entry used to produce, which is the failure the label gate in front of
   * DeviceConsole (T071) exists to catch.
   */
  locale: Locale;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [imei, setImei] = useState(modems[0]?.imei ?? "");
  const [pending, setPending] = useState<Pending | null>(null);
  // Renaming lives here rather than in a component of its own because the
  // panel's write gate is checked by position: `lib/tokens.test.ts` asks that
  // every control sit inside `{writable ? … }` in this file, and a control in
  // another function is one it cannot see the gate for. Hooks cannot go inside
  // a conditional, so the state is up here and only the markup is gated.
  const [renameIccid, setRenameIccid] = useState("");
  const [renameNickname, setRenameNickname] = useState("");
  // "unknown" until the gateway has been asked, and every control on this
  // tab is drawn for "write" only. Closed by default on purpose: this panel
  // renders on the server before it can ask anything, and a Switch button
  // that appears for one paint and is then taken away is a worse answer than
  // one that appears a paint late.
  const [permission, setPermission] = useState<"unknown" | "write" | "read">("unknown");
  // Held only until the request goes out. An activation code is a one-time
  // credential, so it lives in this component and nowhere else -- not in the
  // URL, not in a form that survives a reload, and not in the command result
  // the edge sends back.
  const [activationCode, setActivationCode] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");

  const reading = commands.some(
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
    const unfilteredQuery = new URLSearchParams({ device_id: deviceId, limit: "60" });
    const unfilteredResp = await fetch(`/v1/commands?${unfilteredQuery}`, { cache: "no-store" });
    const unfilteredCmds: CommandRow[] = unfilteredResp.ok
      ? ((await unfilteredResp.json()) as { commands?: CommandRow[] }).commands ?? []
      : [];

    // Fetch each eSIM chip command kind separately.  The unfiltered window
    // holds the last 60 commands of any kind: if other traffic fills it, an
    // eSIM failure that occurred on day one can silently scroll out.  A
    // kind-filtered query for each entry in ESIM_CHIP_COMMANDS is a
    // purpose-built lens that cannot be crowded out that way.
    const kindBatches = await Promise.all(
      [...ESIM_CHIP_COMMANDS].map(async (kind) => {
        const q = new URLSearchParams({ device_id: deviceId, kind, limit: "60" });
        const resp = await fetch(`/v1/commands?${q}`, { cache: "no-store" });
        if (!resp.ok) return [] as CommandRow[];
        return ((await resp.json()) as { commands?: CommandRow[] }).commands ?? [];
      }),
    );

    setCommands(mergeCommandBatches(unfilteredCmds, ...kindBatches));
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!reading && !authPending && !downloadPending) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [reading, authPending, downloadPending, refresh]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(SESSION_ENDPOINT, { cache: "no-store" });
        if (!alive) return;
        // A session the gateway will not confirm gets the smaller panel. The
        // controls would only ever produce a refusal anyway.
        setPermission(
          response.ok && mayWrite(roleFromSessionBody(await response.json())) ? "write" : "read",
        );
      } catch {
        if (alive) setPermission("read");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // The gate every control below is drawn behind. A boolean rather than the
  // three-state value, so the condition in front of a control is the word
  // `writable` and nothing else -- which is what a test can walk out of, and
  // what the four pages that are handed their answer already call it.
  const writable = permission === "write";

  /**
   * The request itself, and the only function in this file that performs one.
   *
   * Deliberately not reachable from a click: `request` below is what a control
   * calls, and `tokens.test.ts` asserts `runNow` appears in no handler and in
   * no prop. A confirmation that is still *defined* while a button calls the
   * write directly is the false green this board has been bitten by (T004).
   */
  const runNow = useCallback(
    async (kind: string, extra: Record<string, unknown>) => {
      // Not only the missing control. This is the half of the guard that
      // survives a control being drawn again by a later change.
      if (!writable) return;
      setBusy(true);
      setError(null);
      const response = await fetch("/v1/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId, kind, ...extra }),
      });
      setBusy(false);
      if (!response.ok) {
        setError((await response.text()).trim() || t("device.failed", locale));
        return;
      }
      await refresh();
      router.refresh();
    },
    [deviceId, locale, refresh, router, writable],
  );

  /**
   * What every control here calls.
   *
   * The decision is `DEVICE_COMMAND_GUARDS`, shared with the console panel, so
   * "which of these commands asks first" is one table that a test can read
   * rather than eleven click handlers that it cannot.
   */
  const request = useCallback(
    (kind: string, extra: Record<string, unknown>, title: string, confirmLabel: string) => {
      // In front of the dialog, not behind it. Asking an account that cannot
      // switch a profile to confirm switching one is all of the friction and
      // none of the outcome.
      if (!writable) return;
      const guard = deviceCommandGuard(kind, extra);
      if (guard.consequence === null) {
        void runNow(kind, extra);
        return;
      }
      setPending({
        consequence: t(guard.consequence, locale),
        title,
        confirmLabel,
        run: () => void runNow(kind, extra),
      });
    },
    [locale, runNow, writable],
  );

  const cancelPending = useCallback(() => setPending(null), []);
  // Reads the action it is showing rather than running inside a state updater:
  // React may run an updater twice, and this one sends a request.
  const proceed = useCallback(() => {
    if (!pending) return;
    const { run } = pending;
    setPending(null);
    run();
  }, [pending]);

  // The durable inventory and the last chip reading, as one table. Today the
  // inventory half is always empty -- nothing emits `EsimInventory` yet -- so
  // every row on the bench comes from the reading, which is why each row says
  // where it came from.
  const listings = latestEsimProfileListings(commands);
  const inventory = mergeEsimProfiles(profiles, esimProfileRowsFromReads(commands));
  const byEid = new Map<string, EsimProfileRow[]>();
  for (const profile of inventory) {
    byEid.set(profile.eid, [...(byEid.get(profile.eid) ?? []), profile]);
  }

  const chips = latestEsimChipReads(commands);
  const readFailures = esimReadFailures(commands, profiles);
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
  const verdict = esimSwitchVerdict(commands, inventory);

  return (
    <>
      <Card title={t("esim.modem", locale)} note={t("esim.note", locale)}>
        {writable ? (
          <Field label={t("esim.modem", locale)}>
            <Select
              value={imei}
              disabled={busy || modems.length === 0}
              onChange={(event) => setImei(event.target.value)}
            >
              {modems.map((modem) => (
                <option key={modem.imei} value={modem.imei}>
                  {modem.imei}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <FormHint>{t("role.readOnlyDevice", locale)}</FormHint>
        )}
        {error ? <FormError>{error}</FormError> : null}
      </Card>

      <Card
        title={t("esim.title", locale)}
        actions={
          writable ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || imei === ""}
              onClick={() =>
                request(
                  "list_esim_profiles",
                  { modem_imei: imei },
                  t("esim.refresh", locale),
                  t("esim.refresh", locale),
                )
              }
            >
              {t("esim.refresh", locale)}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          {verdict ? <SwitchVerdict verdict={verdict} locale={locale} /> : null}

          {/* Not a fault and not a failed read: a plain SIM in a slot the page
              offered an eSIM button for. Kept apart from the error banner
              below so a module that never had a chip stops looking broken. */}
          {readFailures
            .filter((failure) => failure.cause === "no-euicc")
            .map((failure) => (
              <FormHint key={`no-euicc-${failure.modemImei}`}>
                {t("esim.notEuicc", locale, { imei: failure.modemImei })}{" "}
                <span className="font-mono text-xs tabular-nums">{failure.reason}</span>
              </FormHint>
            ))}
          {readFailures
            .filter((failure) => failure.cause === "read-failed")
            .map((failure) => (
              <FormError key={`read-failed-${failure.modemImei}`}>
                {t("esim.chipReadFailed", locale, { imei: failure.modemImei })}:{" "}
                <span className="font-mono text-xs tabular-nums">{failure.reason}</span>
              </FormError>
            ))}

          {/* A card with no profiles and a card that refused to list them both
              answer with an empty array. The edge says which; without this the
              page would show the refusal as an empty chip. */}
          {listings
            .filter((listing) => listing.profilesError)
            .map((listing) => (
              <FormError key={`profiles-error-${listing.modemImei}`}>
                {t("esim.profilesError", locale, { imei: listing.modemImei })}:{" "}
                <span className="font-mono text-xs tabular-nums">{listing.profilesError}</span>
              </FormError>
            ))}

          {inventory.length === 0 ? (
            <CardEmpty title={t("esim.none", locale)} />
          ) : (
            [...byEid.entries()].map(([eid, rows]) => (
              <div key={eid} className="flex flex-col gap-4">
                <h3 className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">
                  {t("esim.colEid", locale)} <span className="font-mono text-xs tabular-nums">{eid}</span>
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow head>
                      <TableHead>{t("esim.colIccid", locale)}</TableHead>
                      <TableHead>{t("esim.colNickname", locale)}</TableHead>
                      <TableHead>{t("esim.colState", locale)}</TableHead>
                      {/* Two columns of provenance. Useful when a switch is
                          being argued about, and not what the row is read for
                          on a phone. */}
                      <TableHead secondary>
                        {t("esim.colCollected", locale)}
                      </TableHead>
                      <TableHead secondary>{t("esim.colSource", locale)}</TableHead>
                      {/* Header and cell together. A column kept for actions
                          nobody has leaves the table one heading wider than
                          it has values for. */}
                      {writable ? <TableHead label={t("table.actions", locale)} /> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((profile) => (
                      <TableRow key={profile.iccid}>
                        <TableCell mono>{profile.iccid}</TableCell>
                        <TableCell>
                          {profile.nickname ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <Badge tone={toneForProfileState(profile.state)}>{profile.state}</Badge>
                        </TableCell>
                        <TableCell mono faint secondary>
                          {new Date(profile.collectedAt)
                            .toISOString()
                            .replace("T", " ")
                            .slice(0, 16)}
                        </TableCell>
                        <TableCell faint secondary>
                          {t(
                            profile.source === "inventory"
                              ? "esim.sourceInventory"
                              : "esim.sourceRead",
                            locale,
                          )}
                        </TableCell>
                        {writable ? (
                          <TableCell>
                            <RowActions>
                              {/* Only a disabled profile can be switched to, and
                                  a deleted one is not on the chip at all. */}
                              {profile.state === "disabled" && profile.modemImei ? (
                                <Button
                                  variant="risk"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    request(
                                      "switch_esim_profile",
                                      {
                                        modem_imei: profile.modemImei,
                                        target_iccid: profile.iccid,
                                      },
                                      `${t("esim.switch", locale)} — ${profile.iccid}`,
                                      t("esim.switch", locale),
                                    )
                                  }
                                >
                                  {t("esim.switch", locale)}
                                </Button>
                              ) : null}
                              {/* Taking a profile out of service without
                                  putting another in. `switch_esim_profile`
                                  can only move the card from one profile to
                                  another, so until this there was no way to
                                  leave a module with nothing enabled -- which
                                  is what a card requires before a delete. */}
                              {profile.state === "enabled" && profile.modemImei ? (
                                <Button
                                  variant="risk"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    request(
                                      "disable_esim_profile",
                                      {
                                        modem_imei: profile.modemImei,
                                        iccid: profile.iccid,
                                      },
                                      `${t("esim.disable", locale)} — ${profile.iccid}`,
                                      t("esim.disable", locale),
                                    )
                                  }
                                >
                                  {t("esim.disable", locale)}
                                </Button>
                              ) : null}
                              {/* 🔴 Offered only for a disabled profile, and
                                  not because the console is being careful: an
                                  eUICC refuses to delete the profile it is
                                  running on, so a button here would produce a
                                  refusal with a confusing reason. The card is
                                  the guard; this is the honest rendering of
                                  what it will accept. */}
                              {profile.state === "disabled" && profile.modemImei ? (
                                <Button
                                  variant="risk"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    request(
                                      "delete_esim_profile",
                                      {
                                        modem_imei: profile.modemImei,
                                        iccid: profile.iccid,
                                      },
                                      `${t("esim.delete", locale)} — ${profile.iccid}`,
                                      t("esim.delete", locale),
                                    )
                                  }
                                >
                                  {t("esim.delete", locale)}
                                </Button>
                              ) : null}
                            </RowActions>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))
          )}
          {writable ? (
            <InlineForm
              onSubmit={(event) => {
                event.preventDefault();
                const chosen = profiles.find(
                  (profile) => profile.iccid === renameIccid && profile.modemImei,
                );
                if (!chosen?.modemImei) return;
                request(
                  "rename_esim_profile",
                  {
                    modem_imei: chosen.modemImei,
                    iccid: chosen.iccid,
                    nickname: renameNickname,
                  },
                  `${t("esim.rename", locale)} — ${chosen.iccid}`,
                  t("esim.rename", locale),
                );
              }}
            >
              {/* A form rather than a per-row button: renaming needs a value
                  typed, and the only way to do that in a row would be an
                  input in every row of every card. The name lives on the
                  card, so it is what any other tool reading the same chip
                  will show. */}
              <Field label={t("esim.renameTitle", locale)} inline>
                <Select
                  value={renameIccid}
                  onChange={(event) => setRenameIccid(event.target.value)}
                >
                  <option value="">—</option>
                  {profiles
                    .filter((profile) => profile.modemImei)
                    .map((profile) => (
                      <option key={profile.iccid} value={profile.iccid}>
                        {profile.nickname ? `${profile.nickname} · ` : ""}
                        {profile.iccid}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label={t("esim.renameNickname", locale)} inline>
                <Input
                  value={renameNickname}
                  maxLength={64}
                  onChange={(event) => setRenameNickname(event.target.value)}
                />
              </Field>
              <Button type="submit" variant="outline" disabled={busy || renameIccid === ""}>
                {t("esim.rename", locale)}
              </Button>
              <FormHint>{t("esim.renameHint", locale)}</FormHint>
            </InlineForm>
          ) : null}
        </div>
      </Card>

      <Card
        title={t("esim.chipTitle", locale)}
        actions={
          writable ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || imei === ""}
              onClick={() =>
                request(
                  "read_esim_info",
                  { modem_imei: imei },
                  t("esim.readChip", locale),
                  t("esim.readChip", locale),
                )
              }
            >
              {t("esim.readChip", locale)}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          {reading ? <FormHint>{t("esim.chipBusy", locale)}</FormHint> : null}
          {/* The failed-read banner is rendered above, next to the inventory it
              explains, and split by cause. One banner that only knew the status
              said the same sentence for a module that has no eUICC and for a
              chip that stopped answering, which are not the same news. */}

          {chips.length === 0 ? (
            <CardEmpty title={t("esim.noChip", locale)} />
          ) : (
            chips.map(({ info, completedAt }) => (
              <div key={info.eid} className="flex flex-col gap-4">
                <h3 className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">
                  {t("esim.colEid", locale)} <span className="font-mono text-xs tabular-nums">{info.eid}</span>
                </h3>
                <SpecTable>
                  <TableBody>
                    {chipFields(info, locale).map(([field, value]) => (
                      <SpecRow key={field} term={field} mono>
                        {value}
                      </SpecRow>
                    ))}
                    <SpecRow term={t("esim.readAt", locale)} mono>
                      <span className="text-muted-foreground">
                        {completedAt
                          ? new Date(completedAt).toISOString().replace("T", " ").slice(0, 19)
                          : "—"}
                      </span>
                    </SpecRow>
                  </TableBody>
                </SpecTable>

                <h3 className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">{t("esim.notifications", locale)}</h3>
                {info.notificationsError ? (
                  <FormError>{info.notificationsError}</FormError>
                ) : null}
                {info.notifications.length === 0 ? (
                  <p className="m-0 text-sm text-muted-foreground">{t("esim.noNotifications", locale)}</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow head>
                        <TableHead>{t("esim.colSeq", locale)}</TableHead>
                        <TableHead>{t("esim.colOperation", locale)}</TableHead>
                        {/* An SM-DP+ host name is the widest value in this
                            table and the one a phone can do without: the row
                            is read for which sequence number is outstanding. */}
                        <TableHead secondary>
                          {t("esim.colAddress", locale)}
                        </TableHead>
                        <TableHead>{t("esim.colIccid", locale)}</TableHead>
                        {writable ? <TableHead label={t("table.actions", locale)} /> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {info.notifications.map((notification) => (
                        <TableRow key={`${info.eid}-${notification.sequenceNumber}`}>
                          <TableCell mono>{notification.sequenceNumber}</TableCell>
                          <TableCell>{notification.operations.join(", ") || "—"}</TableCell>
                          <TableCell mono secondary>
                            {notification.address}
                          </TableCell>
                          <TableCell mono>{notification.iccid ?? "—"}</TableCell>
                          {writable ? (
                            <TableCell>
                              <RowActions>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    request(
                                      "retrieve_esim_notification",
                                      {
                                        modem_imei: info.imei,
                                        sequence_number: notification.sequenceNumber,
                                      },
                                      t("esim.retrieve", locale),
                                      t("esim.retrieve", locale),
                                    )
                                  }
                                >
                                  {t("esim.retrieve", locale)}
                                </Button>
                              </RowActions>
                            </TableCell>
                          ) : null}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            ))
          )}

          {retrieved ? (
            <p className="m-0 text-sm text-muted-foreground">
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
      </Card>

      <Card
        title={t("esim.authTitle", locale)}
        actions={
          writable ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || imei === ""}
              onClick={() =>
                request(
                  "initiate_esim_authentication",
                  { modem_imei: imei },
                  t("esim.authStart", locale),
                  t("esim.authStart", locale),
                )
              }
            >
              {t("esim.authStart", locale)}
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          {authPending ? <FormHint>{t("esim.authBusy", locale)}</FormHint> : null}
          {failedAuthentication ? (
            <FormError>
              {t("esim.authFailed", locale)}: {failedAuthentication.result?.reason ?? ""}
            </FormError>
          ) : null}
          {authentications.length === 0 ? (
            <CardEmpty title={t("esim.authNone", locale)} />
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
        </div>
      </Card>

      {/* The note is about where the activation code goes, so it goes with
          the box that took one. What the card is *about* -- what has been
          downloaded -- stays. */}
      <Card title={t("esim.dlTitle", locale)} note={writable ? t("esim.dlSecret", locale) : null}>
        <div className="flex flex-col gap-4">
          {writable ? (
            <>
              <Field label={t("esim.dlCode", locale)}>
                <Input
                  type="text"
                  value={activationCode}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="LPA:1$smdp.example.com$MATCHING-ID"
                  onChange={(event) => setActivationCode(event.target.value)}
                />
              </Field>
              <Field label={t("esim.dlConfirm", locale)}>
                <Input
                  type="text"
                  value={confirmationCode}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setConfirmationCode(event.target.value)}
                />
              </Field>
              <ButtonRow>
                <Button
                  variant="risk"
                  disabled={busy || imei === "" || activationCode.trim() === ""}
                  onClick={() => {
                    const code = activationCode.trim();
                    const confirmation = confirmationCode.trim();
                    // Cleared before the dialog opens rather than after the send.
                    // The code is a one-time credential and leaving it in a field
                    // invites a second click that spends an order which no longer
                    // exists.
                    setActivationCode("");
                    setConfirmationCode("");
                    request(
                      "download_esim_profile",
                      {
                        modem_imei: imei,
                        activation_code: code,
                        ...(confirmation === "" ? {} : { confirmation_code: confirmation }),
                      },
                      `${t("esim.dlStart", locale)} — ${imei}`,
                      t("esim.dlStart", locale),
                    );
                  }}
                >
                  {t("esim.dlStart", locale)}
                </Button>
              </ButtonRow>
            </>
          ) : null}
          {downloadPending ? <FormHint>{t("esim.dlBusy", locale)}</FormHint> : null}
          {failedDownload ? (
            <FormError>
              {t("esim.dlFailed", locale)}: {failedDownload.result?.reason ?? ""}
            </FormError>
          ) : null}
          {downloads.length === 0 ? (
            <CardEmpty title={t("esim.dlNone", locale)} />
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
      </Card>

      {writable ? (
        // Only `request` sets `pending`, and it refuses first, so this is a
        // third level of the same gate rather than a new one. It is here
        // because a dialog has two buttons in it, and a check that counts
        // the controls in this file should not have to remember which of
        // them are reachable.
        pending ? (
          <ConfirmDialog
            open
            title={pending.title}
            consequence={pending.consequence}
            confirmLabel={pending.confirmLabel}
            labels={{
              question: t("confirm.question", locale),
              proceed: t("confirm.proceed", locale),
              cancel: t("confirm.cancel", locale),
            }}
            busy={busy}
            onConfirm={proceed}
            onCancel={cancelPending}
          />
        ) : null
      ) : null}
    </>
  );
}

/**
 * Whether the chip agrees that the switch happened.
 *
 * 🔴 **The command reporting success is the weakest thing on this page**, and
 * on this endpoint it is weaker than that: `/api/esim/switch` answers `ok` in
 * cases where the profile did not change, which the vowifi board is fixing at
 * the edge (T080). This card must not touch that, so what it owes is a console
 * that does not repeat the claim.
 *
 * So there is no "switched" state here. There is what was asked for, and then
 * whether **a read of the chip taken after the switch** agrees — the timestamp
 * comparison is the whole point, because the reading that was already on
 * screen when the button was pressed says nothing about it.
 *
 * The read-back is not fired automatically. Every command on this page is a
 * command to real hardware, and a console that sends one the operator did not
 * ask for is a console that decides when to talk to a module. The button is
 * right here instead.
 */
function SwitchVerdict({
  verdict,
  locale,
}: {
  verdict: NonNullable<ReturnType<typeof esimSwitchVerdict>>;
  locale: Locale;
}) {
  const tone =
    verdict.state === "confirmed" ? "ok" : verdict.state === "contradicted" ? "bad" : "warn";
  const sentence =
    verdict.state === "confirmed"
      ? t("esim.switchConfirmed", locale)
      : verdict.state === "contradicted"
        ? t("esim.switchContradicted", locale, { state: verdict.observed ?? "" })
        : t("esim.switchUnverified", locale);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{t("esim.verifySwitch", locale)}</Badge>
        <span className="font-mono text-xs tabular-nums">
          {t("esim.switchAsked", locale, { iccid: verdict.targetIccid })}
        </span>
        {verdict.readAt === null ? null : (
          <span className="text-muted-foreground">
            {t("esim.switchReadAt", locale)}{" "}
            {new Date(verdict.readAt).toISOString().replace("T", " ").slice(0, 19)}
          </span>
        )}
      </div>
      {verdict.state === "confirmed" ? (
        <FormHint>{sentence}</FormHint>
      ) : (
        <FormError>{sentence}</FormError>
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
    <div className="flex flex-col gap-4">
      <h3 className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">
        {t("esim.aSmdp", locale)}{" "}
        <span className="font-mono text-xs tabular-nums">
          {authentication.smdpAddress} · {authentication.eid}
        </span>
      </h3>
      <SpecTable>
        <TableBody>
          {authenticationFields(authentication, locale).map(([field, value]) => (
            <SpecRow key={field} term={field} mono>
              {value}
            </SpecRow>
          ))}
          <SpecRow term={t("esim.authAt", locale)} mono>
            <span className="text-muted-foreground">
              {completedAt
                ? new Date(completedAt).toISOString().replace("T", " ").slice(0, 19)
                : "—"}
            </span>
          </SpecRow>
        </TableBody>
      </SpecTable>

      <h3 className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">{t("esim.checksTitle", locale)}</h3>
      <SpecTable>
        <TableBody>
          {checks.map(([label, passed]) => (
            <SpecRow key={label} term={label}>
              <Badge tone={passed ? "ok" : "bad"}>
                {passed ? t("esim.checkYes", locale) : t("esim.checkNo", locale)}
              </Badge>
            </SpecRow>
          ))}
        </TableBody>
      </SpecTable>

      <h3 className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">{t("esim.aAnchors", locale)}</h3>
      <SpecTable>
        <TableBody>
          {authentication.trustAnchors.map((anchor) => (
            <SpecRow key={anchor.label} term={anchor.label} mono>
              {anchor.keyId}
              <span className="text-muted-foreground"> {anchor.notAfter}</span>
            </SpecRow>
          ))}
        </TableBody>
      </SpecTable>

      {authentication.profileDownloaded ? null : (
        <p className="m-0 text-sm text-muted-foreground">
          <strong>
            {t("esim.authStopped", locale, { why: authentication.stoppedAfter ?? "" })}
          </strong>
        </p>
      )}
    </div>
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
    <div className="flex flex-col gap-4">
      <h3 className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">
        <span className="font-mono text-xs tabular-nums">
          {download.eid} · {download.imei}
        </span>
      </h3>
      {download.refusedPolicyRules.length > 0 ? (
        <FormError>
          <strong>
            {t("esim.dlRefused", locale, { rules: download.refusedPolicyRules.join(", ") })}
          </strong>
        </FormError>
      ) : null}
      {download.installationError ? (
        <FormError>
          {t("esim.dlError", locale)}: {download.installationError}
          {download.failedBppCommand ? ` (${download.failedBppCommand})` : ""}
        </FormError>
      ) : null}
      {download.notificationDeliveryError ? (
        <FormError>{download.notificationDeliveryError}</FormError>
      ) : null}
      <SpecTable>
        <TableBody>
          {rows.map(([field, value]) => (
            <SpecRow key={field} term={field} mono>
              {value ?? "—"}
            </SpecRow>
          ))}
          <SpecRow term={t("esim.authAt", locale)} mono>
            <span className="text-muted-foreground">
              {completedAt
                ? new Date(completedAt).toISOString().replace("T", " ").slice(0, 19)
                : "—"}
            </span>
          </SpecRow>
        </TableBody>
      </SpecTable>

      <SpecTable>
        <TableBody>
          {checks.map(([label, passed]) => (
            <SpecRow key={label} term={label}>
              <Badge tone={passed ? "ok" : "bad"}>
                {passed ? t("esim.checkYes", locale) : t("esim.checkNo", locale)}
              </Badge>
            </SpecRow>
          ))}
        </TableBody>
      </SpecTable>

      <h3 className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">{t("esim.dlProfilesAfter", locale)}</h3>
      {after === null || after.profiles.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">—</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow head>
              <TableHead>{t("esim.colIccid", locale)}</TableHead>
              <TableHead>{t("esim.colNickname", locale)}</TableHead>
              <TableHead>{t("esim.colState", locale)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {after.profiles.map((profile) => (
              <TableRow key={profile.iccid}>
                <TableCell mono>{profile.iccid}</TableCell>
                <TableCell>{profile.label}</TableCell>
                <TableCell>
                  <Badge tone={toneForProfileState(profile.enabled ? "enabled" : "disabled")}>
                    {profile.enabled ? "enabled" : "disabled"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {download.stoppedAfter ? (
        <p className="m-0 text-sm text-muted-foreground">
          <strong>{t("esim.dlStopped", locale, { why: download.stoppedAfter })}</strong>
        </p>
      ) : null}
    </div>
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
