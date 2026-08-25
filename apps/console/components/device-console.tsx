"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  latestUssdExchange,
  ussdCancelRequest,
  ussdContinueRequest,
  ussdSessionAgeMs,
  ussdSessionState,
  ussdStageLabelKey,
  ussdStartRequest,
  type ModemRow,
  type UssdRequest,
  type UssdStageLabelKey,
} from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { operatorName } from "@/lib/plmn";
import { mayWrite, roleFromSessionBody, SESSION_ENDPOINT } from "@/lib/session";

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
  | "noModems"
  | "noCommands"
  | "waiting"
  | "failed"
  | "run"
  | "send"
  | "cancel"
  | "atCommand"
  | "ussdCode"
  | "ussdSession"
  | "ussdSessionModem"
  | "ussdReply"
  | "ussdContinue"
  | "ussdExpired"
  | UssdStageLabelKey
  | "selectOperator"
  | "pin"
  | "automatic"
  | "radioOn"
  | "dataOn"
  | "usbnetMode"
  | "usbnetWarning"
  | "confirmUsbnet"
  | "confirmDisruptive"
  | "modem_report"
  | "list_esim_profiles"
  | "restart_modem"
  | "reset_modem_usb"
  | "scan_operators"
  | "rotate_ip"
  | "set_radio"
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
] as const;

/**
 * Disruptive actions whose button means "off".
 *
 * Both of these can take a working module off the air, and both have a plain
 * companion button below that turns them back on. Kept as data rather than a
 * condition inside the loop: the second one is where a ternary would have
 * quietly started turning the radio off for the wrong command.
 */
const TURNS_OFF: Record<string, Record<string, unknown>> = {
  set_radio: { enabled: false },
  set_data_network: { enabled: false },
};

/** What the module can be told to expose over USB. */
const USBNET_MODES = ["rmnet", "ecm", "mbim", "rndis"] as const;

