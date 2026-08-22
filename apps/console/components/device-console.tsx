"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModemRow } from "@/lib/catalog";
import { operatorName } from "@/lib/plmn";

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

type Labels = Record<string, string>;

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
] as const;

export function DeviceConsole({
  deviceId,
  modems,
  labels,
}: {
  deviceId: string;
  modems: ModemRow[];
  labels: Labels;
}) {
  const [imei, setImei] = useState(modems[0]?.imei ?? "");
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Polling stops once nothing is outstanding, so an idle page costs nothing.
  const pending = commands.some((row) => !TERMINAL.has(row.status));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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

  if (modems.length === 0) {
    return <p className="faint">{labels.noModems}</p>;
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
            {labels[kind] ?? kind}
          </button>
        ))}
      </div>

      <AtConsole busy={busy} labels={labels} onRun={issue} />
      <UssdConsole busy={busy} labels={labels} onRun={issue} />
      <OperatorControls busy={busy} labels={labels} onRun={issue} />

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
              void issue(kind, kind === "set_radio" ? { enabled: false } : {});
            }}
          >
            {labels[kind] ?? kind}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => void issue("set_radio", { enabled: true })}
        >
          {labels.radioOn}
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

function UssdConsole({
  busy,
  labels,
  onRun,
}: {
  busy: boolean;
  labels: Labels;
  onRun: (kind: string, extra: Record<string, unknown>) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onRun("send_ussd", { code, stage: "start" });
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
      <button type="button" disabled={busy} onClick={() => void onRun("send_ussd", { stage: "cancel" })}>
        {labels.cancel}
      </button>
    </form>
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

function CommandLog({ commands, labels }: { commands: CommandRow[]; labels: Labels }) {
  if (commands.length === 0) {
    return <p className="faint">{labels.noCommands}</p>;
  }
  return (
    <ol className="command-log">
      {commands.map((row) => (
        <li key={row.id}>
          <div className="command-head">
            <span className="mono">{labels[row.kind] ?? row.kind}</span>
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
