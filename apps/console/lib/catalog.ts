import { bearerHeader } from "./session.ts";
import { gatewayBaseUrl } from "./tenant.ts";

/** The gateway refused the session rather than having nothing to show. */
export class UnauthorizedError extends Error {}

export type DeviceRow = {
  id: string;
  name: string;
  state: string;
  lastSeen: number | null;
  edgeVersion: string | null;
  matrixVersion: string | null;
  queueRecords: number | null;
  queueBytes: number | null;
  resumedAt: number | null;
  publicIp: string | null;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  hostReportedAt: number | null;
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
  rsrp: number | null;
  rsrq: number | null;
  sinr: number | null;
  discovery: string | null;
  /** null when the reporting agent predates the second enumeration. */
  manageable: boolean | null;
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
    rsrp: asNumber(row.rsrp),
    rsrq: asNumber(row.rsrq),
    sinr: asNumber(row.sinr),
    discovery: asString(row.discovery),
    manageable: asBoolean(row.manageable),
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
  /** The contact's name, or empty when the number has none. */
  name: string;
  deviceId: string;
  messages: number;
  unsent: number;
  unread: number;
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
  encoding: string;
  /**
   * queued, sent, delivered, undelivered or failed for an outbound message;
   * received for one that arrived.
   *
   * `sent` and `delivered` are separate answers to separate questions: the
   * modem took it, and the network handed it over. The second arrives later
   * and may never arrive at all.
   */
  status: string;
  receivedAt: number;
  /** When the network says it handed the message over, not when we heard. */
  deliveredAt: number | null;
  readAt: number | null;
  failureReason: string | null;
};

export type ContactRow = {
  peer: string;
  name: string;
  note: string;
  updatedAt: number;
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
      name: asString(row.name) ?? "",
      deviceId: asString(row.device_id) ?? "",
      messages: asNumber(row.messages) ?? 0,
      unsent: asNumber(row.unsent) ?? 0,
      unread: asNumber(row.unread) ?? 0,
      lastBody: asString(row.last_body) ?? "",
      lastAt: asNumber(row.last_at) ?? 0,
      lastInbound: row.last_inbound === true,
    };
  });
}

export async function fetchContacts(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ContactRow[]> {
  const body = await getCatalog(host, "/v1/messages/contacts", token, fetchImpl);
  return arrayOf(body.contacts).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      peer: asString(row.peer) ?? "",
      name: asString(row.name) ?? "",
      note: asString(row.note) ?? "",
      updatedAt: asNumber(row.updated_at) ?? 0,
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
      encoding: asString(row.encoding) ?? "unknown",
      status: asString(row.status) ?? "",
      receivedAt: asNumber(row.received_at) ?? 0,
      deliveredAt: asNumber(row.delivered_at),
      readAt: asNumber(row.read_at),
      failureReason: asString(row.failure_reason),
    };
  });
}

export type CardPolicyRow = {
  iccid: string;
  cellularEnabled: boolean;
  vertical: string;
  apn: string | null;
  note: string;
  updatedAt: number;
};

export async function fetchCardPolicies(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CardPolicyRow[]> {
  const body = await getCatalog(host, "/v1/cards/policies", token, fetchImpl);
  return arrayOf(body.policies).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      iccid: asString(row.iccid) ?? "",
      cellularEnabled: row.cellular_enabled === true,
      vertical: asString(row.vertical) ?? "cn",
      apn: asString(row.apn),
      note: asString(row.note) ?? "",
      updatedAt: asNumber(row.updated_at) ?? 0,
    };
  });
}

export type JournalEvent = {
  seq: number;
  deviceId: string;
  kind: string;
  receivedAt: number;
  payload: unknown;
};

export async function fetchJournal(
  host: string,
  token: string | undefined,
  options: { kind?: string; deviceId?: string; limit?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<JournalEvent[]> {
  const query = new URLSearchParams();
  if (options.kind) query.set("kind", options.kind);
  if (options.deviceId) query.set("device_id", options.deviceId);
  query.set("limit", String(options.limit ?? 100));
  const body = await getCatalog(host, `/v1/journal?${query}`, token, fetchImpl);
  return arrayOf(body.events).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      seq: asNumber(row.seq) ?? 0,
      deviceId: asString(row.device_id) ?? "",
      kind: asString(row.kind) ?? "",
      receivedAt: asNumber(row.received_at) ?? 0,
      payload: row.payload,
    };
  });
}