export function DeviceConsole({
  deviceId,
  modems,
  labels,
  locale,
}: {
  deviceId: string;
  modems: ModemRow[];
  labels: Labels;
  /**
   * The locale of the request, resolved on the server.
   *
   * Almost everything drawn here arrives already translated in `labels`, which
   * the page renders per request. The exception was the one sentence the page
   * cannot render for this component, because it depends on something the
   * server does not know: whether the session may write. That sentence was
   * looked up against a `useState<Locale>(DEFAULT_LOCALE)` that only became
   * the real locale inside an effect -- after hydration. The server runs no
   * effects and has no such state, so the HTML it sent said the default
   * language every time: an English request shipped `<html lang="en">` with a
   * Chinese read-only notice inside it, and the browser quietly corrected it on
   * mount. That is why it went unnoticed for so long. Reading the live DOM
   * shows the corrected text; only fetching the response without executing
   * JavaScript shows what was actually served.
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
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "unknown" until the gateway has been asked, and the controls are drawn for
  // "write" only. Closed by default on purpose: this component is rendered on
  // the server before it can ask anything, and an account's controls appearing
  // for one paint and then being taken away is a worse answer than appearing
  // one paint late. What it costs is a moment of empty console for an operator
  // who does have the rights.
  const [permission, setPermission] = useState<"unknown" | "write" | "read">("unknown");
  // Polling stops once nothing is outstanding, so an idle page costs nothing.
  const pending = commands.some((row) => !TERMINAL.has(row.status));
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
    if (!pending) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  const issue = useCallback(
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

  const rescan = (
    <button type="button" disabled={busy} onClick={() => void issue("refresh_modems")}>
      {labels.refresh_modems}
    </button>
  );

  // Every control in this component issues POST /v1/commands, which the
  // gateway refuses for a read-only session, so there is nothing here for one
  // to press — but the history of what the device has done is exactly what
  // such an account is for. The log stays.
  if (permission !== "write") {
    return (
      <div className="stack">
        {permission === "read" ? <p className="faint">{t("role.readOnlyDevice", locale)}</p> : null}
        <CommandLog commands={commands} labels={labels} />
      </div>
    );
  }

  if (modems.length === 0) {
    // The rescan stays reachable here on purpose. "Nothing is listed" is
    // exactly the situation the button exists for, and hiding it behind a
    // device that already has a modem would put it everywhere except where
    // someone is looking for it.
    return (
      <div className="stack">
        <p className="faint">{labels.noModems}</p>
        <div className="button-row">{rescan}</div>
        {error ? <p className="error">{error}</p> : null}
        <CommandLog commands={commands} labels={labels} />
      </div>
    );
  }

  return (
    <div className="stack">
      <label className="field">
        <span>{labels.modem}</span>
        <select value={imei} onChange={(event) => setImei(event.target.value)}>
          {modems.map((modem) => (
            <option key={modem.imei} value={modem.imei}>
              {modem.imei}
              {modem.homePlmn ? ` — ${operatorName(modem.homePlmn)}` : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="button-row">
        {READ_ONLY.map((kind) => (
          <button key={kind} type="button" disabled={busy} onClick={() => void issue(kind)}>
            {labels[kind]}
          </button>
        ))}
        {rescan}
      </div>

      <AtConsole busy={busy} labels={labels} onRun={issue} />
      <UssdConsole
        busy={busy}
        labels={labels}
        commands={commands}
        selectedImei={imei}
        onRun={issue}
      />
      <OperatorControls busy={busy} labels={labels} onRun={issue} />
      <UsbnetControls busy={busy} labels={labels} onRun={issue} />

      <div className="button-row">
        {DISRUPTIVE.map((kind) => (
          <button
            key={kind}
            type="button"
            className="risk"
            disabled={busy}
            onClick={() => {
              // These take the module off the network. The confirmation is
              // deliberate friction, not decoration.
              if (!window.confirm(labels.confirmDisruptive)) return;
              void issue(kind, TURNS_OFF[kind] ?? {});
            }}
          >
            {labels[kind]}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => void issue("set_radio", { enabled: true })}
        >
          {labels.radioOn}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void issue("set_data_network", { enabled: true })}
        >
          {labels.dataOn}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <CommandLog commands={commands} labels={labels} />
    </div>
  );
}

function AtConsole({
  busy,
  labels,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  onRun: (kind: string, extra: Record<string, unknown>) => Promise<void>;
}) {
  const [command, setCommand] = useState("AT+CSQ");
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onRun("run_at_command", { command });
      }}
    >
      <label className="field grow">
        <span>{labels.atCommand}</span>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <button type="submit" disabled={busy || command.trim().length < 2}>
        {labels.run}
      </button>
    </form>
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
  onRun: (kind: string, extra: Record<string, unknown>) => Promise<void>;
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

  const send = (request: UssdRequest | null) => {
    if (!request) return;
    void onRun("send_ussd", request);
  };

  return (
    <div className="stack">
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          send(ussdStartRequest(selectedImei, code));
        }}
      >
        <label className="field grow">
          <span>{labels.ussdCode}</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="*101#"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy || code.trim() === ""}>
          {labels.send}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => send(ussdCancelRequest(exchange, selectedImei))}
        >
          {labels.cancel}
        </button>
      </form>

      {result ? (
        <div className="stack">
          <p className="faint">{labels.ussdSession}</p>
          {/* The stage in words. Four of the seven mean "no answer" for four
              different reasons, and the raw result carries an empty `text` for
              all of them — which is what the one production run looked like:
              a JSON blob reading network_timeout, "" and 30232 ms. */}
          <p className={result.expectsReply ? undefined : "faint"}>
            {labels[ussdStageLabelKey(result.stage)]}
            {ussdStageLabelKey(result.stage) === "ussdStageOther" ? (
              <span className="mono faint"> {result.stage}</span>
            ) : null}
          </p>
          {result.text ? <pre className="output">{result.text}</pre> : null}

          {session === "open" ? (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                // Checked again here rather than trusting the render that drew
                // the button: the guard is a deadline, and nothing re-renders
                // the instant it passes.
                const at = Date.now();
                if (ussdSessionState(exchange, ussdSessionAgeMs(exchange, observedAt, at)) !== "open") {
                  setNow(at);
                  return;
                }
                send(ussdContinueRequest(exchange, reply));
                setReply("");
              }}
            >
              <label className="field grow">
                <span>{labels.ussdReply}</span>
                <input
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder="1"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <button type="submit" disabled={busy || reply.trim() === ""}>
                {labels.ussdContinue}
              </button>
              {/* Which module the reply goes to, because it is not necessarily
                  the one selected above and an operator has no other way to
                  tell. */}
              <span className="faint mono">
                {labels.ussdSessionModem} {exchange?.modemImei}
              </span>
            </form>
          ) : null}

          {/* A session that has aged out is the failure worth naming. Left
              silent, the reply box would simply stop being there, and the
              obvious next move — retyping "1" into the code box above — sends
              the menu item to the carrier as a service code. */}
          {session === "expired" ? <p className="error">{labels.ussdExpired}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function OperatorControls({
  busy,
  labels,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  onRun: (kind: string, extra: Record<string, unknown>) => Promise<void>;
}) {
  const [plmn, setPlmn] = useState("");
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onRun("select_operator", { mode: "manual", plmn });
      }}
    >
      <label className="field grow">
        <span>{labels.selectOperator}</span>
        <input
          value={plmn}
          onChange={(event) => setPlmn(event.target.value)}
          placeholder="460-01"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <button type="submit" disabled={busy || !/^[0-9]{3}-[0-9]{2,3}$/.test(plmn)}>
        {labels.pin}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void onRun("select_operator", { mode: "automatic" })}
      >
        {labels.automatic}
      </button>
    </form>
  );
}

