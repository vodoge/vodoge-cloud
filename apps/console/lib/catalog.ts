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
  if (response.status === 404) {
    return {};
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
