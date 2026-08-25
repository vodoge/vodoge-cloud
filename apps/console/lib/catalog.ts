import {
  bearerHeader,
  roleFromSessionBody,
  SESSION_ENDPOINT,
  type ConsoleRole,
} from "./session.ts";
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

/**
 * The signed-in account's role, for pages that draw two versions of themselves.
 *
 * Fails closed and never throws. Every caller is a page deciding whether to
 * render a privileged control, so the two ways of being wrong are not
 * symmetric: drawing the smaller version costs a reload, and drawing the
 * larger one puts a button in front of an operator that the gateway will
 * refuse after they have clicked it. A gateway that cannot be reached is
 * therefore read-only, and so is a body that does not say otherwise.
 *
 * This is presentation only. The gateway decides for real — /v1 is reachable
 * with curl and a token whatever this returns.
 */
export async function fetchConsoleRole(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ConsoleRole> {
  try {
    const response = await fetchImpl(`${gatewayBaseUrl()}${SESSION_ENDPOINT}`, {
      headers: {
        accept: "application/json",
        "x-forwarded-host": host,
        ...bearerHeader(token),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return "readonly";
    return roleFromSessionBody(await response.json());
  } catch {
    return "readonly";
  }
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

/**
 * Where a row in the profile table came from.
 *
 * Rendered, not hidden. The two sources are not equally durable: `inventory`
 * is the `app.esim_profiles` projection, which survives a page reload and
 * remembers chips nobody has touched today, while `read` is the last
 * `read_esim_info` command's own result and lives only as long as that command
 * stays in the recent-command window. An operator who cannot tell them apart
 * will read an empty table as "the chip has no profiles" when what happened is
 * that the reading scrolled out of the window.
 */
export type EsimProfileSource = "inventory" | "read";

export type EsimProfileRow = {
  eid: string;
  iccid: string;
  state: string;
  nickname: string | null;
  modemImei: string | null;
  collectedAt: number;
  source: EsimProfileSource;
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
      source: "inventory" as const,
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

/**
 * What one load of the audit log turned out to be.
 *
 * Four outcomes, not two. `/audit` shipped with `events: AuditRow[] = []` and a
 * `loadError` flag, and that pair cannot say the thing that was actually
 * happening: the gateway answered 200 with real events, every one of them was
 * dropped by the parser, and the page drew "Nothing recorded yet" — the same
 * picture a tenant with a genuinely empty log gets. Nothing threw, so the error
 * branch never ran, and the console spent an unknown number of days telling
 * operators their audit trail was empty while the gateway held it.
 *
 * `unreadable` is the state that had nowhere to live. It is not cosmetic: an
 * empty audit log and an audit log this console cannot read call for opposite
 * responses from whoever is looking at it.
 */
export type AuditLoad =
  | { status: "ok"; events: readonly AuditRow[] }
  | { status: "empty" }
  | { status: "unreadable"; received: number }
  | { status: "failed" };

/**
 * The audit log, as one of four outcomes.
 *
 * The fetch is caught here rather than in the page so that the page has no
 * logic in it at all: `app/**.tsx` cannot be run by a test in this app, so
 * anything decided there is decided where nothing can check it.
 */
export async function loadAudit(
  host: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<AuditLoad> {
  let body: Record<string, unknown>;
  try {
    body = await getCatalog(host, "/v1/audit", token, fetchImpl);
  } catch {
    return { status: "failed" };
  }
  const received = arrayOf(body.events);
  const events = received
    .map(parseAuditEvent)
    .filter((row): row is AuditRow => row !== null);
  if (events.length > 0) return { status: "ok", events };
  // Rows arrived and none survived the parser. Reporting that as "empty" is
  // the bug this type exists to make unrepresentable.
  if (received.length > 0) return { status: "unreadable", received: received.length };
  return { status: "empty" };
}

/**
 * One audit row, in either of the two shapes the gateway has been seen to send.
 *
 * `apps/gateway/internal/audit/log.go` declares `Event` with no struct tags, so
 * `encoding/json` marshals it under the Go field names and `/v1/audit` answers
 * `{"Actor":…,"Action":…,"Target":…}`. Every sibling endpoint's struct is
 * tagged, which is why this is the only page it happened to. Reading both cases
 * is deliberate rather than a workaround: putting tags on that struct changes
 * the wire format of a shipped endpoint, and this console has to keep working
 * across the deploy where it does — before, during and after.
 */
export function parseAuditEvent(value: unknown): AuditRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const action = eitherCase(row, "action");
  if (action === null) return null;
  return {
    actor: eitherCase(row, "actor") ?? "",
    action,
    target: eitherCase(row, "target") ?? "",
  };
}

/** `actor` or `Actor`. Only the first letter differs; Go leaves the rest. */
function eitherCase(row: Record<string, unknown>, name: string): string | null {
  const goName = name.charAt(0).toUpperCase() + name.slice(1);
  return asString(row[name]) ?? asString(row[goName]);
}

/**
 * What the audit page draws, decided here rather than in the `.tsx`.
 *
 * The invariant this exists to hold: `rows` is non-empty exactly when
 * `placeholder` is null. The renderer therefore branches on `placeholder`, and
 * there is no arrangement of it that shows the empty-state copy over a failed
 * or unreadable load — which is precisely what the page used to do, printing
 * "Could not load audit events." above a card reading "Nothing recorded yet".
 */
export type AuditScreen = {
  readonly rows: readonly AuditRow[];
  /** The line above the card. Null when nothing went wrong. */
  readonly errorKey: string | null;
  /** The card's contents when there is no table to draw. */
  readonly placeholder: {
    readonly titleKey: string;
    readonly descriptionKey: string;
    readonly vars?: Record<string, number>;
  } | null;
};

export function auditScreen(load: AuditLoad): AuditScreen {
  switch (load.status) {
    case "ok":
      return { rows: load.events, errorKey: null, placeholder: null };
    case "empty":
      return {
        rows: [],
        errorKey: null,
        placeholder: {
          titleKey: "empty.audit.title",
          descriptionKey: "empty.audit.desc",
        },
      };
    case "unreadable":
      return {
        rows: [],
        errorKey: "audit.unreadableError",
        placeholder: {
          titleKey: "empty.audit.unreadableTitle",
          descriptionKey: "empty.audit.unreadableDesc",
          vars: { count: load.received },
        },
      };
    case "failed":
      return {
        rows: [],
        errorKey: "audit.loadError",
        placeholder: {
          titleKey: "empty.audit.failedTitle",
          descriptionKey: "empty.audit.failedDesc",
        },
      };
  }
}

function isRule(value: unknown): value is RuleRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.name === "string";
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

/**
 * One profile as ES10c listed it, before it becomes a table row.
 *
 * Four names for the same profile arrive from the card and all four are kept.
 * `nickname` is the only one an operator can set and the only one the
 * `app.esim_profiles` projection carries, and on both chips on the bench it is
 * null -- so a table that read only that column would show two nameless rows
 * for a card whose own answer says "WEBBING" and "Wireless".
 */
export type EsimReadProfile = {
  iccid: string;
  enabled: boolean;
  label: string | null;
  name: string | null;
  nickname: string | null;
  provider: string | null;
  /** SGP.22 profile class: 0 test, 1 provisioning, 2 operational. */
  profileClass: number | null;
  isdpAid: string | null;
};

/** The result of one `read_esim_info` command. */
export type EsimInfoResult = {
  imei: string;
  eid: string;
  chip: EsimChipInfo;
  /**
   * What the card said it holds.
   *
   * The edge has sent this array since the command existed; the console threw
   * it away until 2026-08-25, which is the whole reason the profile table was
   * empty on a bench where both chips answer with two profiles.
   */
  profiles: EsimReadProfile[];
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
    profiles: arrayOf(row.profiles)
      .map(parseEsimReadProfile)
      .filter((entry): entry is EsimReadProfile => entry !== null),
    notifications: arrayOf(row.notifications)
      .map(parseEsimNotification)
      .filter((entry): entry is EsimNotificationRow => entry !== null),
    notificationsError: asString(row.notifications_error),
    profilesError: asString(row.profiles_error),
  };
}

/**
 * One entry of the `profiles` array in a `read_esim_info` result.
 *
 * An entry with no ICCID is dropped rather than rendered blank: the ICCID is
 * what the switch command addresses, so a row without one is a row whose
 * button could only aim at nothing.
 */
function parseEsimReadProfile(value: unknown): EsimReadProfile | null {
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
    // Absent reads as disabled, and that asymmetry is deliberate: the switch
    // button only appears on a disabled row, so guessing "enabled" for a field
    // the agent did not send would hide the control instead of offering one
    // that might be redundant.
    enabled: asBoolean(row.enabled) === true,
    label: asString(row.label),
    name: asString(row.name),
    nickname: asString(row.nickname),
    provider: asString(row.provider),
    profileClass: asNumber(row.class),
    isdpAid: asString(row.isdp_aid),
  };
}

/** Enough of a relayed command for the eSIM helpers below. */
export type EsimCommandRow = {
  kind: string;
  status: string;
  completed_at: number | null;
  payload: Record<string, unknown> | null;
  result: { status?: string; reason?: string; details?: unknown } | null;
};

/** One chip reading, with the time the command it came from finished. */
export type EsimChipReading = {
  info: EsimInfoResult;
  completedAt: number | null;
};

/** The two eSIM commands that open an ISD-R channel and can fail doing it. */
const ESIM_CHIP_COMMANDS = new Set(["read_esim_info", "list_esim_profiles"]);

/**
 * The most recent successful chip reading per EID.
 *
 * Per EID rather than per IMEI on purpose: the EID is the chip, and a module
 * that was read twice should not produce two entries that disagree.
 */
export function latestEsimChipReads(rows: readonly EsimCommandRow[]): EsimChipReading[] {
  const seen = new Map<string, EsimChipReading>();
  for (const row of rows) {
    if (row.kind !== "read_esim_info" || row.status !== "succeeded") continue;
    const info = parseEsimInfoResult(row.result?.details);
    if (!info) continue;
    const existing = seen.get(info.eid);
    if (existing && (existing.completedAt ?? 0) >= (row.completed_at ?? 0)) continue;
    seen.set(info.eid, { info, completedAt: row.completed_at });
  }
  return [...seen.values()].sort((left, right) => left.info.eid.localeCompare(right.info.eid));
}

/**
 * The card's own name for a profile, in the order an operator would want it.
 *
 * Nickname first because it is the only one a human chose. Everything after it
 * is the card's, and falling through to them beats rendering a dash: on the
 * bench every nickname is null while the names are "WEBBING" and "Wireless".
 */
export function esimProfileDisplayName(profile: EsimReadProfile): string | null {
  return profile.nickname ?? profile.name ?? profile.provider ?? profile.label;
}

/**
 * What one module last said it holds, whichever command asked.
 *
 * Both `read_esim_info` and `list_esim_profiles` return the same ES10c list,
 * and the page offers a button for each. Only the first carries an EID, so a
 * listing from the second borrows the EID from the newest reading of the same
 * module -- and is dropped when there is none, because a profile that cannot
 * be filed under a chip is a row with no heading. Borrowing it assumes the
 * card in a module did not change between the two commands, which on a bench
 * where nobody can reach the hardware is safe, and the borrowed listing only
 * ever wins when it is the newer of the two.
 */
export type EsimProfileListing = {
  modemImei: string;
  eid: string | null;
  profiles: EsimReadProfile[];
  /**
   * Kept because an empty list means two different things.
   *
   * A card with no profiles and a card that refused the query both answer with
   * nothing, and the edge is careful to say which happened. Dropping this
   * would turn a refusal into "this chip is empty".
   */
  profilesError: string | null;
  collectedAt: number;
};

export function latestEsimProfileListings(
  rows: readonly EsimCommandRow[],
): EsimProfileListing[] {
  const eidByImei = new Map<string, string>();
  for (const { info } of latestEsimChipReads(rows)) {
    eidByImei.set(info.imei, info.eid);
  }
  const byImei = new Map<string, EsimProfileListing>();
  for (const row of rows) {
    if (row.status !== "succeeded" || !ESIM_CHIP_COMMANDS.has(row.kind)) continue;
    const details = row.result?.details;
    if (!details || typeof details !== "object") continue;
    const body = details as Record<string, unknown>;
    const modemImei = asString(body.imei) ?? asString((row.payload ?? {}).modem_imei);
    if (!modemImei) continue;
    const at = row.completed_at ?? 0;
    const existing = byImei.get(modemImei);
    if (existing && existing.collectedAt >= at) continue;
    byImei.set(modemImei, {
      modemImei,
      eid: asString(body.eid) ?? eidByImei.get(modemImei) ?? null,
      profiles: arrayOf(body.profiles)
        .map(parseEsimReadProfile)
        .filter((entry): entry is EsimReadProfile => entry !== null),
      profilesError: asString(body.profiles_error),
      collectedAt: at,
    });
  }
  return [...byImei.values()].sort((left, right) =>
    left.modemImei.localeCompare(right.modemImei),
  );
}

/**
 * The profile table, rebuilt from the last listing each module produced.
 *
 * This exists because `app.esim_profiles` has never had a row in it: nothing
 * on the edge emits the `EsimInventory` envelope the projection is fed by. The
 * profile list itself, though, has been travelling in every `read_esim_info`
 * result since that command shipped, and the console was dropping it on the
 * floor. Reading it here needs no contract change, no edge change and no
 * second writer on any projection -- the data is already in the command log.
 *
 * `collectedAt` is the command's completion time rather than a timestamp from
 * the card, because the card does not send one. That is the honest reading:
 * it says when we asked, which is the most anyone can claim.
 */
export function esimProfileRowsFromReads(rows: readonly EsimCommandRow[]): EsimProfileRow[] {
  const out: EsimProfileRow[] = [];
  for (const listing of latestEsimProfileListings(rows)) {
    if (!listing.eid) continue;
    for (const profile of listing.profiles) {
      out.push({
        eid: listing.eid,
        iccid: profile.iccid,
        // ES10c answers with a boolean, so "deleted" is a state this path can
        // never produce. A profile that is gone from the card is simply absent
        // from the list, and inventing a third value from a two-valued field
        // would be the console making something up.
        state: profile.enabled ? "enabled" : "disabled",
        nickname: esimProfileDisplayName(profile),
        modemImei: listing.modemImei,
        collectedAt: listing.collectedAt,
        source: "read",
      });
    }
  }
  return out;
}

/** enabled first, then disabled, then whatever is no longer on the chip. */
function esimStateRank(state: string): number {
  if (state === "enabled") return 0;
  if (state === "disabled") return 1;
  if (state === "deleted") return 2;
  return 3;
}

/**
 * The durable inventory and the last reading, as one table.
 *
 * Same chip and same ICCID means same row, and the newer collection wins.
 * Neither source is dropped wholesale: the projection remembers profiles that
 * have since been deleted, which is exactly what someone needs when a card
 * stops working after a switch, and the reading is the only thing that knows
 * what is on the chip right now.
 *
 * A tie goes to the reading, because it carries the modem IMEI the switch
 * command has to be addressed to and a projection row without one renders a
 * profile nobody can act on.
 */
export function mergeEsimProfiles(
  inventory: readonly EsimProfileRow[],
  fromReads: readonly EsimProfileRow[],
): EsimProfileRow[] {
  const byKey = new Map<string, EsimProfileRow>();
  for (const row of [...inventory, ...fromReads]) {
    if (!row.eid || !row.iccid) continue;
    const key = `${row.eid}/${row.iccid}`;
    const existing = byKey.get(key);
    if (existing && existing.collectedAt > row.collectedAt) continue;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.eid.localeCompare(right.eid) ||
      esimStateRank(left.state) - esimStateRank(right.state) ||
      left.iccid.localeCompare(right.iccid),
  );
}

/**
 * Why a chip read failed, in the only two flavours that matter to a reader.
 *
 * `no-euicc` is not a fault. It is a plain SIM in a slot the console offered
 * an eSIM button for.
 */
export type EsimReadFailureCause = "no-euicc" | "read-failed";

export type EsimReadFailure = {
  modemImei: string;
  cause: EsimReadFailureCause;
  /** The edge's own words, always rendered, never replaced by our reading. */
  reason: string;
  failedAt: number | null;
};

/**
 * The edge names the step it died on, and only one step means "no eUICC here".
 *
 * `session.rs` wraps the very first thing an LPA does -- selecting the ISD-R
 * applet -- as `open ISD-R channel: ...`. SGP.22 requires every eUICC to carry
 * ISD-R, so a card that refuses that channel is not one. Every later failure
 * (the EID read, `GetEUICCInfo2`) reports its own step instead, and a refused
 * profile or notification list does not fail the command at all: it comes back
 * `succeeded` with `profiles_error` set.
 */
function refusedIsdrChannel(reason: string): boolean {
  return /open ISD-R channel/i.test(reason);
}

/**
 * The chip reads that are currently broken, one per module, already classified.
 *
 * Suppressed once a later read of the same module succeeded, for the reason
 * `newestFailureAfterSuccess` exists: a command list holds every attempt, so
 * "has anything ever failed" is almost always yes, and what a reader needs is
 * whether the situation is broken now.
 *
 * The refusal alone is not taken as proof that a module has no eUICC. A chip
 * we have read before, and a slot that never had one, can both fail to open a
 * channel -- a card that has fallen off the module answers nothing either. So
 * a module is only called `no-euicc` when nothing in view has ever got an EID
 * out of it: no reading in the command window, and no row in the durable
 * inventory. A chip with a history that stops answering is `read-failed`,
 * which is the honest description of a thing that used to work.
 *
 * The window is what it is: the console fetches the last 60 commands. A eUICC
 * that broke long enough ago for every success to have scrolled out would be
 * misread as absent -- which is why the inventory is consulted too, and why
 * this gets stronger the day `app.esim_profiles` stops being empty.
 */
export function esimReadFailures(
  rows: readonly EsimCommandRow[],
  inventory: readonly EsimProfileRow[] = [],
): EsimReadFailure[] {
  const knownEuicc = new Set<string>();
  for (const row of inventory) {
    if (row.modemImei && row.eid) knownEuicc.add(row.modemImei);
  }
  const newestSuccess = new Map<string, number>();
  const failures = new Map<string, EsimReadFailure>();
  for (const row of rows) {
    if (!ESIM_CHIP_COMMANDS.has(row.kind)) continue;
    const imei = asString((row.payload ?? {}).modem_imei);
    // Unattributable. Rendering it against no module would put a failure
    // banner on a page that cannot say which of three it is about.
    if (!imei) continue;
    const at = row.completed_at ?? 0;
    if (row.status === "succeeded") {
      if (at > (newestSuccess.get(imei) ?? -1)) newestSuccess.set(imei, at);
      const info = parseEsimInfoResult(row.result?.details);
      if (info?.eid) knownEuicc.add(imei);
      continue;
    }
    if (row.status !== "failed") continue;
    const existing = failures.get(imei);
    if (existing && (existing.failedAt ?? 0) >= at) continue;
    failures.set(imei, {
      modemImei: imei,
      cause: "read-failed",
      reason: row.result?.reason ?? "",
      failedAt: row.completed_at,
    });
  }
  return [...failures.values()]
    .filter((failure) => (failure.failedAt ?? 0) > (newestSuccess.get(failure.modemImei) ?? -1))
    .map((failure) => ({
      ...failure,
      cause:
        refusedIsdrChannel(failure.reason) && !knownEuicc.has(failure.modemImei)
          ? ("no-euicc" as const)
          : ("read-failed" as const),
    }))
    .sort((left, right) => left.modemImei.localeCompare(right.modemImei));
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

/**
 * One `+CUSD:` reply, as the edge reports it in a `send_ussd` result.
 *
 * The stage is the network's own answer code, not our interpretation of it:
 * `complete` and `needs_reply` carry text, and the other four are the module
 * saying nothing useful came back. Kept as the raw string rather than a union
 * so an unrecognised code from a future agent renders as itself instead of
 * being collapsed into the nearest known one.
 */
export type UssdResult = {
  code: string;
  stage: string;
  text: string;
  dcs: number | null;
  expectsReply: boolean;
  elapsedMs: number | null;
};

/**
 * Read one USSD answer out of a command result.
 *
 * `expects_reply` is derived from the stage when the field is absent, because
 * an agent older than that field still reports `needs_reply`, and the stage is
 * what the network actually said. Falling back to "no session is open" there
 * would hide a menu behind a control that never appears.
 */
export function parseUssdResult(value: unknown): UssdResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const stage = asString(row.stage);
  if (!stage) {
    return null;
  }
  return {
    code: typeof row.code === "string" ? row.code : "",
    stage,
    text: typeof row.text === "string" ? row.text : "",
    dcs: asNumber(row.dcs),
    expectsReply: asBoolean(row.expects_reply) ?? stage === "needs_reply",
    elapsedMs: asNumber(row.elapsed_ms),
  };
}

/** Enough of a relayed command for the USSD helpers below. */
export type UssdCommandRow = {
  id: string;
  kind: string;
  status: string;
  issued_at: number;
  completed_at: number | null;
  payload: Record<string, unknown> | null;
  result: { details?: unknown } | null;
};

/**
 * The last USSD exchange on a device, whatever became of it.
 *
 * A USSD session has no identifier anywhere in the contract, and it cannot
 * have one: the session lives in the module and the network, addressed only by
 * which AT port the request goes down. So the thing a follow-up has to carry
 * is the IMEI the opening request used — which is read back off the recorded
 * payload rather than off the page's modem selector, because those two stop
 * agreeing the moment an operator touches the dropdown, and a reply sent to
 * the wrong module is a fresh USSD request for a menu item's number.
 */
export type UssdExchange = {
  commandId: string;
  modemImei: string | null;
  stageSent: string;
  status: string;
  completedAt: number | null;
  result: UssdResult | null;
};

export function latestUssdExchange(rows: readonly UssdCommandRow[]): UssdExchange | null {
  let latest: UssdCommandRow | null = null;
  for (const row of rows) {
    if (row.kind !== "send_ussd") continue;
    if (!latest || row.issued_at > latest.issued_at) {
      latest = row;
    }
  }
  if (!latest) {
    return null;
  }
  const payload = latest.payload ?? {};
  return {
    commandId: latest.id,
    modemImei: asString(payload.modem_imei),
    // The gateway defaults an omitted stage to "start" before it ever reaches
    // the device, so reading an absent one as anything else would describe a
    // request that was not sent.
    stageSent: asString(payload.stage) ?? "start",
    status: latest.status,
    completedAt: latest.completed_at,
    result: parseUssdResult(latest.result?.details),
  };
}

/**
 * How long the console will offer to continue a session it saw open.
 *
 * There is no timer to read. GSM leaves the USSD session lifetime to the
 * network, the module reports nothing about it, and the one production run so
 * far never got an answer at all. So this is a console-side guard, not a
 * measurement: long enough that an operator reading a menu is not cut off,
 * short enough that a tab left open overnight does not send "2" to a carrier
 * as a brand new service code.
 */
export const USSD_SESSION_TTL_MS = 120_000;

/**
 * How old the open session is, by the two clocks that disagree.
 *
 * Neither reading is trustworthy alone. The row's `completed_at` comes off the
 * gateway's clock, so comparing it against the browser's measures the skew
 * between two machines as well as the passage of time — but it is the only one
 * that knows a page just loaded a menu that was answered an hour ago. The
 * page's own observation has no skew in it, and no memory: to a tab opened a
 * moment ago, every row in the history looks new.
 *
 * So the answer is the larger of the two. A session counts as young only when
 * both clocks agree it is, which fails towards refusing a live session — one
 * restart — rather than towards replying into a dead one.
 */
export function ussdSessionAgeMs(
  exchange: UssdExchange | null,
  observedAtMs: number | null,
  nowMs: number,
): number | null {
  if (!exchange) {
    return null;
  }
  const byGateway = exchange.completedAt === null ? null : nowMs - exchange.completedAt;
  const byPage = observedAtMs === null ? null : nowMs - observedAtMs;
  if (byGateway === null && byPage === null) {
    return null;
  }
  return Math.max(byGateway ?? 0, byPage ?? 0);
}

export type UssdSessionState = "none" | "open" | "expired";

/**
 * Whether a follow-up may still be sent, given how long ago the reply landed.
 *
 * The age is measured by the browser from when it first saw the reply, not
 * from the timestamps on the row: those come off the gateway's clock, and a
 * skewed comparison would decide this either way with equal confidence.
 *
 * An unknown age reads as expired. Refusing a session that was in fact still
 * open costs one restart; continuing one that has closed sends a menu item's
 * number to the carrier as a new USSD code, which is a request nobody made.
 */
export function ussdSessionState(
  exchange: UssdExchange | null,
  ageMs: number | null,
  ttlMs: number = USSD_SESSION_TTL_MS,
): UssdSessionState {
  if (!exchange || !exchange.result || !exchange.result.expectsReply) {
    return "none";
  }
  // A reply is addressed by IMEI or not at all.
  if (!exchange.modemImei) {
    return "none";
  }
  // Still in flight, or refused, or expired in the queue. A reply the device
  // never confirmed is not a session anybody can continue.
  if (exchange.status !== "succeeded") {
    return "none";
  }
  if (ageMs === null || ageMs > ttlMs) {
    return "expired";
  }
  return "open";
}

/**
 * The label a stage should be explained with.
 *
 * Four of the seven stages mean "no answer", and each means it for a different
 * reason an operator can act on: a terminated session is the carrier hanging
 * up, an unsupported one is the module refusing, a timeout is the network
 * never speaking. Rendering the raw code, or the empty `text` that comes with
 * those stages, tells them none of that — which is what the one production run
 * so far looked like: `{"stage":"network_timeout","text":"","elapsed_ms":30232}`
 * shown as a JSON blob.
 *
 * Returning a key rather than a sentence keeps the strings in the catalogues,
 * where check-i18n can see both locales.
 */
export type UssdStageLabelKey =
  | "ussdStageComplete"
  | "ussdStageNeedsReply"
  | "ussdStageTerminated"
  | "ussdStageOtherClient"
  | "ussdStageNotSupported"
  | "ussdStageNetworkTimeout"
  | "ussdStageOther";

const USSD_STAGE_LABELS: Record<string, UssdStageLabelKey> = {
  complete: "ussdStageComplete",
  needs_reply: "ussdStageNeedsReply",
  terminated: "ussdStageTerminated",
  other_client: "ussdStageOtherClient",
  not_supported: "ussdStageNotSupported",
  network_timeout: "ussdStageNetworkTimeout",
};

export function ussdStageLabelKey(stage: string): UssdStageLabelKey {
  // `other` is what the edge calls any +CUSD code it has no name for, and an
  // agent newer than this console can send one this build has never heard of.
  // Both land here, and both are shown with the raw code beside them.
  return USSD_STAGE_LABELS[stage] ?? "ussdStageOther";
}

/**
 * The body of one `send_ussd`, minus the fields every command carries.
 *
 * `code` is present even on a cancel because the contract requires it
 * (`SendUssdCommand.required` lists it) and the gateway sends it empty rather
 * than refusing. Building it here rather than at four call sites is what keeps
 * a follow-up from being posted without the IMEI that identifies its session.
 */
export type UssdRequest = {
  modem_imei: string;
  code: string;
  stage: "start" | "continue" | "cancel";
};

export function ussdStartRequest(modemImei: string, code: string): UssdRequest | null {
  if (!modemImei || code.trim() === "") {
    return null;
  }
  return { modem_imei: modemImei, code: code.trim(), stage: "start" };
}

/**
 * A reply on the session the given exchange opened.
 *
 * Null when there is nothing to reply to or nothing to say. The IMEI comes
 * from the exchange, never from the caller: sending a menu selection to a
 * module that has no session open does not fail — it dials the selection as a
 * USSD code of its own.
 */
export function ussdContinueRequest(
  exchange: UssdExchange | null,
  reply: string,
): UssdRequest | null {
  if (!exchange?.modemImei || reply.trim() === "") {
    return null;
  }
  return { modem_imei: exchange.modemImei, code: reply.trim(), stage: "continue" };
}

/**
 * Close a session, on the module that owns it.
 *
 * Falls back to the selected module when no session is known, because clearing
 * one the console never saw — left open by the local panel, or by a page that
 * has since been reloaded — is exactly what an operator reaches for this
 * button to do.
 */
export function ussdCancelRequest(
  exchange: UssdExchange | null,
  selectedImei: string,
): UssdRequest | null {
  const modemImei = exchange?.modemImei ?? selectedImei;
  if (!modemImei) {
    return null;
  }
  return { modem_imei: modemImei, code: "", stage: "cancel" };
}