export type EsimProfileRow = {
  eid: string;
  iccid: string;
  state: string;
  nickname: string | null;
  modemImei: string | null;
  collectedAt: number;
};

export async function fetchEsimProfiles(
  host: string,
  token: string | undefined,
  deviceId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EsimProfileRow[]> {
  const path = deviceId
    ? `/v1/esim/profiles?device_id=${encodeURIComponent(deviceId)}`
    : "/v1/esim/profiles";
  const body = await getCatalog(host, path, token, fetchImpl);
  return arrayOf(body.profiles).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      eid: asString(row.eid) ?? "",
      iccid: asString(row.iccid) ?? "",
      state: asString(row.state) ?? "unknown",
      nickname: asString(row.nickname),
      modemImei: asString(row.modem_imei),
      collectedAt: asNumber(row.collected_at) ?? 0,
    };
  });
}

export type ScheduleRow = {
  id: string;
  name: string;
  enabled: boolean;
  action: string;
  commandKind: string | null;
  /** How the target is chosen, rendered verbatim: an ICCID is the answer. */
  selector: { mode: string; deviceId: string | null; iccid: string | null; modemImei: string | null };
  intervalSeconds: number;
  nextDueAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastCommandId: string | null;
  /**
   * The run's own record, kept as text rather than parsed into fields.
   *
   * What it holds differs per outcome -- an address for a public IP check, a
   * reason for a preparation failure, how many occurrences a skip covered --
   * and a page that only rendered the keys it knew about would silently drop
   * the one that explains an unfamiliar failure.
   */
  lastDetail: string | null;
};

