import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchAudit,
  fetchContacts,
  fetchDevices,
  fetchRules,
  fetchMessages,
  fetchSessions,
  fetchThread,
  fetchThreads,
  parseDevice,
  parseMessage,
  UnauthorizedError,
} from "./catalog.ts";

test("parseDevice ignores malformed rows", () => {
  assert.equal(parseDevice(null), null);
  assert.equal(parseDevice({ id: "d1" }), null);
  // A device that has never resumed reports no build and no backlog. Null
  // rather than a zero or an empty string: "not reported" and "on version
  // nothing, zero queued" are different claims, and only one of them is true.
  assert.deepEqual(parseDevice({ id: "d1", name: "lab", state: "online", last_seen: 12 }), {
    id: "d1",
    name: "lab",
    state: "online",
    lastSeen: 12,
    edgeVersion: null,
    matrixVersion: null,
    queueRecords: null,
    queueBytes: null,
    resumedAt: null,
    // Host vitals are absent for the same reason and in the same way: an
    // agent that has not reported them is not an agent reporting an idle
    // CPU on an empty box.
    publicIp: null,
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    hostReportedAt: null,
  });

  assert.deepEqual(
    parseDevice({
      id: "d1",
      name: "lab",
      state: "online",
      last_seen: 12,
      edge_version: "0.1.0",
      matrix_version: "2026-08-20",
      queue_records: 0,
      queue_bytes: 0,
      resumed_at: 99,
    }),
    {
      id: "d1",
      name: "lab",
      state: "online",
      lastSeen: 12,
      edgeVersion: "0.1.0",
      matrixVersion: "2026-08-20",
      // A drained queue is zero, and must survive as zero rather than
      // becoming null on the way through.
      queueRecords: 0,
      queueBytes: 0,
      resumedAt: 99,
      publicIp: null,
      cpuPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      hostReportedAt: null,
    },
  );
});

test("parseMessage requires the catalog fields", () => {
  assert.equal(parseMessage({ id: "m1" }), null);
  assert.equal(
    parseMessage({
      id: "m1",
      device_id: "d1",
      direction: "inbound",
      peer: "10086",
      body: "hi",
      bearer: "cellular",
      received_at: 1,
      seq: 1,
    })?.peer,
    "10086",
  );
});

test("catalog fetches send X-Forwarded-Host and stay tenant-scoped", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-forwarded-host"), "a.vodoge.com");
    const url = String(input);
    if (url.endsWith("/v1/devices")) {
      return Response.json({
        devices: [{ id: "d1", name: "lab", state: "online", last_seen: 9 }],
      });
    }
    if (url.endsWith("/v1/messages")) {
      return Response.json({
        messages: [
          {
            id: "m1",
            device_id: "d1",
            direction: "inbound",
            peer: "10086",
            body: "hello",
            bearer: "cellular",
            received_at: 11,
            seq: 1,
          },
        ],
      });
    }
    return Response.json({
      sessions: [
        {
          peer: "10086",
          count: 1,
          last_body: "hello",
          last_received_at: 11,
          device_id: "d1",
        },
      ],
    });
  };

  const devices = await fetchDevices("a.vodoge.com", "tok", fetchImpl);
  const messages = await fetchMessages("a.vodoge.com", "tok", fetchImpl);
  const sessions = await fetchSessions("a.vodoge.com", "tok", fetchImpl);
  assert.equal(devices[0]?.id, "d1");
  assert.equal(messages[0]?.body, "hello");
  assert.equal(sessions[0]?.peer, "10086");
  assert.deepEqual(
    calls.map((url) => url.split("/v1/")[1]),
    ["devices", "messages", "sessions"],
  );
});

