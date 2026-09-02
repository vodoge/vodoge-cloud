"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonRow } from "@/components/ui/button-row";
import {
  Card,
  CardContent,
  CardEmpty,
  CardHeader,
  CardNote,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Checkbox,
  Field,
  FormError,
  FormHint,
  InlineField,
  InlineForm,
  Input,
  Select,
} from "@/components/ui/form";
import { Output } from "@/components/ui/output";
import {
  latestUssdExchange,
  ussdCancelRequest,
  ussdContinueRequest,
  ussdSessionAgeMs,
  ussdSessionState,
  ussdStageLabelKey,
  ussdStartRequest,
  type ApnContextRow,
  type CandidateRow,
  type ModemRow,
  type UssdRequest,
  type UssdStageLabelKey,
} from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { operatorName } from "@/lib/plmn";
import { mayWrite, roleFromSessionBody, SESSION_ENDPOINT } from "@/lib/session";
import {
  AT_COMMAND_GUARDS,
  atCommandGuard,
  deviceCommandGuard,
  toneForCommandStatus,
} from "@/lib/tokens";

/**
 * One command's lifecycle as the console sees it.
 *
 * A relayed action is asynchronous by nature — an operator scan takes the
 * radio away for a minute or more — so the page issues the command and then
 * watches for its result rather than blocking on a response.
 */
type CommandRow = {
  id: string;
  kind: string;
  status: string;
  issued_at: number;
  completed_at: number | null;
  payload: Record<string, unknown> | null;
  result: {
    status?: string;
    reason?: string;
    reason_code?: string;
    details?: unknown;
  } | null;
};

/**
 * Every user-visible string this component draws, named.
 *
 * It used to be Record<string, string>, filled from a hand-written list of key
 * names in app/devices/[deviceId]/page.tsx. Nothing connected the two: a
 * control added here that read a label nobody had listed there compiled fine,
 * got `undefined`, and React draws undefined as nothing at all — a button with
 * no text, in both locales, with no error anywhere. That is not hypothetical.
 * It is the defect that stalled the proxy export control (T055) until the same
 * union was put in front of it (T071), and this file was the last panel still
 * exposed to it.
 *
 * The stage keys are imported rather than restated so that a stage the edge
 * learns to report cannot be added to the catalogue helper without the page
 * being made to supply a sentence for it.
 */
export type DeviceLabelKey =
  | "modem"
  | "modemNote"
  | "noModems"
  | "noCommands"
  | "waiting"
  | "failed"
  | "run"
  | "send"
  | "cancel"
  | "console"
  | "consoleNote"
  | "diagTitle"
  | "diagNote"
  | "atCommand"
  | "atNote"
  | "atGuarded"
  | "atForce"
  | "atForceHint"
  | "ussdCode"
  | "ussdNote"
  | "ussdSession"
  | "ussdSessionModem"
  | "ussdReply"
  | "ussdContinue"
  | "ussdExpired"
  | UssdStageLabelKey
  | "selectOperator"
  | "networkTitle"
  | "networkNote"
  | "pin"
  | "automatic"
  | "radioOn"
  | "dataOn"
  | "danger"
  | "dangerNote"
  | "recovery"
  | "recoveryNote"
  | "logTitle"
  | "logNote"
  | "usbnetMode"
  | "usbnetWarning"
  | "apnContext"
  | "apn"
  | "apnPdpType"
  | "apnUsername"
  | "apnAuth"
  | "apnPassword"
  | "apnPasswordKeep"
  | "apnClearPassword"
  | "apnKeep"
  | "apnHint"
  | "agentLog"
  | "agentLogNote"
  | "agentLogFilter"
  | "agentLogFilterHint"
  | "agentLogRead"
  | "agentLogNone"
  | "agentLogEmpty"
  | "candidates"
  | "candidatesNote"
  | "candidatesNone"
  | "candidatesHint"
  | "candidateAdopt"
  | "candidateClaim"
  | "modem_report"
  | "list_esim_profiles"
  | "restart_modem"
  | "reset_modem_usb"
  | "scan_operators"
  | "rotate_ip"
  | "set_radio"
  | "unregister_modem"
  | "set_data_network"
  | "reregister_network"
  | "refresh_modems"
  | "run_at_command"
  | "send_ussd"
  | "select_operator"
  | "send_sms"
  | "switch_esim_profile"
  | "set_usbnet_mode";

type Labels = Record<DeviceLabelKey, string>;

/**
 * A command kind's display name, or the kind itself.
 *
 * The log renders whatever the gateway recorded, including kinds this build
 * has no label for — one issued by a newer console, or renamed since. That is
 * the only place a stored string indexes the label set, so the widening is
 * done here, once, instead of by weakening the type every control depends on.
 */
function commandLabel(labels: Labels, kind: string): string {
  return (labels as Record<string, string | undefined>)[kind] ?? kind;
}

const TERMINAL = new Set(["succeeded", "failed", "expired", "cancelled", "unknown"]);

/**
 * Actions grouped by how much they disturb the device.
 *
 * The grouping is the safety mechanism the page relies on: reading a signal
 * level and taking a modem off the network for two minutes should not be two
 * identical buttons side by side.
 *
 * 🔴 What the grouping is **not** any more: the thing that decides whether a
 * confirmation appears. It used to be — `DISRUPTIVE.map` drew the buttons and
 * put one shared `window.confirm` behind them — and that is exactly how the
 * free-text AT box, manual PLMN selection and both USSD sends went out with
 * nothing in front of them, because none of them is in this array. The
 * decision now lives in `DEVICE_COMMAND_GUARDS`, keyed by what is being sent
 * rather than by which loop drew the button, and this array only says which
 * buttons live in the danger zone.
 */
