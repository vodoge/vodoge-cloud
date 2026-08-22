import { bearerHeader } from "./session.ts";
import { gatewayBaseUrl } from "./tenant.ts";

/** The gateway refused the session rather than having nothing to show. */
export class UnauthorizedError extends Error {}

export type DeviceRow = {
  id: string;
  name: string;
  state: string;
  lastSeen: number | null;
};

export type MessageRow = {
  id: string;
  deviceId: string;
  direction: string;
  peer: string;
  body: string;
  bearer: string;
  receivedAt: number;
  seq: number;
};

export type SessionRow = {
  peer: string;
  count: number;
  lastBody: string;
  lastReceivedAt: number;
  deviceId: string;
};

export type ModemRow = {
  id: string;
  deviceId: string;
  imei: string;
  family: string;
  iccid: string | null;
  state: string | null;
  registration: string | null;
  signalDbm: number | null;
  homePlmn: string | null;
  servingPlmn: string | null;
  smsMo: string | null;
  smsMt: string | null;
  lastSeen: number | null;
};

export async function fetchModems(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ModemRow[]> {
  const body = await getCatalog(host, "/v1/modems", token, fetchImpl);
  return arrayOf(body.modems).map(parseModem).filter((row): row is ModemRow => row !== null);
}

export function parseModem(value: unknown): ModemRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = asString(row.id);
  const imei = asString(row.imei);
  if (!id || !imei) return null;
  return {
    id,
    imei,
    deviceId: asString(row.device_id) ?? "",
    family: asString(row.family) ?? "",
    iccid: asString(row.iccid),
    state: asString(row.state),
    registration: asString(row.registration),
    signalDbm: asNumber(row.signal_dbm),
    homePlmn: asString(row.home_plmn),
    servingPlmn: asString(row.serving_plmn),
    smsMo: asString(row.sms_mo),
    smsMt: asString(row.sms_mt),
    lastSeen: asNumber(row.last_seen),
  };
}

export type SettingsBySection = Record<string, Record<string, unknown>>;

/**
 * Every settings section, with secrets already replaced by a placeholder — the
 * console is never given a real credential.
 */
export async function fetchSettings(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SettingsBySection> {
  const body = await getCatalog(host, "/v1/settings", token, fetchImpl);
  const raw = body.settings;
  if (!raw || typeof raw !== "object") return {};
  const out: SettingsBySection = {};
  for (const [section, document] of Object.entries(raw as Record<string, unknown>)) {
    if (document && typeof document === "object") {
      out[section] = document as Record<string, unknown>;
    }
  }
  return out;
}

export type UpstreamRow = {
  id: string;
  name: string;
  address: string;
  protocol: string;
  username: string;
  enabled: boolean;
  hasPassword: boolean;
  lastProbe: Record<string, unknown> | null;
  lastProbeAt: number | null;
};

export type ProxyInstanceRow = {
  id: string;
  deviceId: string;
  name: string;
  modemImei: string;
  protocol: string;
  listenAddr: string;
  listenPort: number;
  authEnabled: boolean;
  username: string;
  hasPassword: boolean;
  upstreamId: string;
  enabled: boolean;
};

export type TrafficPoint = {
  instanceId: string;
  hour: number;
  bytesUp: number;
  bytesDown: number;
  connections: number;
};

export async function fetchUpstreams(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamRow[]> {
  const body = await getCatalog(host, "/v1/proxy/upstreams", token, fetchImpl);
  return arrayOf(body.upstreams).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      id: asString(row.id) ?? "",
      name: asString(row.name) ?? "",
      address: asString(row.address) ?? "",
      protocol: asString(row.protocol) ?? "socks5",
      username: asString(row.username) ?? "",
      enabled: row.enabled === true,
      hasPassword: row.has_password === true,
      lastProbe:
        row.last_probe && typeof row.last_probe === "object"
          ? (row.last_probe as Record<string, unknown>)
          : null,
      lastProbeAt: asNumber(row.last_probe_at),
    };
  });
}

export async function fetchProxyInstances(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyInstanceRow[]> {
  const body = await getCatalog(host, "/v1/proxy/instances", token, fetchImpl);
  return arrayOf(body.instances).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      id: asString(row.id) ?? "",
      deviceId: asString(row.device_id) ?? "",
      name: asString(row.name) ?? "",
      modemImei: asString(row.modem_imei) ?? "",
      protocol: asString(row.protocol) ?? "socks5",
      listenAddr: asString(row.listen_addr) ?? "",
      listenPort: asNumber(row.listen_port) ?? 0,
      authEnabled: row.auth_enabled === true,
      username: asString(row.username) ?? "",
      hasPassword: row.has_password === true,
      upstreamId: asString(row.upstream_id) ?? "",
      enabled: row.enabled === true,
    };
  });
}

export async function fetchTraffic(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<TrafficPoint[]> {
  const body = await getCatalog(host, "/v1/proxy/traffic", token, fetchImpl);
  return arrayOf(body.traffic).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      instanceId: asString(row.instance_id) ?? "",
      hour: asNumber(row.hour) ?? 0,
      bytesUp: asNumber(row.bytes_up) ?? 0,
      bytesDown: asNumber(row.bytes_down) ?? 0,
      connections: asNumber(row.connections) ?? 0,
    };
  });
}

export type CountryRuleRow = {
  countryCode: string;
  upstreamId: string;
};

export async function fetchCountryRules(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CountryRuleRow[]> {
  const body = await getCatalog(host, "/v1/proxy/country-rules", token, fetchImpl);
  return arrayOf(body.country_rules).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      countryCode: asString(row.country_code) ?? "",
      upstreamId: asString(row.upstream_id) ?? "",
    };
  });
}