export async function fetchSchedules(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ScheduleRow[]> {
  const body = await getCatalog(host, "/v1/schedules", token, fetchImpl);
  return arrayOf(body.schedules)
    .map(parseSchedule)
    .filter((row): row is ScheduleRow => row !== null);
}

export function parseSchedule(value: unknown): ScheduleRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const name = asString(record.name);
  if (!id || !name) {
    return null;
  }
  const selector = (record.selector ?? {}) as Record<string, unknown>;
  const detail = record.last_detail;
  return {
    id,
    name,
    enabled: record.enabled === true,
    action: asString(record.action) ?? "command",
    commandKind: asString(record.command_kind),
    selector: {
      mode: asString(selector.mode) ?? "unknown",
      deviceId: asString(selector.device_id),
      iccid: asString(selector.iccid),
      modemImei: asString(selector.modem_imei),
    },
    intervalSeconds: asNumber(record.interval_seconds) ?? 0,
    nextDueAt: asNumber(record.next_due_at),
    lastRunAt: asNumber(record.last_run_at),
    lastStatus: asString(record.last_status),
    lastCommandId: asString(record.last_command_id),
    lastDetail:
      detail && typeof detail === "object" && Object.keys(detail).length > 0
        ? JSON.stringify(detail)
        : null,
  };
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

/**
 * Tri-state on purpose. `manageable` absent means the agent that wrote the
 * row predates the second enumeration and has no opinion, which is not the
 * same as it saying the module cannot be driven.
 */
function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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
    edgeVersion: asString(record.edge_version),
    matrixVersion: asString(record.matrix_version),
    queueRecords: asNumber(record.queue_records),
    queueBytes: asNumber(record.queue_bytes),
    resumedAt: asNumber(record.resumed_at),
    publicIp: asString(record.public_ip),
    cpuPercent: asNumber(record.cpu_percent),
    memoryUsedBytes: asNumber(record.memory_used_bytes),
    memoryTotalBytes: asNumber(record.memory_total_bytes),
    hostReportedAt: asNumber(record.host_reported_at),
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

/**
 * What `GetEUICCInfo2` said about a chip, as the edge decoded it.
 *
 * Every field is optional because the card decides which ones it sends, and
 * `decodedFields` is carried alongside so a short read is visible as a number
 * rather than as fields that quietly went missing.
 */
export type EsimChipInfo = {
  profileVersion: string | null;
  sgp22Version: string | null;
  firmwareVersion: string | null;
  installedApplications: number | null;
  freeNonVolatileMemory: number | null;
  freeVolatileMemory: number | null;
  uiccCapabilities: string[];
  ts102241Version: string | null;
  globalPlatformVersion: string | null;
  rspCapabilities: string[];
  ciKeyIdsForVerification: string[];
  ciKeyIdsForSigning: string[];
  category: number | null;
  forbiddenProfilePolicyRules: string[];
  ppVersion: string | null;
  sasAccreditationNumber: string | null;
  decodedFields: number;
};

/** One notification the eUICC has not managed to hand to its SM-DP+. */
export type EsimNotificationRow = {
  sequenceNumber: number;
  operations: string[];
  address: string;
  iccid: string | null;
};

/** The result of one `read_esim_info` command. */
export type EsimInfoResult = {
  imei: string;
  eid: string;
  chip: EsimChipInfo;
  notifications: EsimNotificationRow[];
  notificationsError: string | null;
  profilesError: string | null;
};

/** One GSMA CI root the edge had loaded when it ran the exchange. */
export type EsimTrustAnchor = {
  label: string;
  keyId: string;
  sha256: string;
  /** ASN.1 `notAfter`, so a rotation is a date rather than a surprise. */
  notAfter: string;
};

/**
 * The result of one `initiate_esim_authentication` command.
 *
 * Every check is a separate field rather than one `verified` flag. Three
 * different things were established -- the CI signed the certificate, the
 * certificate signed the answer, and the answer is about this chip's
 * challenge -- and a single boolean would make any one failing read as all
 * three failing, which is the opposite of what someone reading this page
 * needs.
 */
export type EsimAuthentication = {
  imei: string;
  eid: string;
  smdpAddress: string;
  smdpAddressSource: string;
  configuredDefaultSmdp: string | null;
  configuredRootSmds: string | null;
  notificationAddresses: string[];
  euiccChallenge: string;
  transactionId: string;
  serverAddress: string;
  serverChallenge: string;
  echoedEuiccChallenge: string;
  euiccCiPkidToBeUsed: string;
  chipCiKeyIds: string[];
  ciKeyAcceptedByChip: boolean;
  certificateKeyId: string;
  certificateAuthorityKeyId: string;
  certificateSha256: string;
  certificateNotAfter: string;
  certificateSignedByCi: boolean;
  serverSignatureValid: boolean;
  challengeEchoed: boolean;
  trustAnchorLabel: string;
  trustAnchorKeyId: string;
  trustDirectory: string;
  trustAnchors: EsimTrustAnchor[];
  negotiatedTls: string | null;
  adminProtocol: string | null;
  httpStatus: number;
  elapsedMs: number;
  /** False, and rendered as such rather than left to be assumed. */
  profileDownloaded: boolean;
  stoppedAfter: string | null;
};

/** The result of one `retrieve_esim_notification` command. */
export type RetrievedNotification = {
  imei: string;
  sequenceNumber: number;
  operations: string[];
  address: string;
  iccid: string | null;
  installationResult: boolean;
  payloadBytes: number;
  /** False until ES9+ exists. Rendered, not assumed. */
  delivered: boolean;
  deliveryBlockedBy: string | null;
};

/**
 * Read one chip's answer out of a command result.
 *
 * Returns null rather than a half-filled object when the EID is missing: an
 * eUICC reading with no EID identifies nothing, and rendering it under an
 * empty heading is worse than not rendering it.
 */
export function parseEsimInfoResult(value: unknown): EsimInfoResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const eid = asString(row.eid);
  const imei = asString(row.imei);
  if (!eid || !imei) {
    return null;
  }
  const chip = (row.chip ?? {}) as Record<string, unknown>;
  return {
    imei,
    eid,
    chip: {
      profileVersion: asString(chip.profile_version),
      sgp22Version: asString(chip.sgp22_version),
      firmwareVersion: asString(chip.firmware_version),
      installedApplications: asNumber(chip.installed_applications),
      freeNonVolatileMemory: asNumber(chip.free_non_volatile_memory),
      freeVolatileMemory: asNumber(chip.free_volatile_memory),
      uiccCapabilities: stringsOf(chip.uicc_capabilities),
      ts102241Version: asString(chip.ts102241_version),
      globalPlatformVersion: asString(chip.global_platform_version),
      rspCapabilities: stringsOf(chip.rsp_capabilities),
      ciKeyIdsForVerification: stringsOf(chip.ci_key_ids_for_verification),
      ciKeyIdsForSigning: stringsOf(chip.ci_key_ids_for_signing),
      category: asNumber(chip.category),
      forbiddenProfilePolicyRules: stringsOf(chip.forbidden_profile_policy_rules),
      ppVersion: asString(chip.pp_version),
      sasAccreditationNumber: asString(chip.sas_accreditation_number),
      decodedFields: asNumber(chip.decoded_fields) ?? 0,
    },
    notifications: arrayOf(row.notifications)
      .map(parseEsimNotification)
      .filter((entry): entry is EsimNotificationRow => entry !== null),
    notificationsError: asString(row.notifications_error),
    profilesError: asString(row.profiles_error),
  };
}

