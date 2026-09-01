"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonRow, RowActions } from "@/components/ui/button-row";
import { ConfirmDialog, type ConfirmLabels } from "@/components/ui/confirm-dialog";
import { Field, FormError, InlineForm, Input, Select } from "@/components/ui/form";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import type { CountryRuleRow, ProxyInstanceRow, UpstreamRow } from "@/lib/catalog";
import { cn } from "@/lib/cn";
import { interpolate } from "@/lib/i18n";
import { FORM, PAGE } from "@/lib/tokens";

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
 *
 * The ten `confirm*` entries are the five confirmations this page asks for,
 * each as a title and a consequence. They carry `{…}` placeholders that
 * `interpolate` fills in here, because only this side knows which row the
 * operator clicked — and because a consequence that does not name the object
 * is the defect the dialog exists to stop.
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
  | "confirmRemoveUpstreamTitle"
  | "confirmRemoveUpstream"
  | "confirmRemoveInstanceTitle"
  | "confirmRemoveInstance"
  | "confirmRemoveRuleTitle"
  | "confirmRemoveRule"
  | "confirmStopTitle"
  | "confirmStop"
  | "confirmRestartTitle"
  | "confirmRestart"
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
 * One thing the operator is about to do that cannot simply be undone.
 *
 * `run` is the request, held rather than sent. Nothing in this component calls
 * a destructive endpoint from a click handler any more: the click builds one
 * of these and hands it to `ask`, and the only place `run` is invoked is the
 * dialog's confirm button. That is what makes "is this action guarded" a
 * question about where the call is written, which `tokens.test.ts` can answer,
 * rather than a question about what a reviewer remembered to look at.
 */
type Pending = {
  title: string;
  consequence: string;
  /** The verb repeated on the confirm button: Remove, Stop, Restart. */
  confirmLabel: string;
  run: () => void;
};

type Ask = (action: Pending) => void;

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
  confirmLabels,
  canExport,
}: {
  upstreams: UpstreamRow[];
  instances: ProxyInstanceRow[];
  countryRules: CountryRuleRow[];
  devices: { id: string; name: string }[];
  labels: Labels;
  /** The dialog's own chrome, so every confirmation asks in the same words. */
  confirmLabels: ConfirmLabels;
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
  const [pending, setPending] = useState<Pending | null>(null);

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

  const ask = useCallback((action: Pending) => setPending(action), []);
  const cancel = useCallback(() => setPending(null), []);
  // The dialog is only mounted while `pending` is set, so this reads the
  // action it is showing. Deliberately not a state updater with the call
  // inside it: React may run an updater twice, and this one sends a request.
  const proceed = useCallback(() => {
    if (!pending) return;
    const { run } = pending;
    setPending(null);
    run();
  }, [pending]);

  return (
    <div className={PAGE.stack}>
      {error ? <FormError>{error}</FormError> : null}

      <UpstreamList
        upstreams={upstreams}
        instances={instances}
        devices={devices}
        busy={busy}
        labels={labels}
        call={call}
        ask={ask}
      />
      <InstanceList
        instances={instances}
        upstreams={upstreams}
        devices={devices}
        busy={busy}
        labels={labels}
        call={call}
        ask={ask}
        canExport={canExport}
      />
      <CountryRuleList
        rules={countryRules}
        upstreams={upstreams}
        busy={busy}
        labels={labels}
        call={call}
        ask={ask}
      />

      {pending ? (
        <ConfirmDialog
          open
          title={pending.title}
          consequence={pending.consequence}
          confirmLabel={pending.confirmLabel}
          labels={confirmLabels}
          busy={busy}
          onConfirm={proceed}
          onCancel={cancel}
        />
      ) : null}
    </div>
  );
}

type Call = (path: string, init: RequestInit) => Promise<boolean>;

/** The upstream a listener chains through, or the word for "none". */
function upstreamName(
  upstreams: UpstreamRow[],
  upstreamId: string,
  labels: Labels,
): string {
  return upstreams.find((upstream) => upstream.id === upstreamId)?.name ?? labels.direct;
}

/** `host:port`, which is how a listener is dialled and how it is recognised. */
function listenAddress(instance: ProxyInstanceRow): string {
  return `${instance.listenAddr}:${instance.listenPort}`;
}