const READ_ONLY = ["modem_report", "list_esim_profiles"] as const;
const DISRUPTIVE = [
  "restart_modem",
  "reset_modem_usb",
  "scan_operators",
  "rotate_ip",
  "set_radio",
  "set_data_network",
  "reregister_network",
  // Not disruptive to the hardware -- nothing is written to the module -- but
  // it takes a working stick out of the list, and an operator who did it by
  // accident would watch one vanish. It belongs behind the same confirmation
  // as the rest, and the adoption that undoes it is one press in the
  // candidates card below.
  "unregister_modem",
] as const;

/**
 * Disruptive actions whose button means "off".
 *
 * Both of these can take a working module off the air, and both have a plain
 * companion button in the recovery row that turns them back on. Kept as data
 * rather than a condition inside the loop: the second one is where a ternary
 * would have quietly started turning the radio off for the wrong command.
 */
const TURNS_OFF: Record<string, Record<string, unknown>> = {
  set_radio: { enabled: false },
  set_data_network: { enabled: false },
};

/** What the module can be told to expose over USB. */
const USBNET_MODES = ["rmnet", "ecm", "mbim", "rndis"] as const;

/** A command waiting for the operator to answer for it. */
type Pending = {
  readonly kind: string;
  readonly extra: Record<string, unknown>;
  /** The message key of the sentence that says what will happen. */
  readonly consequence: string;
  readonly title: string;
};

/** What a control does when it wants a command sent. */
type Request = (kind: string, extra?: Record<string, unknown>) => void;

/**
 * The shared half of both panels on this page: the command relay itself.
 *
 * 🔴 **`request` is the only way a control may reach the gateway.** It asks
 * `deviceCommandGuard` what stands in front of the command *with the payload
 * it is about to be sent with* — which is what makes `set_radio {enabled:
 * false}` a guarded command and `set_radio {enabled: true}` an unguarded one
 * without either of them being a special case in a click handler.
 *
 * `runNow` performs the request and is deliberately not handed to anything
 * that renders: `tokens.test.ts` asserts it appears in no `onClick`, no
 * `onSubmit` and in no prop, because a dialog that is still *defined* while a
 * button calls the write directly is the false green this board has been
 * bitten by before (T004).
 */
function useDeviceCommands(deviceId: string, imei: string, labels: Labels) {
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // "unknown" until the gateway has been asked, and the controls are drawn for
  // "write" only. Closed by default on purpose: this component is rendered on
  // the server before it can ask anything, and an account's controls appearing
  // for one paint and then being taken away is a worse answer than appearing
  // one paint late. What it costs is a moment of empty console for an operator
  // who does have the rights.
  const [permission, setPermission] = useState<"unknown" | "write" | "read">("unknown");
  // Polling stops once nothing is outstanding, so an idle page costs nothing.
  const outstanding = commands.some((row) => !TERMINAL.has(row.status));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(SESSION_ENDPOINT, { cache: "no-store" });
        if (!alive) return;
        // A session the gateway will not confirm gets the smaller page. The
        // buttons would only produce a refusal anyway.
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

  const refresh = useCallback(async () => {
    const response = await fetch(
      `/v1/commands?device_id=${encodeURIComponent(deviceId)}&limit=25`,
      { cache: "no-store" },
    );
    if (!response.ok || !mounted.current) return;
    const body = (await response.json()) as { commands?: CommandRow[] };
    if (mounted.current) setCommands(body.commands ?? []);
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!outstanding) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [outstanding, refresh]);

  const runNow = useCallback(
    async (kind: string, extra: Record<string, unknown> = {}) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/v1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // `extra` is spread last so a caller can aim a command at a module
          // other than the selected one. Only USSD does, and it must: a reply
          // belongs to the session its opening request started, and the
          // selector moves independently of that.
          body: JSON.stringify({ device_id: deviceId, kind, modem_imei: imei, ...extra }),
        });
        if (!response.ok) {
          // The gateway validates each command and explains what is wrong;
          // showing that beats a generic failure the operator cannot act on.
          setError((await response.text()).trim() || labels.failed);
          return;
        }
        await refresh();
      } catch {
        setError(labels.failed);
      } finally {
        setBusy(false);
      }
    },
    [deviceId, imei, labels.failed, refresh],
  );

  const request = useCallback<Request>(
    (kind, extra = {}) => {
      const guard = deviceCommandGuard(kind, { modem_imei: imei, ...extra });
      if (guard.consequence === null) {
        void runNow(kind, extra);
        return;
      }
      setPending({
        kind,
        extra,
        consequence: guard.consequence,
        title: confirmationTitle(labels, kind, extra, imei),
      });
    },
    [imei, labels, runNow],
  );

  const cancelPending = useCallback(() => setPending(null), []);
  // Reads the action it is showing, and deliberately not from inside a state
  // updater: React may run an updater twice, and this one sends a request.
  const proceed = useCallback(() => {
    if (!pending) return;
    const { kind, extra } = pending;
    setPending(null);
    void runNow(kind, extra);
  }, [pending, runNow]);

  return { commands, busy, error, permission, pending, request, proceed, cancelPending };
}

/**
 * What the dialog's heading names.
 *
 * The command in words plus the module it is aimed at, because every module on
 * a device is addressed by IMEI here and "restart module" over the wrong one is
 * the mistake this heading exists to catch. A typed AT command names itself:
 * the text is the whole of what is about to happen.
 */