function parseEsimNotification(value: unknown): EsimNotificationRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const sequenceNumber = asNumber(row.sequence_number);
  const address = asString(row.address);
  // Zero is a real sequence number, so the check is for absence rather than
  // for falsiness.
  if (sequenceNumber === null || !address) {
    return null;
  }
  return {
    sequenceNumber,
    operations: stringsOf(row.operations),
    address,
    iccid: asString(row.iccid),
  };
}

export function parseRetrievedNotification(value: unknown): RetrievedNotification | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const sequenceNumber = asNumber(row.sequence_number);
  const imei = asString(row.imei);
  if (sequenceNumber === null || !imei) {
    return null;
  }
  return {
    imei,
    sequenceNumber,
    operations: stringsOf(row.operations),
    address: asString(row.address) ?? "",
    iccid: asString(row.iccid),
    installationResult: row.installation_result === true,
    payloadBytes: asNumber(row.payload_bytes) ?? 0,
    delivered: row.delivered === true,
    deliveryBlockedBy: asString(row.delivery_blocked_by),
  };
}

/**
 * Read one ES9+ exchange out of a command result.
 *
 * Null unless the server actually named a transaction. A page that rendered
 * an authentication panel with an empty transaction id would be showing that
 * something happened when what happened is that nothing did.
 */
export function parseEsimAuthentication(value: unknown): EsimAuthentication | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const transactionId = asString(row.transaction_id);
  const imei = asString(row.imei);
  const smdpAddress = asString(row.smdp_address);
  if (!transactionId || !imei || !smdpAddress) {
    return null;
  }
  return {
    imei,
    eid: asString(row.eid) ?? "",
    smdpAddress,
    smdpAddressSource: asString(row.smdp_address_source) ?? "",
    configuredDefaultSmdp: asString(row.configured_default_smdp),
    configuredRootSmds: asString(row.configured_root_smds),
    notificationAddresses: stringsOf(row.notification_addresses),
    euiccChallenge: asString(row.euicc_challenge) ?? "",
    transactionId,
    serverAddress: asString(row.server_address) ?? "",
    serverChallenge: asString(row.server_challenge) ?? "",
    echoedEuiccChallenge: asString(row.echoed_euicc_challenge) ?? "",
    euiccCiPkidToBeUsed: asString(row.euicc_ci_pkid_to_be_used) ?? "",
    chipCiKeyIds: stringsOf(row.chip_ci_key_ids),
    // Compared against `true` rather than coerced: an absent field is not a
    // passed check, and this is the difference between a page that says a
    // signature verified and one that says an old edge did not report it.
    ciKeyAcceptedByChip: row.ci_key_accepted_by_chip === true,
    certificateKeyId: asString(row.certificate_key_id) ?? "",
    certificateAuthorityKeyId: asString(row.certificate_authority_key_id) ?? "",
    certificateSha256: asString(row.certificate_sha256) ?? "",
    certificateNotAfter: asString(row.certificate_not_after) ?? "",
    certificateSignedByCi: row.certificate_signed_by_ci === true,
    serverSignatureValid: row.server_signature_valid === true,
    challengeEchoed: row.challenge_echoed === true,
    trustAnchorLabel: asString(row.trust_anchor_label) ?? "",
    trustAnchorKeyId: asString(row.trust_anchor_key_id) ?? "",
    trustDirectory: asString(row.trust_directory) ?? "",
    trustAnchors: arrayOf(row.trust_anchors)
      .map(parseTrustAnchor)
      .filter((entry): entry is EsimTrustAnchor => entry !== null),
    negotiatedTls: asString(row.negotiated_tls),
    adminProtocol: asString(row.admin_protocol),
    httpStatus: asNumber(row.http_status) ?? 0,
    elapsedMs: asNumber(row.elapsed_ms) ?? 0,
    profileDownloaded: row.profile_downloaded === true,
    stoppedAfter: asString(row.stopped_after),
  };
}

