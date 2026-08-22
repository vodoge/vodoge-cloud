"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProxyInstanceRow, UpstreamRow } from "@/lib/catalog";

type Labels = Record<string, string>;

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
  devices,
  labels,
}: {
  upstreams: UpstreamRow[];
  instances: ProxyInstanceRow[];
  devices: { id: string; name: string }[];
  labels: Labels;
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
}: {
  instances: ProxyInstanceRow[];
  upstreams: UpstreamRow[];
  devices: { id: string; name: string }[];
  busy: boolean;
  labels: Labels;
  call: Call;
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