/**
 * Which USB function the module exposes.
 *
 * Deliberately not one of the disruptive buttons above. Those take a module
 * off the air and leave it in the list; this one takes it out of the list
 * altogether, because the port the fleet is indexed by stops existing. That
 * is not something a generic "are you sure" describes.
 */
function UsbnetControls({
  busy,
  labels,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  onRun: (kind: string, extra: Record<string, unknown>) => Promise<void>;
}) {
  const [mode, setMode] = useState<string>("rmnet");
  // rmnet is the QMI mode this agent speaks. Any other choice re-enumerates
  // the module on the spot — not at its next restart — and it drops out of
  // the device list until this same control puts it back, which the agent
  // can do because it falls back to finding the module over its AT port.
  const strands = mode !== "rmnet";
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (strands && !window.confirm(labels.confirmUsbnet)) return;
        void onRun("set_usbnet_mode", { usbnet_mode: mode });
      }}
    >
      <label className="field grow">
        <span>{labels.usbnetMode}</span>
        <select value={mode} onChange={(event) => setMode(event.target.value)}>
          {USBNET_MODES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={strands ? "risk" : undefined} disabled={busy}>
        {labels.run}
      </button>
      {strands ? <p className="error">{labels.usbnetWarning}</p> : null}
    </form>
  );
}

function CommandLog({ commands, labels }: { commands: CommandRow[]; labels: Labels }) {
  if (commands.length === 0) {
    return <p className="faint">{labels.noCommands}</p>;
  }
  return (
    <ol className="command-log">
      {commands.map((row) => (
        <li key={row.id}>
          <div className="command-head">
            <span className="mono">{commandLabel(labels, row.kind)}</span>
            <StatusPill status={row.status} />
            <span className="faint mono">
              {new Date(row.issued_at).toISOString().replace("T", " ").slice(11, 19)}
            </span>
          </div>
          <CommandOutcome row={row} labels={labels} />
        </li>
      ))}
    </ol>
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
    return TERMINAL.has(row.status) ? null : <p className="faint">{labels.waiting}</p>;
  }
  const reason = row.result.reason ?? row.result.reason_code;
  return (
    <>
      {reason ? <p className="error">{reason}</p> : null}
      {row.result.details !== undefined && row.result.details !== null ? (
        <pre className="output">{JSON.stringify(row.result.details, null, 2)}</pre>
      ) : null}
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "succeeded"
      ? "badge-ok"
      : status === "failed" || status === "expired"
        ? "badge-bad"
        : "badge-warn";
  return <span className={`badge ${tone}`}>{status}</span>;
}