export type ThreadRow = {
  peer: string;
  deviceId: string;
  messages: number;
  unsent: number;
  lastBody: string;
  lastAt: number;
  lastInbound: boolean;
};

export type ThreadMessage = {
  id: string;
  deviceId: string;
  direction: string;
  peer: string;
  body: string;
  bearer: string;
  status: string;
  receivedAt: number;
  failureReason: string | null;
};

export async function fetchThreads(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ThreadRow[]> {
  const body = await getCatalog(host, "/v1/messages/threads", token, fetchImpl);
  return arrayOf(body.threads).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      peer: asString(row.peer) ?? "",
      deviceId: asString(row.device_id) ?? "",
      messages: asNumber(row.messages) ?? 0,
      unsent: asNumber(row.unsent) ?? 0,
      lastBody: asString(row.last_body) ?? "",
      lastAt: asNumber(row.last_at) ?? 0,
      lastInbound: row.last_inbound === true,
    };
  });
}

export async function fetchThread(
  host: string,
  token: string | undefined,
  peer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ThreadMessage[]> {
  const body = await getCatalog(
    host,
    `/v1/messages/thread?peer=${encodeURIComponent(peer)}`,
    token,
    fetchImpl,
  );
  return arrayOf(body.messages).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      id: asString(row.id) ?? "",
      deviceId: asString(row.device_id) ?? "",
      direction: asString(row.direction) ?? "",
      peer: asString(row.peer) ?? "",
      body: asString(row.body) ?? "",
      bearer: asString(row.bearer) ?? "",
      status: asString(row.status) ?? "",
      receivedAt: asNumber(row.received_at) ?? 0,
      failureReason: asString(row.failure_reason),
    };
  });
}

export type RuleRow = { id: string; name: string; enabled: boolean };
export type AuditRow = { actor: string; action: string; target: string };

/**
 * Rules and audit went through their own hand-rolled fetch, which meant they
 * carried no session and read a rejection as an empty list. Both now go through
 * the same client as everything else so neither can drift again.
 */
export async function fetchRules(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<RuleRow[]> {
  const body = await getCatalog(host, "/v1/rules", token, fetchImpl);
  return arrayOf(body.rules).filter(isRule);
}

export async function fetchAudit(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<AuditRow[]> {
  const body = await getCatalog(host, "/v1/audit", token, fetchImpl);
  return arrayOf(body.events).filter(isAuditEvent);
}

function isRule(value: unknown): value is RuleRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.name === "string";
}

function isAuditEvent(value: unknown): value is AuditRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.action === "string";
}

export async function fetchDevices(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceRow[]> {
  const body = await getCatalog(host, "/v1/devices", token, fetchImpl);
  return arrayOf(body.devices).map(parseDevice).filter((row): row is DeviceRow => row !== null);
}

export async function fetchMessages(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<MessageRow[]> {
  const body = await getCatalog(host, "/v1/messages", token, fetchImpl);
  return arrayOf(body.messages).map(parseMessage).filter((row): row is MessageRow => row !== null);
}

export async function fetchSessions(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionRow[]> {
  const body = await getCatalog(host, "/v1/sessions", token, fetchImpl);
  return arrayOf(body.sessions).map(parseSession).filter((row): row is SessionRow => row !== null);
}

async function getCatalog(
  host: string,
  path: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const url = `${gatewayBaseUrl()}${path}`;
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      // The gateway takes the tenant from the session and only cross-checks
      // this host, so the header alone no longer opens anything.
      "x-forwarded-host": host,
      ...bearerHeader(token),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(2500),
  });
  // 404 here is not "no data": these endpoints answer 200 with an empty list
  // when a tenant has nothing. It means the gateway could not resolve the host
  // to a tenant at all, and rendering that as an empty console hides a
  // misconfiguration behind a page that looks like it worked.
  if (response.status === 404) {
    throw new UnauthorizedError(`catalog ${path} could not resolve the tenant`);
  }
  // 401 and 403 are the session having expired or not belonging here. They are
  // not "no data": treating them as empty would show a signed-out operator a
  // convincing but wrong empty console.
  if (response.status === 401 || response.status === 403) {
    throw new UnauthorizedError(`catalog ${path} rejected the session`);
  }
  if (!response.ok) {
    throw new Error(`catalog ${path} failed: ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") {
    return {};
  }
  return body as Record<string, unknown>;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseDevice(value: unknown): DeviceRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const name = asString(record.name);
  const state = asString(record.state) ?? "unknown";
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    state,
    lastSeen: asNumber(record.last_seen),
  };
}

export function parseMessage(value: unknown): MessageRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const deviceId = asString(record.device_id);
  const direction = asString(record.direction);
  const peer = asString(record.peer);
  const body = typeof record.body === "string" ? record.body : null;
  const bearer = asString(record.bearer);
  const receivedAt = asNumber(record.received_at);
  const seq = asNumber(record.seq);
  if (!id || !deviceId || !direction || !peer || body == null || !bearer || receivedAt == null || seq == null) {
    return null;
  }
  return { id, deviceId, direction, peer, body, bearer, receivedAt, seq };
}

export function parseSession(value: unknown): SessionRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const peer = asString(record.peer);
  const lastBody = typeof record.last_body === "string" ? record.last_body : null;
  const deviceId = asString(record.device_id);
  const count = asNumber(record.count);
  const lastReceivedAt = asNumber(record.last_received_at);
  if (!peer || lastBody == null || !deviceId || count == null || lastReceivedAt == null) {
    return null;
  }
  return { peer, count, lastBody, lastReceivedAt, deviceId };
}