function parseTrustAnchor(value: unknown): EsimTrustAnchor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const label = asString(row.label);
  const keyId = asString(row.key_id);
  if (!label || !keyId) {
    return null;
  }
  return {
    label,
    keyId,
    sha256: asString(row.sha256) ?? "",
    notAfter: asString(row.not_after) ?? "",
  };
}


/** One profile as the eUICC listed it during a download. */
export type EsimDownloadedProfile = {
  iccid: string;
  label: string;
  enabled: boolean;
  provider: string | null;
  name: string | null;
};

/** What the chip held at one moment, before or after a download. */
export type EsimDownloadSnapshot = {
  freeNonVolatileMemory: number | null;
  profiles: EsimDownloadedProfile[];
  notifications: EsimNotificationRow[];
};

/** One piece of a Bound Profile Package, and the blocks it took to send. */
export type EsimBppSegment = {
  label: string;
  bytes: number;
  blocks: number;
};

/**
 * The result of one `download_esim_profile` command.
 *
 * Two snapshots rather than one verdict. "Downloaded" is a claim the command
 * makes about itself; a second profile in the list, free memory that dropped
 * by about the size of the package, and one fewer notification owed to the
 * SM-DP+ are three facts that came off the chip, and they are what the page
 * shows. Neither the activation code nor the matching id is here: they are
 * one-time credentials and this object is stored.
 */
export type EsimDownload = {
  imei: string;
  eid: string;
  smdpAddress: string;
  transactionId: string;
  matchingIdSupplied: boolean;
  /** What the SM-DP+ said the profile is, read before anything was written. */
  profileName: string | null;
  serviceProviderName: string | null;
  profileIccid: string | null;
  /** Every policy rule the SM-DP+ attached, named. */
  policyRules: string[];
  /**
   * The rules that stopped the download. `ppr1` forbids ever disabling the
   * profile and `ppr2` forbids ever deleting it, and both are permanent from
   * the moment it is installed.
   */
  refusedPolicyRules: string[];
  before: EsimDownloadSnapshot;
  after: EsimDownloadSnapshot | null;
  freeMemoryConsumed: number | null;
  profilesAdded: number | null;
  authenticateServerBlocks: number;
  prepareDownloadBlocks: number;
  boundProfilePackageBytes: number;
  boundProfilePackageBlocks: number;
  boundProfilePackageSegments: EsimBppSegment[];
  installed: boolean;
  /** Always false. Installing and enabling are two operations, and only one
   * of them happened. */
  enabled: boolean;
  installationIccid: string | null;
  installationError: string | null;
  failedBppCommand: string | null;
  notificationSequenceNumber: number | null;
  notificationDelivered: boolean;
  notificationDeliveryError: string | null;
  notificationRemovedCode: number | null;
  notificationsPendingBefore: number;
  notificationsPendingAfter: number | null;
  sessionCancelled: string | null;
  cancelError: string | null;
  stoppedAfter: string | null;
  certificateSignedByCi: boolean;
  serverSignatureValid: boolean;
  challengeEchoed: boolean;
  ciKeyAcceptedByChip: boolean;
  negotiatedTls: string | null;
  trustAnchorKeyId: string;
};

function parseDownloadedProfile(value: unknown): EsimDownloadedProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const iccid = asString(row.iccid);
  if (!iccid) {
    return null;
  }
  return {
    iccid,
    label: asString(row.label) ?? iccid,
    enabled: row.enabled === true,
    provider: asString(row.provider),
    name: asString(row.name),
  };
}