function UpstreamList({
  upstreams,
  instances,
  devices,
  busy,
  labels,
  call,
  ask,
}: {
  upstreams: UpstreamRow[];
  instances: ProxyInstanceRow[];
  devices: { id: string; name: string }[];
  busy: boolean;
  labels: Labels;
  call: Call;
  ask: Ask;
}) {
  const [draft, setDraft] = useState({ name: "", address: "", username: "", password: "" });

  return (
    <section className={PAGE.section}>
      <h3 className={PAGE.sectionTitle}>{labels.upstreams}</h3>

      {upstreams.length === 0 ? (
        <p className={PAGE.note}>{labels.noUpstreams}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow head>
              <TableHead>{labels.colName}</TableHead>
              <TableHead>{labels.colAddress}</TableHead>
              {/* Diagnostics rather than identity: the column an operator on a
                  phone can do without, and the one that carries a sentence. */}
              <TableHead secondary>{labels.colProbe}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {upstreams.map((upstream) => (
              <TableRow key={upstream.id}>
                <TableCell>{upstream.name}</TableCell>
                <TableCell mono>{upstream.address}</TableCell>
                <TableCell secondary>
                  <ProbeCell probe={upstream.lastProbe} at={upstream.lastProbeAt} labels={labels} />
                </TableCell>
                <TableCell>
                  <RowActions>
                    {/* A probe runs from a device, because the question is
                        whether that device can reach the proxy. */}
                    <Select
                      compact
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
                    </Select>
                    <Button
                      variant="risk"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        ask({
                          title: interpolate(labels.confirmRemoveUpstreamTitle, {
                            name: upstream.name,
                          }),
                          // The count is the part nobody could have known: the
                          // listeners chaining through this upstream are on a
                          // different table, and losing it silently sends their
                          // traffic out of the wrong address.
                          consequence: interpolate(labels.confirmRemoveUpstream, {
                            name: upstream.name,
                            address: upstream.address,
                            count: instances.filter(
                              (instance) => instance.upstreamId === upstream.id,
                            ).length,
                          }),
                          confirmLabel: labels.remove,
                          run: () =>
                            void call(`/v1/proxy/upstreams/${upstream.id}`, { method: "DELETE" }),
                        })
                      }
                    >
                      {labels.remove}
                    </Button>
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <InlineForm
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
        <Field inline label={labels.colName}>
          <Input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
          />
        </Field>
        <Field inline label={labels.colAddress}>
          <Input
            value={draft.address}
            onChange={(event) => setDraft({ ...draft, address: event.target.value })}
            placeholder="proxy.example.com:1080"
            spellCheck={false}
            required
          />
        </Field>
        <Field inline label={labels.username}>
          <Input
            value={draft.username}
            onChange={(event) => setDraft({ ...draft, username: event.target.value })}
            autoComplete="off"
          />
        </Field>
        <Field inline label={labels.password}>
          {/* The one password box on this page. `SecretInput` rather than an
              `Input type="password"` so that the stored-secret rules live in
              one place for every credential in this console: an already-stored
              secret shows an empty box with the marker as its placeholder, and
              the marker is never echoed into the value where submitting the
              form would save it as the password. Nothing hands this field a
              stored value today, which is exactly why it is worth having the
              rule rather than the memory. */}
          <SecretInput
            value={draft.password}
            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {labels.add}
        </Button>
      </InlineForm>
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
  if (!probe) return <span className={PAGE.faint}>{labels.neverProbed}</span>;
  const ok = probe.ok === true;
  const stage = typeof probe.stage === "string" ? probe.stage : "unknown";
  return (
    <span>
      <Badge tone={ok ? "ok" : "bad"}>{stage}</Badge>
      {/* The stage is what says which thing to fix, so the hint travels with
          it rather than being flattened into a pass/fail. */}
      {!ok && typeof probe.hint === "string" ? (
        <span className={PAGE.faint}> — {probe.hint}</span>
      ) : null}
      {at ? (
        <span className={cn(PAGE.mono, PAGE.faint)}>
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
  ask,
  canExport,
}: {
  instances: ProxyInstanceRow[];
  upstreams: UpstreamRow[];
  devices: { id: string; name: string }[];
  busy: boolean;
  labels: Labels;
  call: Call;
  ask: Ask;
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
    <section className={PAGE.section}>
      <h3 className={PAGE.sectionTitle}>{labels.instances}</h3>

      {instances.length === 0 ? (
        <p className={PAGE.note}>{labels.noInstances}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow head>
              <TableHead>{labels.colName}</TableHead>
              <TableHead>{labels.colListen}</TableHead>
              {/* Fifteen digits of IMEI, and the answer to "which module" is
                  already in the listener's name on a phone-sized screen. */}
              <TableHead secondary>{labels.colModem}</TableHead>
              <TableHead>{labels.colUpstream}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {instances.map((instance) => (
              <TableRow key={instance.id}>
                <TableCell>{instance.name}</TableCell>
                <TableCell mono>{listenAddress(instance)}</TableCell>
                <TableCell mono faint secondary>
                  {instance.modemImei}
                </TableCell>
                <TableCell>
                  {upstreams.find((upstream) => upstream.id === instance.upstreamId)?.name ?? (
                    <span className={PAGE.faint}>{labels.direct}</span>
                  )}
                </TableCell>
                <TableCell>
                  <RowActions>
                    {/* Start, stop and restart used to be a mapped array of
                        three identical buttons with no confirmation on any of
                        them — and `restart` and `start` were indistinguishable
                        at a glance, which is the worst possible pairing: one
                        brings a listener up and the other drops every
                        connection running through it. They are three separate
                        controls now, and only the two that interrupt traffic
                        are red and ask first. */}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void call(`/v1/proxy/instances/${instance.id}/start`, { method: "POST" })
                      }
                    >
                      {labels.start}
                    </Button>
                    <Button
                      variant="risk"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        ask({
                          title: interpolate(labels.confirmStopTitle, { name: instance.name }),
                          consequence: interpolate(labels.confirmStop, {
                            name: instance.name,
                            listen: listenAddress(instance),
                          }),
                          confirmLabel: labels.stop,
                          run: () =>
                            void call(`/v1/proxy/instances/${instance.id}/stop`, {
                              method: "POST",
                            }),
                        })
                      }
                    >
                      {labels.stop}
                    </Button>
                    <Button
                      variant="risk"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        ask({
                          title: interpolate(labels.confirmRestartTitle, { name: instance.name }),
                          consequence: interpolate(labels.confirmRestart, {
                            name: instance.name,
                            listen: listenAddress(instance),
                          }),
                          confirmLabel: labels.restart,
                          run: () =>
                            void call(`/v1/proxy/instances/${instance.id}/restart`, {
                              method: "POST",
                            }),
                        })
                      }
                    >
                      {labels.restart}
                    </Button>
                    <Button
                      variant="risk"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        ask({
                          title: interpolate(labels.confirmRemoveInstanceTitle, {
                            name: instance.name,
                          }),
                          consequence: interpolate(labels.confirmRemoveInstance, {
                            name: instance.name,
                            listen: listenAddress(instance),
                          }),
                          confirmLabel: labels.remove,
                          run: () =>
                            void call(`/v1/proxy/instances/${instance.id}`, { method: "DELETE" }),
                        })
                      }
                    >
                      {labels.remove}
                    </Button>
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {canExport ? <ExportPanel busy={busy} labels={labels} /> : null}

      <InlineForm
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
        <Field inline label={labels.colName}>
          <Input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
          />
        </Field>
        <Field inline label={labels.device}>
          <Select
            value={draft.device_id}
            onChange={(event) => setDraft({ ...draft, device_id: event.target.value })}
            required
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field inline label={labels.colModem}>
          <Input
            value={draft.modem_imei}
            onChange={(event) => setDraft({ ...draft, modem_imei: event.target.value })}
            placeholder="867018069514820"
            spellCheck={false}
            required
          />
        </Field>
        {/* A port and a country code are two or five characters wide. They are
            the two fields that do not take `inline`, which would give each of
            them an equal share of the row next to a name and an address. */}
        <Field label={labels.port}>
          <Input
            type="number"
            value={draft.listen_port}
            onChange={(event) => setDraft({ ...draft, listen_port: event.target.value })}
            min={1024}
            max={65535}
            required
          />
        </Field>
        <Field inline label={labels.colUpstream}>
          <Select
            value={draft.upstream_id}
            onChange={(event) => setDraft({ ...draft, upstream_id: event.target.value })}
          >
            <option value="">{labels.direct}</option>
            {upstreams.map((upstream) => (
              <option key={upstream.id} value={upstream.id}>
                {upstream.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={busy || devices.length === 0}>
          {labels.add}
        </Button>
      </InlineForm>
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
    <div className={PAGE.section}>
      {/* A row of controls rather than a form: there is no submit here, and a
          form would turn Return in the host field into an export. */}
      <div className={FORM.inline}>
        <Field inline label={labels.exportHost}>
          <Input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="proxy.example.com"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Button disabled={busy || running} onClick={() => void run()}>
          {labels.export}
        </Button>
        {result ? (
          <Button
            variant="outline"
            onClick={() => {
              setResult(null);
              setNote(null);
              setError(null);
            }}
          >
            {labels.exportClose}
          </Button>
        ) : null}
      </div>
      <p className={PAGE.note}>{labels.exportHostHint}</p>

      {error ? <FormError>{error}</FormError> : null}
      {note ? <p className={PAGE.note}>{note}</p> : null}

      {result ? (
        <div className={PAGE.section}>
          <p className={PAGE.note}>{labels.exportNote}</p>

          {result.endpoints.length === 0 ? (
            <p className={PAGE.note}>{labels.exportEmpty}</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow head>
                    <TableHead>{labels.colName}</TableHead>
                    <TableHead>{labels.colAddress}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.endpoints.map((endpoint) => (
                    <TableRow key={endpoint.id}>
                      <TableCell>{endpoint.name}</TableCell>
                      <TableCell mono>{withoutPassword(endpoint)}</TableCell>
                      <TableCell>
                        <RowActions>
                          {/* The connection string with the password in it
                              goes to the clipboard and nowhere else. What the
                              row draws is `withoutPassword(endpoint)`. */}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void copy(endpoint.url)}
                          >
                            {labels.copy}
                          </Button>
                        </RowActions>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ButtonRow>
                <Button
                  onClick={() =>
                    void copy(result.endpoints.map((endpoint) => endpoint.url).join("\n"))
                  }
                >
                  {labels.copyAll}
                </Button>
              </ButtonRow>
            </>
          )}

          {result.skipped.length === 0 ? null : (
            <section className={PAGE.section}>
              <h4 className={PAGE.sectionTitle}>{labels.exportUnexportable}</h4>
              {/* The gateway's own reason, verbatim — it is the one that tells
                  an operator to repeat the request with `?host=`. A bare list:
                  neither `ul` nor `li` is styled by the legacy layer, so this
                  renders in the browser's defaults today and after that layer
                  is deleted, which is the same thing before and after. */}
              <ul>
                {result.skipped.map((item) => (
                  <li key={item.id}>
                    {item.name} <span className={PAGE.faint}>— {item.reason}</span>
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
  ask,
}: {
  rules: CountryRuleRow[];
  upstreams: UpstreamRow[];
  busy: boolean;
  labels: Labels;
  call: Call;
  ask: Ask;
}) {
  const [code, setCode] = useState("");
  const [upstreamId, setUpstreamId] = useState("");

  return (
    <section className={PAGE.section}>
      <h3 className={PAGE.sectionTitle}>{labels.countryRules}</h3>

      {rules.length === 0 ? (
        <p className={PAGE.note}>{labels.noCountryRules}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow head>
              <TableHead>{labels.colCountry}</TableHead>
              <TableHead>{labels.colUpstream}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.countryCode}>
                <TableCell mono>{rule.countryCode}</TableCell>
                <TableCell>
                  {upstreams.find((upstream) => upstream.id === rule.upstreamId)?.name ?? (
                    <span className={PAGE.faint}>{labels.direct}</span>
                  )}
                </TableCell>
                <TableCell>
                  <RowActions>
                    <Button
                      variant="risk"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        ask({
                          title: interpolate(labels.confirmRemoveRuleTitle, {
                            code: rule.countryCode,
                          }),
                          // This one had no confirmation at all, and the row
                          // shows a country code next to an upstream name —
                          // neither of which says where that country's traffic
                          // goes once the rule is gone.
                          consequence: interpolate(labels.confirmRemoveRule, {
                            code: rule.countryCode,
                            upstream: upstreamName(upstreams, rule.upstreamId, labels),
                          }),
                          confirmLabel: labels.remove,
                          run: () =>
                            void call(`/v1/proxy/country-rules/${rule.countryCode}`, {
                              method: "DELETE",
                            }),
                        })
                      }
                    >
                      {labels.remove}
                    </Button>
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <InlineForm
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
        <Field label={labels.colCountry}>
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="HK"
            maxLength={2}
            pattern="[A-Za-z]{2}"
            spellCheck={false}
            required
          />
        </Field>
        <Field inline label={labels.colUpstream}>
          <Select value={upstreamId} onChange={(event) => setUpstreamId(event.target.value)}>
            <option value="">{labels.direct}</option>
            {upstreams.map((upstream) => (
              <option key={upstream.id} value={upstream.id}>
                {upstream.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={busy || code.length !== 2}>
          {labels.add}
        </Button>
      </InlineForm>
    </section>
  );
}
