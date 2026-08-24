"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { CountryRuleRow, ProxyInstanceRow, UpstreamRow } from "@/lib/catalog";

/**
 * Every user-visible string this component draws, named.
 *
 * It used to be Record<string, string>, filled from a hand-written list of key
 * names in app/proxy/page.tsx. Nothing connected the two: a control added here
 * that read a label nobody had listed there compiled fine, got `undefined`,
 * and React draws undefined as nothing at all — a button with no text, in
 * every locale, with no error anywhere. That is not hypothetical; it is why
 * the previous attempt at the export control was abandoned rather than
 * shipped.
 *
 * Naming the keys makes the page's list checkable, and PROXY_LABEL_KEYS over
 * in that file is what does the checking. A type-only import, so the server
 * component is not reaching into a client module for a value.
 */
export type ProxyLabelKey =
  | "upstreams"
  | "instances"
  | "noUpstreams"
  | "noInstances"
  | "colName"
  | "colAddress"
  | "colProbe"
  | "colListen"
  | "colModem"
  | "colUpstream"
  | "add"
  | "remove"
  | "start"
  | "stop"
  | "restart"
  | "direct"
  | "device"
  | "port"
  | "username"
  | "password"
  | "probeFrom"
  | "neverProbed"
  | "failed"
  | "confirmRemove"
  | "countryRules"
  | "noCountryRules"
  | "colCountry"
  | "export"
  | "exportNote"
  | "exportHost"
  | "exportHostHint"
  | "exportEmpty"
  | "exportUnexportable"
  | "exportFailed"
  | "exportClose"
  | "copy"
  | "copyAll"
  | "copied"
  | "copyFailed";

type Labels = Record<ProxyLabelKey, string>;

/**
 * Proxy configuration is desired state, not a live view.
 *
 * The listeners run on the edge, bound to a modem's interface so traffic
 * leaves over that SIM — which is the whole point and which no cloud host can
 * do. So saving a row records an intention and hands it to the device; what is
 * actually listening is whatever the device last reported.
 */
export function ProxyManager({
  upstreams,
  instances,
  countryRules,
  devices,
  labels,
  canExport,
}: {
  upstreams: UpstreamRow[];
  instances: ProxyInstanceRow[];
  countryRules: CountryRuleRow[];
  devices: { id: string; name: string }[];
  labels: Labels;
  /**
   * Whether to draw the export control at all.
   *
   * Courtesy, not enforcement. The gateway refuses an export from a read-only
   * session in the handler itself — it has to, because the read-only guard
   * decides by HTTP method and an export is a GET. Hiding the button only
   * spares a read-only operator from discovering that by clicking it.
   */
  canExport: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (path: string, init: RequestInit): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(path, {
          headers: { "content-type": "application/json" },
          ...init,
        });
        if (!response.ok) {
          setError((await response.text()).trim() || labels.failed);
          return false;
        }
        router.refresh();
        return true;
      } catch {
        setError(labels.failed);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [labels.failed, router],
  );

  return (
    <div className="stack">
      {error ? <p className="error">{error}</p> : null}

      <UpstreamList upstreams={upstreams} devices={devices} busy={busy} labels={labels} call={call} />
      <InstanceList
        instances={instances}
        upstreams={upstreams}
        devices={devices}
        busy={busy}
        labels={labels}
        call={call}
        canExport={canExport}
      />
      <CountryRuleList
        rules={countryRules}
        upstreams={upstreams}
        busy={busy}
        labels={labels}
        call={call}
      />
    </div>
  );
}

type Call = (path: string, init: RequestInit) => Promise<boolean>;