function confirmationTitle(
  labels: Labels,
  kind: string,
  extra: Record<string, unknown>,
  imei: string,
): string {
  const target = typeof extra.modem_imei === "string" ? extra.modem_imei : imei;
  const what = kind === "run_at_command" ? String(extra.command ?? "") : commandLabel(labels, kind);
  return target ? `${what} — ${target}` : what;
}

/** The dialog's own chrome, asked the same way everywhere. */
function confirmLabels(locale: Locale) {
  return {
    question: t("confirm.question", locale),
    proceed: t("confirm.proceed", locale),
    cancel: t("confirm.cancel", locale),
  };
}

/**
 * The two read-only commands and the log they answer in.
 *
 * These were in the console panel, beside eleven controls that change
 * something, and both of them only read: a diagnostic report and an ES10c
 * profile listing. They belong with the host vitals and the radio readings,
 * which is what the diagnostics tab is. T010 built that tab and left the seam
 * because this file was not on its list.
 *
 * The command log is drawn on both tabs and that is not an oversight: it is
 * where a command's *answer* appears, so a panel that can issue one without
 * showing the log is a panel where pressing a button does nothing visible.
 */
export function DeviceDiagnostics({
  deviceId,
  modems,
  labels,
  locale,
}: {
  deviceId: string;
  modems: ModemRow[];
  labels: Labels;
  locale: Locale;
}) {
  const [imei, setImei] = useState(modems[0]?.imei ?? "");
  const { busy, commands, error, permission, pending, request, proceed, cancelPending } =
    useDeviceCommands(deviceId, imei, labels);

  return (
    <>
      <CardPanel title={labels.diagTitle} note={labels.diagNote}>
        {permission !== "write" ? (
          <FormHint>{t("role.readOnlyDevice", locale)}</FormHint>
        ) : (
          <div className="flex flex-col gap-4">
            <ModemPicker
              modems={modems}
              imei={imei}
              onSelect={setImei}
              labels={labels}
              busy={busy}
            />
            <ButtonRow>
              {READ_ONLY.map((kind) => (
                <Button
                  key={kind}
                  variant="outline"
                  disabled={busy || modems.length === 0}
                  onClick={() => request(kind)}
                >
                  {labels[kind]}
                </Button>
              ))}
              {/* Reachable with no modules listed on purpose: "nothing is
                  listed" is the situation this button exists for. */}
              <Button variant="outline" disabled={busy} onClick={() => request("refresh_modems")}>
                {labels.refresh_modems}
              </Button>
            </ButtonRow>
            {error ? <FormError>{error}</FormError> : null}
          </div>
        )}
      </CardPanel>

      <CommandLogCard commands={commands} labels={labels} />

      {pending ? (
        <ConfirmDialog
          open
          title={pending.title}
          consequence={t(pending.consequence, locale)}
          labels={confirmLabels(locale)}
          busy={busy}
          onConfirm={proceed}
          onCancel={cancelPending}
        />
      ) : null}
    </>
  );
}

export function DeviceConsole({
  deviceId,
  modems,
  candidates,
  labels,
  locale,
}: {
  deviceId: string;
  modems: ModemRow[];
  /** Already narrowed to this device by the caller. */
  candidates: CandidateRow[];
  labels: Labels;
  /**
   * The locale of the request, resolved on the server.
   *
   * Almost everything drawn here arrives already translated in `labels`, which
   * the page renders per request. The exceptions are the sentences the page
   * cannot render for this component, because they depend on something the
   * server does not know: whether the session may write, and which
   * confirmation a control is about to show. Those were looked up against a
   * `useState<Locale>(DEFAULT_LOCALE)` that only became the real locale inside
   * an effect -- after hydration. The server runs no effects and has no such
   * state, so the HTML it sent said the default language every time: an
   * English request shipped `<html lang="en">` with a Chinese read-only notice
   * inside it, and the browser quietly corrected it on mount. That is why it
   * went unnoticed for so long. Reading the live DOM shows the corrected text;
   * only fetching the response without executing JavaScript shows what was
   * actually served.
   *
   * Taking the locale as a prop -- the same fix EsimPanel already carries
   * (T066) -- is what removes it, because a prop exists before the first
   * render. The permission still resolves after mount, and it has to: nothing
   * on the server knows it. What changes is that the sentence it produces is
   * now in the language that was asked for.
   */
  locale: Locale;
}) {
  const [imei, setImei] = useState(modems[0]?.imei ?? "");
  const { busy, commands, error, permission, pending, request, proceed, cancelPending } =
    useDeviceCommands(deviceId, imei, labels);

  // Every control in this component issues POST /v1/commands, which the
  // gateway refuses for a read-only session, so there is nothing here for one
  // to press — but the history of what the device has done is exactly what
  // such an account is for. The log stays.
  if (permission !== "write") {
    return (
      <>
        <CardPanel title={labels.console} note={labels.consoleNote}>
          {permission === "read" ? <FormHint>{t("role.readOnlyDevice", locale)}</FormHint> : null}
        </CardPanel>
        <CommandLogCard commands={commands} labels={labels} />
      </>
    );
  }

  if (modems.length === 0) {
    // The rescan stays reachable here on purpose. "Nothing is listed" is
    // exactly the situation the button exists for, and hiding it behind a
    // device that already has a modem would put it everywhere except where
    // someone is looking for it.
    return (
      <>
        <CardPanel title={labels.console} note={labels.consoleNote}>
          <div className="flex flex-col gap-4">
            <CardEmpty title={labels.noModems} />
            <ButtonRow>
              <Button variant="outline" disabled={busy} onClick={() => request("refresh_modems")}>
                {labels.refresh_modems}
              </Button>
            </ButtonRow>
            {error ? <FormError>{error}</FormError> : null}
          </div>
        </CardPanel>
        <CommandLogCard commands={commands} labels={labels} />
      </>
    );
  }

  return (
    <>
      <CardPanel title={labels.console} note={labels.consoleNote}>
        <ModemPicker modems={modems} imei={imei} onSelect={setImei} labels={labels} busy={busy} />
      </CardPanel>

      <AtConsole busy={busy} labels={labels} locale={locale} onRun={request} />

      <CardPanel title={labels.send_ussd} note={labels.ussdNote}>
        <UssdConsole
          busy={busy}
          labels={labels}
          commands={commands}
          selectedImei={imei}
          onRun={request}
        />
      </CardPanel>

      <CardPanel title={labels.networkTitle} note={labels.networkNote}>
        <div className="flex flex-col gap-4">
          <OperatorControls busy={busy} labels={labels} onRun={request} />
          <UsbnetControls busy={busy} labels={labels} onRun={request} />
          <ApnControls
            busy={busy}
            contexts={modems.find((modem) => modem.imei === imei)?.apnContexts ?? null}
            labels={labels}
            onRun={request}
          />
        </div>
      </CardPanel>

      <CandidatesCard busy={busy} candidates={candidates} labels={labels} onRun={request} />

      <AgentLogCard busy={busy} commands={commands} labels={labels} onRun={request} />

      <DangerZone busy={busy} labels={labels} onRun={request} />

      {error ? <FormError>{error}</FormError> : null}

      <CommandLogCard commands={commands} labels={labels} />

      {pending ? (
        <ConfirmDialog
          open
          title={pending.title}
          consequence={t(pending.consequence, locale)}
          labels={confirmLabels(locale)}
          busy={busy}
          onConfirm={proceed}
          onCancel={cancelPending}
        />
      ) : null}
    </>
  );
}