test("catalog requests carry the session token", async () => {
  const seen: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify({ devices: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await fetchDevices("a.vodoge.com", "tok-a", fetchImpl);
  assert.equal(seen[0]?.authorization, "Bearer tok-a");
  assert.equal(seen[0]?.["x-forwarded-host"], "a.vodoge.com");
});

// Treating a refused session as "no data" would show a signed-out operator an
// empty console that looks like the real thing.
test("a refused session is an error, not an empty list", async () => {
  for (const status of [401, 403]) {
    const fetchImpl = (async () =>
      new Response("sign in required", { status })) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchDevices("a.vodoge.com", undefined, fetchImpl),
      UnauthorizedError,
    );
  }
});

// These endpoints answer 200 with an empty list when a tenant has nothing, so
// a 404 means the host did not resolve to a tenant. Rendering that as an empty
// console hides a misconfiguration behind a page that looks like it worked.
test("an unresolved tenant is an error, not an empty list", async () => {
  const fetchImpl = (async () =>
    new Response("unknown tenant", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchDevices("a.vodoge.com", "tok", fetchImpl),
    UnauthorizedError,
  );
});

// Rules and audit used to build their own request, which carried no session and
// read a rejection as an empty list. Routing them through the same client is
// what stops that from coming back.
test("rules and audit carry the session like everything else", async () => {
  const seen: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify({ rules: [], events: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await fetchRules("a.vodoge.com", "tok-a", fetchImpl);
  await fetchAudit("a.vodoge.com", "tok-a", fetchImpl);
  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal(headers.authorization, "Bearer tok-a");
  }
});

test("a rejected rules request is an error, not an empty list", async () => {
  const fetchImpl = (async () =>
    new Response("sign in required", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchRules("a.vodoge.com", undefined, fetchImpl),
    UnauthorizedError,
  );
});

test("malformed rule and audit rows are dropped rather than rendered", async () => {
  const fetchImpl = (async (url: string) =>
    new Response(
      JSON.stringify(
        String(url).includes("/v1/rules")
          ? { rules: [{ id: "r1", name: "otp", enabled: true }, { id: 7 }, null] }
          : { events: [{ actor: "a", action: "auth.login", target: "" }, {}, "x"] },
      ),
      { status: 200 },
    )) as unknown as typeof fetch;

  assert.equal((await fetchRules("a.vodoge.com", "t", fetchImpl)).length, 1);
  assert.equal((await fetchAudit("a.vodoge.com", "t", fetchImpl)).length, 1);
});

// The thread list is a closed object literal, same as parseDevice: a field the
// gateway starts sending and this map does not name is dropped on the floor
// with nothing to show for it. deepEqual is what makes that visible.
test("fetchThreads carries the contact name and the unread count", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      threads: [
        {
          peer: "10086",
          name: "ä¸­å½ç§»å¨",
          device_id: "d1",
          messages: 3,
          unsent: 0,
          unread: 2,
          last_body: "ä½é¢ 12.34 å",
          last_at: 500,
          last_inbound: true,
        },
      ],
    });

  const threads = await fetchThreads("a.vodoge.com", "tok", fetchImpl);
  assert.deepEqual(threads, [
    {
      peer: "10086",
      name: "ä¸­å½ç§»å¨",
      deviceId: "d1",
      messages: 3,
      unsent: 0,
      unread: 2,
      lastBody: "ä½é¢ 12.34 å",
      lastAt: 500,
      lastInbound: true,
    },
  ]);
});

// An unnamed number and an unread-free conversation are the common case, and
// both have to survive an absent field as a usable value rather than as
// undefined -- the page renders these directly.
test("fetchThreads defaults an unnamed, fully read conversation", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      threads: [
        {
          peer: "10086",
          device_id: "d1",
          messages: 1,
          unsent: 0,
          last_body: "hi",
          last_at: 1,
          last_inbound: false,
        },
      ],
    });

  const threads = await fetchThreads("a.vodoge.com", "tok", fetchImpl);
  assert.deepEqual(threads, [
    {
      peer: "10086",
      name: "",
      deviceId: "d1",
      messages: 1,
      unsent: 0,
      unread: 0,
      lastBody: "hi",
      lastAt: 1,
      lastInbound: false,
    },
  ]);
});

// Delivery is the field this whole slice exists to put on the screen, and it
// arrives through the same closed literal.
test("fetchThread carries delivery and read state", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      peer: "10086",
      messages: [
        {
          id: "m1",
          device_id: "d1",
          direction: "outbound",
          peer: "10086",
          body: "CXYE",
          bearer: "unknown",
          encoding: "gsm7",
          status: "delivered",
          received_at: 100,
          delivered_at: 250,
        },
      ],
    });

  const messages = await fetchThread("a.vodoge.com", "tok", "10086", fetchImpl);
  assert.deepEqual(messages, [
    {
      id: "m1",
      deviceId: "d1",
      direction: "outbound",
      peer: "10086",
      body: "CXYE",
      bearer: "unknown",
      encoding: "gsm7",
      status: "delivered",
      receivedAt: 100,
      deliveredAt: 250,
      // An outbound message is never unread: it was written here.
      readAt: null,
      failureReason: null,
    },
  ]);
});

// A message the modem accepted and the network has said nothing about yet.
// deliveredAt must be null, not zero: the badge decides whether to print a
// time from exactly this, and 1970 would be printed as an answer.
test("fetchThread leaves an undelivered send without a delivery time", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      peer: "10086",
      messages: [
        {
          id: "m1",
          device_id: "d1",
          direction: "outbound",
          peer: "10086",
          body: "CXYE",
          bearer: "unknown",
          encoding: "gsm7",
          status: "sent",
          received_at: 100,
        },
      ],
    });

  const messages = await fetchThread("a.vodoge.com", "tok", "10086", fetchImpl);
  assert.equal(messages[0]?.status, "sent");
  assert.equal(messages[0]?.deliveredAt, null);
});

test("fetchContacts reads the phone book", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return Response.json({
      contacts: [{ peer: "10086", name: "ä¸­å½ç§»å¨", note: "è¿è¥å", updated_at: 7 }],
    });
  };

  const contacts = await fetchContacts("a.vodoge.com", "tok", fetchImpl);
  assert.deepEqual(contacts, [
    { peer: "10086", name: "ä¸­å½ç§»å¨", note: "è¿è¥å", updatedAt: 7 },
  ]);
  assert.equal(calls[0]?.split("/v1/")[1], "messages/contacts");
});