function UpstreamList({
  upstreams,
  devices,
  busy,
  labels,
  call,
}: {
  upstreams: UpstreamRow[];
  devices: { id: string; name: string }[];
  busy: boolean;
  labels: Labels;
  call: Call;
}) {
  const [draft, setDraft] = useState({ name: "", address: "", username: "", password: "" });

  return (
    <section className="stack">
      <h3 className="section-title">{labels.upstreams}</h3>

      {upstreams.length === 0 ? (
        <p className="faint">{labels.noUpstreams}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{labels.colName}</th>
                <th>{labels.colAddress}</th>
                <th>{labels.colProbe}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {upstreams.map((upstream) => (
                <tr key={upstream.id}>
                  <td>{upstream.name}</td>
                  <td className="mono">{upstream.address}</td>
                  <td>
                    <ProbeCell probe={upstream.lastProbe} at={upstream.lastProbeAt} labels={labels} />
                  </td>
                  <td className="row-actions">
                    {/* A probe runs from a device, because the question is
                        whether that device can reach the proxy. */}
                    <select
                      defaultValue=""
                      disabled={busy || devices.length === 0}
                      onChange={(event) => {
                        const deviceId = event.target.value;
                        if (!deviceId) return;
                        void call(`/v1/proxy/upstreams/${upstream.id}/probe`, {
                          method: "POST",
                          body: JSON.stringify({ device_id: deviceId }),
                        });
                        event.target.value = "";
                      }}
                    >
                      <option value="">{labels.probeFrom}</option>
                      {devices.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="risk"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(labels.confirmRemove)) return;
                        void call(`/v1/proxy/upstreams/${upstream.id}`, { method: "DELETE" });
                      }}
                    >
                      {labels.remove}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void call("/v1/proxy/upstreams", {
            method: "POST",
            body: JSON.stringify({ ...draft, protocol: "socks5", enabled: true }),
          }).then((ok) => {
            if (ok) setDraft({ name: "", address: "", username: "", password: "" });
          });
        }}
      >
        <label className="field">
          <span>{labels.colName}</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
          />
        </label>
        <label className="field">
          <span>{labels.colAddress}</span>
          <input
            value={draft.address}
            onChange={(event) => setDraft({ ...draft, address: event.target.value })}
            placeholder="proxy.example.com:1080"
            spellCheck={false}
            required
          />
        </label>
        <label className="field">
          <span>{labels.username}</span>
          <input
            value={draft.username}
            onChange={(event) => setDraft({ ...draft, username: event.target.value })}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>{labels.password}</span>
          <input
            type="password"
            value={draft.password}
            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
            autoComplete="new-password"
          />
        </label>
        <button type="submit" disabled={busy}>
          {labels.add}
        </button>
      </form>
    </section>
  );
}

function ProbeCell({
  probe,
  at,
  labels,
}: {
  probe: Record<string, unknown> | null;
  at: number | null;
  labels: Labels;
}) {
  if (!probe) return <span className="faint">{labels.neverProbed}</span>;
  const ok = probe.ok === true;
  const stage = typeof probe.stage === "string" ? probe.stage : "unknown";
  return (
    <span>
      <span className={`badge ${ok ? "badge-ok" : "badge-bad"}`}>{stage}</span>
      {/* The stage is what says which thing to fix, so the hint travels with
          it rather than being flattened into a pass/fail. */}
      {!ok && typeof probe.hint === "string" ? (
        <span className="faint"> — {probe.hint}</span>
      ) : null}
      {at ? (
        <span className="faint mono">
          {" "}
          {new Date(at).toISOString().replace("T", " ").slice(5, 16)}
        </span>
      ) : null}
    </span>
  );
}

function InstanceList({
  instances,
  upstreams,
  devices,
  busy,
  labels,
  call,
  canExport,
}: {
  instances: ProxyInstanceRow[];
  upstreams: UpstreamRow[];
  devices: { id: string; name: string }[];
  busy: boolean;
  labels: Labels;
  call: Call;
  canExport: boolean;
}) {
  const [draft, setDraft] = useState({
    name: "",
    device_id: devices[0]?.id ?? "",
    modem_imei: "",
    listen_port: "1080",
    upstream_id: "",
  });

  return (
    <section className="stack">
      <h3 className="section-title">{labels.instances}</h3>

      {instances.length === 0 ? (
        <p className="faint">{labels.noInstances}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{labels.colName}</th>
                <th>{labels.colListen}</th>
                <th>{labels.colModem}</th>
                <th>{labels.colUpstream}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {instances.map((instance) => (
                <tr key={instance.id}>
                  <td>{instance.name}</td>
                  <td className="mono">
                    {instance.listenAddr}:{instance.listenPort}
                  </td>
                  <td className="mono faint">{instance.modemImei}</td>
                  <td>
                    {upstreams.find((upstream) => upstream.id === instance.upstreamId)?.name ?? (
                      <span className="faint">{labels.direct}</span>
                    )}
                  </td>
                  <td className="row-actions">
                    {(["start", "stop", "restart"] as const).map((action) => (
                      <button
                        key={action}
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void call(`/v1/proxy/instances/${instance.id}/${action}`, {
                            method: "POST",
                          })
                        }
                      >
                        {labels[action]}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="risk"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(labels.confirmRemove)) return;
                        void call(`/v1/proxy/instances/${instance.id}`, { method: "DELETE" });
                      }}
                    >
                      {labels.remove}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canExport ? <ExportPanel busy={busy} labels={labels} /> : null}

      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void call("/v1/proxy/instances", {
            method: "POST",
            body: JSON.stringify({
              ...draft,
              listen_port: Number(draft.listen_port),
              protocol: "socks5",
              enabled: true,
            }),
          }).then((ok) => {
            if (ok) setDraft({ ...draft, name: "", modem_imei: "" });
          });
        }}
      >
        <label className="field">
          <span>{labels.colName}</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
          />
        </label>
        <label className="field">
          <span>{labels.device}</span>
          <select
            value={draft.device_id}
            onChange={(event) => setDraft({ ...draft, device_id: event.target.value })}
            required
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{labels.colModem}</span>
          <input
            value={draft.modem_imei}
            onChange={(event) => setDraft({ ...draft, modem_imei: event.target.value })}
            placeholder="867018069514820"
            spellCheck={false}
            required
          />
        </label>
        <label className="field">
          <span>{labels.port}</span>
          <input
            type="number"
            value={draft.listen_port}
            onChange={(event) => setDraft({ ...draft, listen_port: event.target.value })}
            min={1024}
            max={65535}
            required
          />
        </label>
        <label className="field">
          <span>{labels.colUpstream}</span>
          <select
            value={draft.upstream_id}
            onChange={(event) => setDraft({ ...draft, upstream_id: event.target.value })}
          >
            <option value="">{labels.direct}</option>
            {upstreams.map((upstream) => (
              <option key={upstream.id} value={upstream.id}>
                {upstream.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || devices.length === 0}>
          {labels.add}
        </button>
      </form>
    </section>
  );
}

/** One listener rendered as something a client can dial. */
type ExportEndpoint = {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  /** The connection string, percent-encoded, with the password in it. */
  url: string;
};

/** A listener no connection string could be written for, and why. */
type ExportSkip = { id: string; name: string; reason: string };

/**
 * Handing an operator a usable proxy credential.
 *
 * Everything needed to dial a listener was already on this page except the
 * password, which is write-only everywhere else, so using one meant reading
 * four columns off the table and assembling socks5://user:pass@host:port by
 * eye. This asks the gateway to assemble it instead.
 *
 * Where the secret goes, which is the whole design:
 *
 *   - Out of the gateway in a response body, over the same session the rest of
 *     this component uses. Never in a URL: a query string is in the browser's
 *     history, the referrer of anything the page loads next, and every
 *     intermediary's access log.
 *   - Into React state, and nowhere else. Not localStorage, not sessionStorage,
 *     not a cookie — those survive the tab, and this must not. Hide, or a
 *     reload, is the end of it.
 *   - Onto the clipboard only when the operator asks, one string or all of
 *     them, because pasting it into a client is the entire point.
 *   - Not onto the screen. What is drawn is the same string with the password
 *     removed, so an operator can tell the rows apart, check the host and port
 *     they are about to hand out, and do it with somebody standing behind
 *     them.
 *
 * Listeners that could not be exported are shown with the gateway's reason
 * rather than dropped. A listener bound to 0.0.0.0 answers on every address
 * and the configuration records none of them, so the gateway refuses to invent
 * one and says to repeat the request with an address. Silently returning a
 * shorter list is how an operator concludes the proxy does not exist.
 */
function ExportPanel({ busy, labels }: { busy: boolean; labels: Labels }) {
  const [host, setHost] = useState("");
  const [result, setResult] = useState<{
    endpoints: ExportEndpoint[];
    skipped: ExportSkip[];
  } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setNote(null);
    try {
      // The host is an address to dial, not a secret, so it is the one thing
      // that may travel in the query string. The credentials come back in the
      // body.
      const query = new URLSearchParams({ format: "json" });
      const dial = host.trim();
      if (dial) query.set("host", dial);
      const response = await fetch(`/v1/proxy/instances/export?${query.toString()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) {
        // The gateway's refusals say what to do about them — a read-only
        // account, an unusable host — and are more use than a generic failure.
        setError((await response.text()).trim() || labels.exportFailed);
        setResult(null);
        return;
      }
      setResult(readExport(await response.json()));
    } catch {
      setError(labels.exportFailed);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [host, labels.exportFailed]);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setError(null);
        setNote(labels.copied);
      } catch {
        // An insecure origin, or a browser that refused the permission. Saying
        // so beats a button that silently does nothing.
        setNote(null);
        setError(labels.copyFailed);
      }
    },
    [labels.copied, labels.copyFailed],
  );

  return (
    <div className="stack">
      <div className="inline-form">
        <label className="field">
          <span>{labels.exportHost}</span>
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="proxy.example.com"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <button type="button" disabled={busy || running} onClick={() => void run()}>
          {labels.export}
        </button>
        {result ? (
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setNote(null);
              setError(null);
            }}
          >
            {labels.exportClose}
          </button>
        ) : null}
      </div>
      <p className="faint">{labels.exportHostHint}</p>

      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="faint">{note}</p> : null}

      {result ? (
        <div className="stack">
          <p className="faint">{labels.exportNote}</p>

          {result.endpoints.length === 0 ? (
            <p className="faint">{labels.exportEmpty}</p>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{labels.colName}</th>
                      <th>{labels.colAddress}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {result.endpoints.map((endpoint) => (
                      <tr key={endpoint.id}>
                        <td>{endpoint.name}</td>
                        <td className="mono">{withoutPassword(endpoint)}</td>
                        <td className="row-actions">
                          <button type="button" onClick={() => void copy(endpoint.url)}>
                            {labels.copy}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  onClick={() =>
                    void copy(result.endpoints.map((endpoint) => endpoint.url).join("\n"))
                  }
                >
                  {labels.copyAll}
                </button>
              </div>
            </>
          )}

          {result.skipped.length === 0 ? null : (
            <section className="stack">
              <h4 className="section-title">{labels.exportUnexportable}</h4>
              <ul>
                {result.skipped.map((item) => (
                  <li key={item.id}>
                    {item.name} <span className="faint">— {item.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What to draw for a row, which is the connection string minus the password.
 *
 * Parsing the gateway's own string rather than rebuilding one keeps what is on
 * screen and what reaches the clipboard from drifting apart — an IPv6 host
 * needs brackets, a username needs percent-encoding, and a second
 * implementation of those rules is a second chance to get them wrong.
 *
 * If the string will not parse the fields are used instead. Never the raw
 * string: a fallback that printed it would put the password on screen exactly
 * when something unexpected is going on.
 */
function withoutPassword(endpoint: ExportEndpoint): string {
  try {
    const parsed = new URL(endpoint.url);
    parsed.password = "";
    return parsed.toString();
  } catch {
    const user = endpoint.username ? `${encodeURIComponent(endpoint.username)}@` : "";
    return `${endpoint.protocol}://${user}${endpoint.host}:${endpoint.port}`;
  }
}

/** The export response, read defensively because it is JSON off the wire. */
function readExport(body: unknown): { endpoints: ExportEndpoint[]; skipped: ExportSkip[] } {
  const root = (body ?? {}) as Record<string, unknown>;
  const instances = Array.isArray(root.instances) ? root.instances : [];
  const unexportable = Array.isArray(root.unexportable) ? root.unexportable : [];
  return {
    endpoints: instances.map((value, index) => {
      const row = (value ?? {}) as Record<string, unknown>;
      return {
        id: text(row.id) || `endpoint-${index}`,
        name: text(row.name),
        protocol: text(row.protocol) || "socks5",
        host: text(row.host),
        port: typeof row.port === "number" ? row.port : 0,
        username: text(row.username),
        url: text(row.url),
      };
    }),
    skipped: unexportable.map((value, index) => {
      const row = (value ?? {}) as Record<string, unknown>;
      return {
        id: text(row.id) || `skipped-${index}`,
        name: text(row.name),
        reason: text(row.reason),
      };
    }),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Which upstream a card from a given country should chain through.
 *
 * Keyed by country rather than by network because that is what an operator
 * reasons about — "traffic on Hong Kong cards goes out via the HK exit" — and
 * because a country has many networks whose answer is the same. The edge maps
 * a card's MCC to a country before consulting this.
 */
function CountryRuleList({
  rules,
  upstreams,
  busy,
  labels,
  call,
}: {
  rules: CountryRuleRow[];
  upstreams: UpstreamRow[];
  busy: boolean;
  labels: Labels;
  call: Call;
}) {
  const [code, setCode] = useState("");
  const [upstreamId, setUpstreamId] = useState("");

  return (
    <section className="stack">
      <h3 className="section-title">{labels.countryRules}</h3>

      {rules.length === 0 ? (
        <p className="faint">{labels.noCountryRules}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{labels.colCountry}</th>
                <th>{labels.colUpstream}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.countryCode}>
                  <td className="mono">{rule.countryCode}</td>
                  <td>
                    {upstreams.find((upstream) => upstream.id === rule.upstreamId)?.name ?? (
                      <span className="faint">{labels.direct}</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="risk"
                      disabled={busy}
                      onClick={() =>
                        void call(`/v1/proxy/country-rules/${rule.countryCode}`, {
                          method: "DELETE",
                        })
                      }
                    >
                      {labels.remove}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void call(`/v1/proxy/country-rules/${code.toUpperCase()}`, {
            method: "PUT",
            body: JSON.stringify({ upstream_id: upstreamId }),
          }).then((ok) => {
            if (ok) setCode("");
          });
        }}
      >
        <label className="field">
          <span>{labels.colCountry}</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="HK"
            maxLength={2}
            pattern="[A-Za-z]{2}"
            spellCheck={false}
            required
          />
        </label>
        <label className="field">
          <span>{labels.colUpstream}</span>
          <select value={upstreamId} onChange={(event) => setUpstreamId(event.target.value)}>
            <option value="">{labels.direct}</option>
            {upstreams.map((upstream) => (
              <option key={upstream.id} value={upstream.id}>
                {upstream.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || code.length !== 2}>
          {labels.add}
        </button>
      </form>
    </section>
  );
}