/** Which module everything below is aimed at. */
function ModemPicker({
  modems,
  imei,
  onSelect,
  labels,
  busy,
}: {
  modems: ModemRow[];
  imei: string;
  onSelect: (value: string) => void;
  labels: Labels;
  busy: boolean;
}) {
  return (
    <>
      <Field label={labels.modem}>
        <Select
          value={imei}
          disabled={busy || modems.length === 0}
          onChange={(event) => onSelect(event.target.value)}
        >
          {modems.map((modem) => (
            <option key={modem.imei} value={modem.imei}>
              {modem.imei}
              {modem.homePlmn ? ` — ${operatorName(modem.homePlmn)}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <FormHint>{labels.modemNote}</FormHint>
    </>
  );
}

/**
 * The free-text AT box, which had no guard at all.
 *
 * 🔴 This is the hole T030 found and T021's twenty-three-row survey of
 * dangerous actions had no row for. The only thing between an operator and the
 * module was `command.trim().length < 2`, so `AT+CFUN=0` and `AT+CFUN=4` went
 * out **without the confirmation the seven danger-zone buttons have** — and
 * `AT+CFUN=1,1` is how the vowifi board's T078 watched a module get stranded
 * at `+CFUN: 7`, on hardware nobody can reach to power-cycle.
 *
 * The guarded shapes are listed under the box rather than only inside the
 * dialog, and they are rendered from `AT_COMMAND_GUARDS` rather than typed out:
 * a guard added to the table with no copy on screen would be invisible until
 * the dialog it opens is already too late to be a warning. That is the edge
 * panel's arrangement, copied deliberately — this is the cloud half of the
 * `guardFor(command)` it has had since T004.
 *
 * And when the box *does* hold a guarded command, the consequence is shown
 * before the button rather than only after it is pressed.
 */
function AtConsole({
  busy,
  labels,
  locale,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  locale: Locale;
  onRun: Request;
}) {
  const [command, setCommand] = useState("AT+CSQ");
  // The agent refuses commands that reach radio, call, message, card or
  // persistent-configuration state. Its list is wider than the guards below,
  // which name only the few worth explaining in advance, so this is what an
  // operator uses when the refusal names something the box did not warn about.
  // Reset after every send: a switch left on is a guard turned off.
  const [force, setForce] = useState(false);
  const tripped = atCommandGuard(command);
  return (
    <CardPanel title={labels.atCommand} note={labels.atNote}>
      <div className="flex flex-col gap-4">
        <InlineForm
          onSubmit={(event) => {
            event.preventDefault();
            onRun("run_at_command", { command, force: force || Boolean(tripped) });
            setForce(false);
          }}
        >
          <Field label={labels.atCommand} inline>
            <Input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <InlineField
            label={labels.atForce}
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
            title={labels.atForceHint}
          />
          <Button
            type="submit"
            variant={tripped || force ? "risk" : "default"}
            disabled={busy || command.trim().length < 2}
          >
            {labels.run}
          </Button>
        </InlineForm>

        {tripped ? (
          <FormError>
            <Badge tone="bad">{tripped.label}</Badge> {t(tripped.consequence, locale)}
          </FormError>
        ) : (
          <FormHint>
            {labels.atGuarded}: {AT_COMMAND_GUARDS.map((guard) => guard.label).join(" · ")}
          </FormHint>
        )}
      </div>
    </CardPanel>
  );
}

/**
 * USSD, which is the one control on this page that has a conversation.
 *
 * Everything else here is one request and one answer. A USSD code that opens a
 * menu is not: the network holds a session open and waits to be told which
 * item, and until this control existed the console could only ever send the
 * first screen — `stage:"continue"` had zero occurrences in the deployed
 * bundle, so balance, plan and top-up menus all dead-ended at "1. Balance
 * 2. Plan" with nothing to press.
 *
 * The session has no identifier, and cannot be given one: it lives in the
 * module and the carrier, addressed only by which AT port the request goes
 * down. So the follow-up is aimed by the IMEI recorded on the command that
 * opened it — deliberately not by the selector above, which is whatever the
 * operator last clicked. Sending "2" to a module with no session open does not
 * fail; it dials 2 as a USSD code of its own.
 *
 * 🔴 Both sends are guarded now and neither was before (T030). A service code
 * can be billed and can change the subscription — call forwarding is a USSD
 * menu — and a menu reply is the choice itself rather than a page turn.
 * Cancelling is left unguarded on purpose: it closes a session somebody
 * already opened, and a question in front of the way out is how a dialog
 * becomes something operators dismiss without reading.
 */
function UssdConsole({
  busy,
  labels,
  commands,
  selectedImei,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  commands: CommandRow[];
  selectedImei: string;
  onRun: Request;
}) {
  const [code, setCode] = useState("");
  const [reply, setReply] = useState("");
  // When this page first saw the answer settle, and a clock that advances
  // while a session is open so the offer to continue withdraws itself instead
  // of waiting for the next click to notice.
  const [observed, setObserved] = useState<{ commandId: string; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const exchange = latestUssdExchange(commands);
  const commandId = exchange?.commandId ?? null;
  const status = exchange?.status ?? null;

  useEffect(() => {
    if (!commandId || status !== "succeeded") return;
    setObserved((prev) => (prev?.commandId === commandId ? prev : { commandId, at: Date.now() }));
  }, [commandId, status]);

  // Only this exchange's own observation counts. A timestamp left over from
  // the previous command describes a session that has already been replaced.
  const observedAt = observed && observed.commandId === commandId ? observed.at : null;
  const session = ussdSessionState(exchange, ussdSessionAgeMs(exchange, observedAt, now));

  useEffect(() => {
    if (session !== "open") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session]);

  const result = exchange?.result ?? null;

  // Named `body` rather than `request`, which is what the dispatcher is called
  // everywhere else in this file: two different things under one name is how a
  // check that reads call sites — and a reader — gets the wrong one.
  const send = (body: UssdRequest | null) => {
    if (!body) return;
    onRun("send_ussd", body);
  };

  return (
    <div className="flex flex-col gap-4">
      <InlineForm
        onSubmit={(event) => {
          event.preventDefault();
          send(ussdStartRequest(selectedImei, code));
        }}
      >
        <Field label={labels.ussdCode} inline>
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="*101#"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Button type="submit" variant="risk" disabled={busy || code.trim() === ""}>
          {labels.send}
        </Button>
        {/* The way out of a session, not a way into one. Plain on purpose. */}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => send(ussdCancelRequest(exchange, selectedImei))}
        >
          {labels.cancel}
        </Button>
      </InlineForm>

      {result ? (
        <div className="flex flex-col gap-4">
          <FormHint>{labels.ussdSession}</FormHint>
          {/* The stage in words. Four of the seven mean "no answer" for four
              different reasons, and the raw result carries an empty `text` for
              all of them — which is what the one production run looked like:
              a JSON blob reading network_timeout, "" and 30232 ms. */}
          {result.expectsReply ? (
            <FormHint>{labels[ussdStageLabelKey(result.stage)]}</FormHint>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">
              {labels[ussdStageLabelKey(result.stage)]}
              {ussdStageLabelKey(result.stage) === "ussdStageOther" ? (
                <span className="font-mono text-xs tabular-nums"> {result.stage}</span>
              ) : null}
            </p>
          )}
          {result.text ? <Output>{result.text}</Output> : null}

          {session === "open" ? (
            <InlineForm
              onSubmit={(event) => {
                event.preventDefault();
                // Checked again here rather than trusting the render that drew
                // the button: the guard is a deadline, and nothing re-renders
                // the instant it passes.
                const at = Date.now();
                if (
                  ussdSessionState(exchange, ussdSessionAgeMs(exchange, observedAt, at)) !== "open"
                ) {
                  setNow(at);
                  return;
                }
                send(ussdContinueRequest(exchange, reply));
                setReply("");
              }}
            >
              <Field label={labels.ussdReply} inline>
                <Input
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder="1"
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Button type="submit" variant="risk" disabled={busy || reply.trim() === ""}>
                {labels.ussdContinue}
              </Button>
              {/* Which module the reply goes to, because it is not necessarily
                  the one selected above and an operator has no other way to
                  tell. */}
              <span className="font-mono text-xs tabular-nums">
                {labels.ussdSessionModem} {exchange?.modemImei}
              </span>
            </InlineForm>
          ) : null}

          {/* A session that has aged out is the failure worth naming. Left
              silent, the reply box would simply stop being there, and the
              obvious next move — retyping "1" into the code box above — sends
              the menu item to the carrier as a service code. */}
          {session === "expired" ? <FormError>{labels.ussdExpired}</FormError> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Which operator the module is on.
 *
 * 🔴 Manual selection had no guard (T030), and it is the one control here that
 * can leave a module looking healthy and reachable by nobody: pinned to a PLMN
 * that is not on the air, it searches for ever and the fleet page shows
 * "searching". The way back — automatic — is deliberately *not* guarded, for
 * the same reason the edge panel does not guard `AT+COPS=0`: a question in
 * front of the recovery teaches the reflex that defeats the question in front
 * of the hazard.
 */
function OperatorControls({
  busy,
  labels,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  onRun: Request;
}) {
  const [plmn, setPlmn] = useState("");
  return (
    <InlineForm
      onSubmit={(event) => {
        event.preventDefault();
        onRun("select_operator", { mode: "manual", plmn });
      }}
    >
      <Field label={labels.selectOperator} inline>
        <Input
          value={plmn}
          onChange={(event) => setPlmn(event.target.value)}
          placeholder="460-01"
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
      <Button
        type="submit"
        variant="risk"
        disabled={busy || !/^[0-9]{3}-[0-9]{2,3}$/.test(plmn)}
      >
        {labels.pin}
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => onRun("select_operator", { mode: "automatic" })}
      >
        {labels.automatic}
      </Button>
    </InlineForm>
  );
}

/**
 * Which USB function the module exposes.
 *
 * Deliberately not one of the danger-zone buttons above. Those take a module
 * off the air and leave it in the list; this one takes it out of the list
 * altogether, because the port the fleet is indexed by stops existing.
 *
 * 🔴 Two defects were fixed here, and both were the same mistake in different
 * clothes: **a guard that only sometimes applies**.
 *
 * - The confirmation was conditional on the mode not being rmnet, so the one
 *   switch that re-enumerates the module every time asked nothing three
 *   quarters of the time it was pressed. Both cases are confirmed now, with
 *   different consequences: rmnet keeps the QMI port and the module finds its
 *   own way back, and saying so is what stops the other dialog reading like
 *   boilerplate.
 * - The red was conditional in the same way **and never rendered at all**.
 *   `className="risk"` is declared in the stylesheet only as
 *   `.button-row button.risk` and `.row-actions button.risk`, and this button
 *   sits in an `<form className="inline-form">` — so the warning colour on the
 *   control that takes a module out of the device list has never once been
 *   drawn. `variant="risk"` needs no ancestor; it was measured at 390px after
 *   the change, and it paints.
 */
function UsbnetControls({
  busy,
  labels,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  onRun: Request;
}) {
  const [mode, setMode] = useState<string>("rmnet");
  return (
    <InlineForm
      onSubmit={(event) => {
        event.preventDefault();
        onRun("set_usbnet_mode", { usbnet_mode: mode });
      }}
    >
      <Field label={labels.usbnetMode} inline>
        <Select value={mode} onChange={(event) => setMode(event.target.value)}>
          {USBNET_MODES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="risk" disabled={busy}>
        {labels.run}
      </Button>
      {/* The long form of the same warning, on screen before the dialog. rmnet
          is the mode this agent speaks, so the sentence is about the others. */}
      {mode === "rmnet" ? null : <FormError>{labels.usbnetWarning}</FormError>}
    </InlineForm>
  );
}




/**
 * Endpoints this agent has seen and has not written to.
 *
 * The nearest thing this product has to "add a device by hand", and
 * deliberately not that: enrolment is certificate-based, so a device the
 * console invented would have nothing to connect with. What is approved here
 * is something the agent already found, addressed by the key the agent gave
 * it -- the form carries no port and no IMEI, because a console that could
 * name those could describe hardware nobody has looked at.
 *
 * 🔴 Approving one lets the agent write AT to a port it has so far only
 * looked at. That is a real line to cross -- a serial endpoint that is not a
 * modem can be a GPS, a debug console, or something that reboots when it is
 * spoken to -- which is why it is guarded like the disruptive commands rather
 * than offered as a plain button.
 */
function CandidatesCard({
  busy,
  candidates,
  labels,
  onRun,
}: {
  busy: boolean;
  candidates: CandidateRow[];
  labels: Labels;
  onRun: Request;
}) {
  // Only the ones nobody has acted on. A claimed endpoint becomes a module on
  // the next poll and is listed above with the rest of them; leaving it here
  // would offer an approval that has already happened.
  //
  // Two kinds sit in this list, and they are two different decisions:
  //
  //   no IMEI   the agent has looked at the port and not spoken to it. The
  //             action is permission to probe, and it is guarded, because a
  //             serial endpoint that is not a modem can be a GPS, a debug
  //             console, or something that reboots when it is spoken to.
  //   an IMEI   the agent has identified the module and nobody has adopted it.
  //             The action is adoption, and it is ordinary: reading identity
  //             already happened, and managing a module changes nothing on it.
  const pending = candidates.filter((row) => row.state === "found");
  return (
    <CardPanel title={labels.candidates} note={labels.candidatesNote}>
      {pending.length === 0 ? (
        <FormHint>{labels.candidatesNone}</FormHint>
      ) : (
        <div className="flex flex-col gap-4">
          {pending.map((candidate) => (
            <InlineForm
              key={candidate.candidateKey}
              onSubmit={(event) => {
                event.preventDefault();
                if (candidate.imei) {
                  onRun("register_modem", { modem_imei: candidate.imei });
                } else {
                  onRun("claim_modem_candidate", { candidate_key: candidate.candidateKey });
                }
              }}
            >
              <span>
                <Output>{candidate.imei ?? candidate.controlPort}</Output>
                <FormHint>
                  {candidate.imei ? `${candidate.controlPort} · ` : ""}
                  {candidate.transport}
                  {candidate.vendorId && candidate.productId
                    ? ` · ${candidate.vendorId}:${candidate.productId}`
                    : ""}
                  {candidate.usbDevice ? ` · ${candidate.usbDevice}` : ""}
                </FormHint>
              </span>
              <Button
                type="submit"
                variant={candidate.imei ? "ghost" : "risk"}
                disabled={busy}
              >
                {candidate.imei ? labels.candidateAdopt : labels.candidateClaim}
              </Button>
            </InlineForm>
          ))}
          <FormHint>{labels.candidatesHint}</FormHint>
        </div>
      )}
    </CardPanel>
  );
}

/**
 * The agent's own log, read from the cloud.
 *
 * `edge-panel/src/logs.rs` keeps these lines precisely because reaching them
 * otherwise means an SSH session and `journalctl` -- "the access an on-site
 * operator does not have". A cloud operator has less access than that, so the
 * ring is served here too rather than only over the LAN panel.
 *
 * The lines come back inside an ordinary command result, so this card is a
 * reader over the command log rather than a second fetch: whatever the newest
 * `read_logs` returned is what it shows, and the raw JSON stays visible in the
 * log card below for anything this rendering leaves out.
 */
function AgentLogCard({
  busy,
  commands,
  labels,
  onRun,
}: {
  busy: boolean;
  commands: CommandRow[];
  labels: Labels;
  onRun: Request;
}) {
  const [contains, setContains] = useState("");
  const newest = commands.find(
    (row) => row.kind === "read_logs" && row.result?.details !== undefined,
  );
  const lines = agentLogLines(newest?.result?.details);
  return (
    <CardPanel title={labels.agentLog} note={labels.agentLogNote}>
      <div className="flex flex-col gap-4">
        <InlineForm
          onSubmit={(event) => {
            event.preventDefault();
            const extra: Record<string, unknown> = {};
            if (contains.trim()) extra.log_contains = contains.trim();
            onRun("read_logs", extra);
          }}
        >
          <Field label={labels.agentLogFilter} inline>
            <Input
              value={contains}
              placeholder={labels.agentLogFilterHint}
              onChange={(event) => setContains(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={busy}>
            {labels.agentLogRead}
          </Button>
        </InlineForm>
        {lines === null ? (
          <FormHint>{labels.agentLogNone}</FormHint>
        ) : lines.length === 0 ? (
          <FormHint>{labels.agentLogEmpty}</FormHint>
        ) : (
          <Output>
            {lines
              .map((line) => `${new Date(line.at).toLocaleTimeString()}  ${line.text}`)
              .join("\n")}
          </Output>
        )}
      </div>
    </CardPanel>
  );
}

/**
 * The lines out of a `read_logs` result, or null when there is no result to
 * read yet.
 *
 * Written defensively because this is edge-supplied JSON crossing two hops:
 * a shape that does not match is drawn as "nothing to show" rather than
 * throwing inside a render.
 */
function agentLogLines(details: unknown): { at: number; text: string }[] | null {
  if (!details || typeof details !== "object") return null;
  const lines = (details as Record<string, unknown>).lines;
  if (!Array.isArray(lines)) return null;
  return lines.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.text !== "string") return [];
    return [{ at: typeof row.at === "number" ? row.at : 0, text: row.text }];
  });
}

/**
 * Writing one packet data context.
 *
 * The context identifier is a picker rather than a number box because it is an
 * address, not a quantity: `AT+QICSGP=1` and `AT+QICSGP=2` are different rows
 * on the module, and a typo in a free-text field rewrites the wrong one. The
 * list is 1..8 whatever the module reported, because a module holding no
 * contexts at all -- the EC200U-CN on this bench holds none -- is exactly the
 * one somebody needs to write a first context to.
 *
 * 🔴 **Blank means "leave it alone", and that is not a convention this
 * component invented.** `AT+QICSGP=` rewrites every field of the context, so
 * the edge puts back whatever it read for anything the request did not name.
 * Sending an empty username here would clear a working credential, so an
 * untouched box sends nothing at all, and clearing one is a separate,
 * deliberate act with its own checkbox.
 */
function ApnControls({
  busy,
  contexts,
  labels,
  onRun,
}: {
  busy: boolean;
  contexts: ApnContextRow[] | null;
  labels: Labels;
  onRun: Request;
}) {
  const [cid, setCid] = useState("1");
  const chosen = contexts?.find((row) => String(row.cid) === cid) ?? null;
  return (
    <div className="flex flex-col gap-4">
      <Field label={labels.apnContext} inline>
        <Select value={cid} onChange={(event) => setCid(event.target.value)}>
          {APN_CIDS.map((option) => {
            const known = contexts?.find((row) => row.cid === option);
            return (
              <option key={option} value={String(option)}>
                {option}
                {known?.apn ? `: ${known.apn}` : ""}
              </option>
            );
          })}
        </Select>
      </Field>
      {/* Keyed on the identifier so changing the picker starts from what that
          context actually holds. A useEffect writing the same values into
          state would be a second source of truth for the same boxes. */}
      <ApnEditor
        key={cid}
        cid={cid}
        context={chosen}
        busy={busy}
        labels={labels}
        onRun={onRun}
      />
    </div>
  );
}

/** The contexts a module addresses. 1..8 covers every family on this bench. */
const APN_CIDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const APN_AUTHS = ["none", "pap", "chap", "pap_or_chap"] as const;

function ApnEditor({
  cid,
  context,
  busy,
  labels,
  onRun,
}: {
  cid: string;
  context: ApnContextRow | null;
  busy: boolean;
  labels: Labels;
  onRun: Request;
}) {
  const [apn, setApn] = useState(context?.apn ?? "");
  const [pdpType, setPdpType] = useState(context?.pdpType ?? "");
  const [username, setUsername] = useState(context?.username ?? "");
  const [auth, setAuth] = useState(context?.auth ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const startingUsername = context?.username ?? "";
  return (
    <InlineForm
      onSubmit={(event) => {
        event.preventDefault();
        const extra: Record<string, unknown> = { cid: Number(cid), apn };
        if (pdpType) extra.pdp_type = pdpType;
        if (auth) extra.auth = auth;
        // Only a username the operator actually changed travels. Sending the
        // one read off the module back unchanged would be harmless today and
        // would become a silent overwrite the moment two people edit at once.
        if (username !== startingUsername) extra.username = username;
        if (clearPassword) extra.password = "";
        else if (password) extra.password = password;
        onRun("configure_apn", extra);
      }}
    >
      <Field label={labels.apn} inline>
        <Input value={apn} onChange={(event) => setApn(event.target.value)} />
      </Field>
      <Field label={labels.apnPdpType} inline>
        <Select value={pdpType} onChange={(event) => setPdpType(event.target.value)}>
          <option value="">{labels.apnKeep}</option>
          {["IP", "IPV6", "IPV4V6"].map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={labels.apnUsername} inline>
        <Input value={username} onChange={(event) => setUsername(event.target.value)} />
      </Field>
      <Field label={labels.apnAuth} inline>
        <Select value={auth} onChange={(event) => setAuth(event.target.value)}>
          <option value="">{labels.apnKeep}</option>
          {APN_AUTHS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      {/* `type="password"` with no reveal, like every other secret box in this
          console: the value is never read back from the module, so a reveal
          could only ever show what was typed a moment ago. */}
      <Field label={labels.apnPassword} inline>
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={clearPassword}
          placeholder={labels.apnPasswordKeep}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <InlineField label={labels.apnClearPassword}>
        <Checkbox
          checked={clearPassword}
          onChange={(event) => {
            setClearPassword(event.target.checked);
            if (event.target.checked) setPassword("");
          }}
        />
      </InlineField>
      <Button type="submit" variant="risk" disabled={busy}>
        {labels.run}
      </Button>
      <FormHint>{labels.apnHint}</FormHint>
    </InlineForm>
  );
}

/**
 * The danger zone.
 *
 * 🔴 A red border was the obvious way to draw this box and, when this was
 * written, it would not have rendered: the card root asked for a border width
 * and computed to `none 0px` on that build, which was
 * `BORDER_WIDTH_WITHOUT_A_STYLE` and was precisely the defect this card was
 * sent here to fix elsewhere in this file. **That reason is gone** — the
 * reset in `app/globals.css` now carries the border style the card root was
 * missing, and a red border here would draw today. The zone is still a wash
 * behind its header and a red heading, both of which are properties the
 * build really sets and were measured rather than assumed; the render was
 * not revisited just because the reason that first ruled out a border no
 * longer holds.
 *
 * The way back is in the same card and it is a separate row. It used to be two
 * plain buttons sitting *inside* the row of seven red ones, which is the
 * arrangement the card's own brief calls out: a dangerous action and its undo
 * should not look like eight peers.
 */
function DangerZone({
  busy,
  labels,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  onRun: Request;
}) {
  return (
    <Card>
      <CardHeader className="bg-bad-wash">
        <CardTitle className="text-destructive">{labels.danger}</CardTitle>
        <CardNote>{labels.dangerNote}</CardNote>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <ButtonRow>
            {DISRUPTIVE.map((kind) => (
              <Button
                key={kind}
                variant="risk"
                disabled={busy}
                onClick={() => onRun(kind, TURNS_OFF[kind] ?? {})}
              >
                {labels[kind]}
              </Button>
            ))}
          </ButtonRow>

          <p className="m-0 font-mono text-sm font-medium uppercase tracking-eyebrow text-muted-foreground">{labels.recovery}</p>
          <ButtonRow>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onRun("set_radio", { enabled: true })}
            >
              {labels.radioOn}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onRun("set_data_network", { enabled: true })}
            >
              {labels.dataOn}
            </Button>
          </ButtonRow>
          <FormHint>{labels.recoveryNote}</FormHint>
        </div>
      </CardContent>
    </Card>
  );
}

function CommandLogCard({ commands, labels }: { commands: CommandRow[]; labels: Labels }) {
  if (commands.length === 0) {
    return (
      <CardPanel title={labels.logTitle} note={labels.logNote} bodyless>
        <CardEmpty title={labels.noCommands} />
      </CardPanel>
    );
  }
  return (
    <CardPanel title={labels.logTitle} note={labels.logNote}>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {commands.map((row) => (
          <li key={row.id} className="rounded bg-muted p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs tabular-nums">{commandLabel(labels, row.kind)}</span>
              <Badge tone={toneForCommandStatus(row.status)}>{row.status}</Badge>
              <span className="text-muted-foreground">
                {new Date(row.issued_at).toISOString().replace("T", " ").slice(11, 19)}
              </span>
            </div>
            <CommandOutcome row={row} labels={labels} />
          </li>
        ))}
      </ol>
    </CardPanel>
  );
}

/**
 * What actually came back.
 *
 * A diagnostic's whole purpose is its reading, so `details` is rendered rather
 * than summarised — the shape differs per command and guessing at a summary
 * would hide the one line the operator is looking for.
 */
function CommandOutcome({ row, labels }: { row: CommandRow; labels: Labels }) {
  if (!row.result) {
    return TERMINAL.has(row.status) ? null : <FormHint>{labels.waiting}</FormHint>;
  }
  const reason = row.result.reason ?? row.result.reason_code;
  return (
    <>
      {reason ? <FormError>{reason}</FormError> : null}
      {row.result.details !== undefined && row.result.details !== null ? (
        <Output>{JSON.stringify(row.result.details, null, 2)}</Output>
      ) : null}
    </>
  );
}