function parseDownloadSnapshot(value: unknown): EsimDownloadSnapshot {
  const row = (value ?? {}) as Record<string, unknown>;
  return {
    freeNonVolatileMemory: asNumber(row.free_non_volatile_memory),
    profiles: arrayOf(row.profiles)
      .map(parseDownloadedProfile)
      .filter((entry): entry is EsimDownloadedProfile => entry !== null),
    notifications: arrayOf(row.notifications)
      .map(parseEsimNotification)
      .filter((entry): entry is EsimNotificationRow => entry !== null),
  };
}

function parseBppSegment(value: unknown): EsimBppSegment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const label = asString(row.label);
  if (!label) {
    return null;
  }
  return {
    label,
    bytes: asNumber(row.bytes) ?? 0,
    blocks: asNumber(row.blocks) ?? 0,
  };
}

/**
 * Read one download out of a command result.
 *
 * Null unless the exchange got as far as a transaction. A download panel with
 * an empty transaction id would be reporting that something happened when what
 * happened is that nothing did.
 */
export function parseEsimDownload(value: unknown): EsimDownload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const imei = asString(row.imei);
  const eid = asString(row.eid);
  const transactionId = asString(row.transaction_id);
  if (!imei || !eid || !transactionId) {
    return null;
  }
  const profile = (row.profile ?? {}) as Record<string, unknown>;
  return {
    imei,
    eid,
    smdpAddress: asString(row.smdp_address) ?? "",
    transactionId,
    matchingIdSupplied: row.matching_id_supplied === true,
    profileName: asString(profile.profile_name),
    serviceProviderName: asString(profile.service_provider_name),
    profileIccid: asString(profile.iccid),
    policyRules: stringsOf(profile.policy_rules),
    refusedPolicyRules: stringsOf(row.refused_policy_rules),
    before: parseDownloadSnapshot(row.before),
    after: row.after ? parseDownloadSnapshot(row.after) : null,
    freeMemoryConsumed: asNumber(row.free_memory_consumed),
    profilesAdded: asNumber(row.profiles_added),
    authenticateServerBlocks: asNumber(row.authenticate_server_blocks) ?? 0,
    prepareDownloadBlocks: asNumber(row.prepare_download_blocks) ?? 0,
    boundProfilePackageBytes: asNumber(row.bound_profile_package_bytes) ?? 0,
    boundProfilePackageBlocks: asNumber(row.bound_profile_package_blocks) ?? 0,
    boundProfilePackageSegments: arrayOf(row.bound_profile_package_segments)
      .map(parseBppSegment)
      .filter((entry): entry is EsimBppSegment => entry !== null),
    // Compared against `true` rather than coerced: an absent field is not a
    // successful install, and the difference matters on the one command here
    // that cannot be undone.
    installed: row.installed === true,
    enabled: row.enabled === true,
    installationIccid: asString(row.installation_iccid),
    installationError: asString(row.installation_error),
    failedBppCommand: asString(row.failed_bpp_command),
    notificationSequenceNumber: asNumber(row.notification_sequence_number),
    notificationDelivered: row.notification_delivered === true,
    notificationDeliveryError: asString(row.notification_delivery_error),
    notificationRemovedCode: asNumber(row.notification_removed_code),
    notificationsPendingBefore: asNumber(row.notifications_pending_before) ?? 0,
    notificationsPendingAfter: asNumber(row.notifications_pending_after),
    sessionCancelled: asString(row.session_cancelled),
    cancelError: asString(row.cancel_error),
    stoppedAfter: asString(row.stopped_after),
    certificateSignedByCi: row.certificate_signed_by_ci === true,
    serverSignatureValid: row.server_signature_valid === true,
    challengeEchoed: row.challenge_echoed === true,
    ciKeyAcceptedByChip: row.ci_key_accepted_by_chip === true,
    negotiatedTls: asString(row.negotiated_tls),
    trustAnchorKeyId: asString(row.trust_anchor_key_id) ?? "",
  };
}

function stringsOf(value: unknown): string[] {
  return arrayOf(value).filter((entry): entry is string => typeof entry === "string");
}
