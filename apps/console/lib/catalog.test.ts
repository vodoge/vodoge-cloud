import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditScreen,
  loadAudit,
  parseAuditEvent,
  fetchContacts,
  fetchDevices,
  fetchRules,
  fetchMessages,
  fetchSchedules,
  fetchSessions,
  fetchThread,
  fetchThreads,
  esimProfileDisplayName,
  esimProfileRowsFromReads,
  esimReadFailures,
  ESIM_CHIP_COMMANDS,
  latestEsimProfileListings,
  mergeCommandBatches,
  mergeEsimProfiles,
  type EsimCommandRow,
  parseDevice,
  parseEsimAuthentication,
  parseEsimDownload,
  parseEsimInfoResult,
  parseMessage,
  parseRetrievedNotification,
  parseSchedule,
  parseUssdResult,
  latestUssdExchange,
  ussdCancelRequest,
  ussdContinueRequest,
  ussdSessionAgeMs,
  ussdSessionState,
  ussdStageLabelKey,
  ussdStartRequest,
  UnauthorizedError,
  USSD_SESSION_TTL_MS,
  type UssdCommandRow,
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
    // Disk, throughput and the machine's identity are absent the same way.
    // Zero throughput is a real reading an idle box produces, so it has to be
    // distinguishable from an agent that never measured the interfaces.
    diskUsedBytes: null,
    diskTotalBytes: null,
    netRxBytesPerSec: null,
    netTxBytesPerSec: null,
    cpuModel: null,
    kernel: null,
    hostname: null,
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
      diskUsedBytes: null,
      diskTotalBytes: null,
      netRxBytesPerSec: null,
      netTxBytesPerSec: null,
      cpuModel: null,
      kernel: null,
      hostname: null,
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
  await loadAudit("a.vodoge.com", "tok-a", fetchImpl);
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
  assert.deepEqual(await loadAudit("a.vodoge.com", "t", fetchImpl), {
    status: "ok",
    events: [{ actor: "a", action: "auth.login", target: "" }],
  });
});

/**
 * The body below is the one `/v1/audit` really answers with, byte for byte from
 * a live tenant: `apps/gateway/internal/audit/log.go` declares `Event` with no
 * struct tags, so `encoding/json` uses the Go field names. The console asked
 * for `row.action`, got `undefined`, dropped every row, and drew "Nothing
 * recorded yet" over a populated audit log without anything throwing.
 *
 * Deleting either half of `eitherCase` turns this red.
 */
test("audit rows arrive with Go field names and are read, not dropped", async () => {
  const fetchImpl = (async () =>
    new Response(
      '{"events":[{"Actor":"97747a3e-0000-0000-0000-000000000000",' +
        '"Action":"proxy.instances_export_refused",' +
        '"Target":"read-only account","Detail":{}}]}',
      { status: 200 },
    )) as unknown as typeof fetch;

  const load = await loadAudit("a.vodoge.com", "t", fetchImpl);
  assert.deepEqual(load, {
    status: "ok",
    events: [
      {
        actor: "97747a3e-0000-0000-0000-000000000000",
        action: "proxy.instances_export_refused",
        target: "read-only account",
      },
    ],
  });
});

test("the tagged shape keeps working, so the gateway may be fixed either way", () => {
  assert.deepEqual(parseAuditEvent({ actor: "a", action: "auth.login", target: "b" }), {
    actor: "a",
    action: "auth.login",
    target: "b",
  });
  // A row with no action under either spelling is not an audit row.
  assert.equal(parseAuditEvent({ Actor: "a", Target: "b" }), null);
  assert.equal(parseAuditEvent("x"), null);
  assert.equal(parseAuditEvent(null), null);
});

/**
 * The point of the whole card: four loads, four screens, no two alike.
 *
 * The page used to hold `events: AuditRow[] = []` and a `loadError` boolean,
 * and it printed the empty-state copy under *both* of the failing ones. A
 * reader could not tell "this tenant has done nothing" from "this console
 * could not read the answer" — and it was the second one that was true.
 */
test("an empty audit log and a failed load are different screens", () => {
  const empty = auditScreen({ status: "empty" });
  const failed = auditScreen({ status: "failed" });
  const unreadable = auditScreen({ status: "unreadable", received: 3 });
  const ok = auditScreen({
    status: "ok",
    events: [{ actor: "a", action: "auth.login", target: "b" }],
  });

  // Nothing is wrong, so there is no error line and no placeholder.
  assert.equal(ok.errorKey, null);
  assert.equal(ok.placeholder, null);
  assert.equal(ok.rows.length, 1);

  // An empty log is not a failure: no error line, and it says what would be
  // here rather than that something broke.
  assert.equal(empty.errorKey, null);
  assert.equal(empty.placeholder?.titleKey, "empty.audit.title");

  // Both failures say so above the card *and* inside it.
  assert.equal(failed.errorKey, "audit.loadError");
  assert.equal(failed.placeholder?.titleKey, "empty.audit.failedTitle");
  assert.equal(unreadable.errorKey, "audit.unreadableError");
  assert.equal(unreadable.placeholder?.titleKey, "empty.audit.unreadableTitle");
  // How many were thrown away, because "some" and "four hundred" are different
  // conversations with whoever owns the gateway.
  assert.deepEqual(unreadable.placeholder?.vars, { count: 3 });

  // Every one of the four is a screen of its own.
  const drawn = [ok, empty, failed, unreadable].map((screen) =>
    JSON.stringify([screen.errorKey, screen.placeholder, screen.rows.length]),
  );
  assert.equal(new Set(drawn).size, 4);
});

/** And the invariant the renderer leans on: rows or placeholder, never both. */
test("a screen either has rows or has a placeholder", () => {
  for (const load of [
    { status: "empty" },
    { status: "failed" },
    { status: "unreadable", received: 1 },
    { status: "ok", events: [{ actor: "a", action: "auth.login", target: "" }] },
  ] as const) {
    const screen = auditScreen(load);
    assert.equal(
      screen.rows.length > 0,
      screen.placeholder === null,
      `${load.status} can draw an empty table or a placeholder over rows`,
    );
  }
});

/**
 * A parser that drops everything must not report an empty log.
 *
 * This is the state the old code could not represent at all, and its absence is
 * why the bug survived: `fetchAudit` returned `[]` for "nothing happened" and
 * for "nothing parsed", and the page had no way to tell them apart.
 */
test("events that all fail to parse are unreadable, not empty", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ events: [{ who: "a" }, { what: "b" }, 7] }), {
      status: 200,
    })) as unknown as typeof fetch;
  assert.deepEqual(await loadAudit("a.vodoge.com", "t", fetchImpl), {
    status: "unreadable",
    received: 3,
  });
});

test("a tenant with no audit history is empty, not unreadable", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ events: [] }), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await loadAudit("a.vodoge.com", "t", fetchImpl), { status: "empty" });
});

/**
 * A rejected session is a failure, not an empty log.
 *
 * `getCatalog` throws `UnauthorizedError` on 401/403 and a plain `Error` on
 * anything else that is not ok; both have to come out as `failed` rather than
 * as an empty audit trail shown to a signed-out operator.
 */
test("a refused or unreachable gateway is a failed load, not an empty one", async () => {
  for (const status of [401, 403, 404, 500]) {
    const fetchImpl = (async () =>
      new Response("no", { status })) as unknown as typeof fetch;
    assert.deepEqual(
      await loadAudit("a.vodoge.com", "t", fetchImpl),
      { status: "failed" },
      `HTTP ${status} should not read as an empty audit log`,
    );
  }
  const thrower = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.deepEqual(await loadAudit("a.vodoge.com", "t", thrower), { status: "failed" });
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
          name: "中国移动",
          device_id: "d1",
          messages: 3,
          unsent: 0,
          unread: 2,
          last_body: "余额 12.34 元",
          last_at: 500,
          last_inbound: true,
        },
      ],
    });

  const threads = await fetchThreads("a.vodoge.com", "tok", fetchImpl);
  assert.deepEqual(threads, [
    {
      peer: "10086",
      name: "中国移动",
      deviceId: "d1",
      messages: 3,
      unsent: 0,
      unread: 2,
      lastBody: "余额 12.34 元",
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
      contacts: [{ peer: "10086", name: "中国移动", note: "运营商", updated_at: 7 }],
    });
  };

  const contacts = await fetchContacts("a.vodoge.com", "tok", fetchImpl);
  assert.deepEqual(contacts, [
    { peer: "10086", name: "中国移动", note: "运营商", updatedAt: 7 },
  ]);
  assert.equal(calls[0]?.split("/v1/")[1], "messages/contacts");
});

// The schedule row is a closed literal like every other parse here: a field the
// gateway starts sending and this map does not name is dropped, so the shape is
// pinned rather than trusted.
test("parseSchedule keeps the target, the cadence and the last outcome", () => {
  assert.equal(parseSchedule(null), null);
  assert.equal(parseSchedule({ name: "keepalive" }), null);
  assert.deepEqual(
    parseSchedule({
      id: "s1",
      name: "keepalive",
      enabled: true,
      action: "command",
      command_kind: "send_sms",
      selector: { mode: "card", iccid: "8986003031401770106" },
      request: { to: "10086", body: "1" },
      interval_seconds: 7200,
      anchor_at: 1000,
      last_occurrence: 4,
      next_due_at: 2000,
      last_run_at: 1500,
      last_status: "issued",
      last_command_id: "c1",
      last_detail: { command_id: "c1", occurrence: 4 },
    }),
    {
      id: "s1",
      name: "keepalive",
      enabled: true,
      action: "command",
      commandKind: "send_sms",
      selector: {
        mode: "card",
        deviceId: null,
        iccid: "8986003031401770106",
        modemImei: null,
      },
      intervalSeconds: 7200,
      nextDueAt: 2000,
      lastRunAt: 1500,
      lastStatus: "issued",
      lastCommandId: "c1",
      lastDetail: '{"command_id":"c1","occurrence":4}',
    },
  );
});

// A schedule that has never run must not read as one that ran and reported
// nothing: the page says "never" for the first and shows an outcome for the
// second, and conflating them hides a schedule that is not ticking at all.
test("parseSchedule leaves a schedule that has never run without an outcome", () => {
  const row = parseSchedule({
    id: "s2",
    name: "egress",
    enabled: false,
    action: "public_ip_check",
    selector: { mode: "device", device_id: "d1" },
    interval_seconds: 3600,
    next_due_at: 5000,
    last_detail: {},
  });
  assert.equal(row?.lastRunAt, null);
  assert.equal(row?.lastStatus, null);
  assert.equal(row?.lastDetail, null);
  assert.equal(row?.commandKind, null);
  assert.equal(row?.enabled, false);
});

test("fetchSchedules carries the session and drops malformed rows", async () => {
  const seen: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(
      JSON.stringify({
        schedules: [
          { id: "s1", name: "keepalive", enabled: true, interval_seconds: 7200 },
          { id: 7 },
          null,
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const rows = await fetchSchedules("a.vodoge.com", "tok-a", fetchImpl);
  assert.equal(rows.length, 1);
  assert.equal(seen[0].authorization, "Bearer tok-a");
  assert.equal(seen[0]["x-forwarded-host"], "a.vodoge.com");
});

test("a rejected schedules request is an error, not an empty list", async () => {
  const fetchImpl = (async () =>
    new Response("sign in required", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchSchedules("a.vodoge.com", undefined, fetchImpl),
    UnauthorizedError,
  );
});

/**
 * The details a real `read_esim_info` produced against 867018069514820.
 *
 * Copied out of `app.commands` on the production host: command
 * 066def7f-7a33-4b1f-86fd-7a3fc5024c8b, completed 2026-08-24 13:48:43Z. The
 * `profiles` array is the bench's real answer, nicknames and all -- which is
 * to say both nicknames are null and the only names the card offers are in
 * `name` / `provider` / `label`.
 */
const REAL_CHIP_READ = {
  imei: "867018069514820",
  eid: "89086030202200000026000178339240",
  chip: { decoded_fields: 16 },
  profiles: [
    {
      name: "WEBBING",
      class: 2,
      iccid: "89852351225042214201",
      label: "WEBBING",
      enabled: true,
      isdp_aid: "A0000005591010FFFFFFFF8900001200",
      nickname: null,
      provider: "Saily",
    },
    {
      name: "Wireless",
      class: 2,
      iccid: "8901240527197122156",
      label: "Wireless",
      enabled: false,
      isdp_aid: "A0000005591010FFFFFFFF8900001300",
      nickname: null,
      provider: "Wireless",
    },
  ],
  notifications: [],
  notifications_error: null,
  profiles_error: null,
};

/**
 * The reason the edge gave for the one failed chip read on this bench.
 *
 * Command d1eb02a7-dc33-4dac-9ac3-ad613fb8e354, `read_esim_info` against
 * 867018069509705, 2026-08-24 01:12:55Z, reason_code `esim_info_failed`. That
 * module holds a China Mobile plastic SIM, which has no ISD-R applet, so the
 * refusal happens at the first step and never reaches an ES10 command.
 */
const REAL_ISDR_REFUSAL =
  "QMI transport error: open ISD-R channel: QMI request rejected with result 1 error 80";

test("a chip reading is decoded from the command result", () => {
  // The details a real read_esim_info produced against 867018069514820.
  const details = {
    imei: "867018069514820",
    eid: "89086030202200000026000178339240",
    chip: {
      profile_version: "2.3.1",
      sgp22_version: "2.2.2",
      firmware_version: "4.2.0",
      installed_applications: 0,
      free_non_volatile_memory: 162256,
      free_volatile_memory: 2953,
      uicc_capabilities: ["usimSupport", "isimSupport"],
      ts102241_version: "9.2.0",
      global_platform_version: "2.3.0",
      rsp_capabilities: ["additionalProfile", "testProfileSupport"],
      ci_key_ids_for_verification: ["81370F5125D0B1D408D4C3B232E6D25E795BEBFB"],
      ci_key_ids_for_signing: ["81370F5125D0B1D408D4C3B232E6D25E795BEBFB"],
      category: 0,
      forbidden_profile_policy_rules: ["ppr1"],
      pp_version: "1.0.0",
      sas_accreditation_number: "ED-ZI-UP-0826",
      decoded_fields: 16,
    },
    notifications: [
      {
        sequence_number: 0,
        operations: ["install"],
        address: "wbg.prod.ondemandconnectivity.com",
        iccid: "89852351225042214201",
      },
      {
        sequence_number: 3,
        operations: ["enable"],
        address: "wbg.prod.ondemandconnectivity.com",
        iccid: "89852351225042214201",
      },
    ],
    notifications_error: null,
    profiles_error: null,
  };

  const info = parseEsimInfoResult(details);
  assert.ok(info);
  assert.equal(info.eid, "89086030202200000026000178339240");
  assert.equal(info.chip.freeNonVolatileMemory, 162256);
  assert.equal(info.chip.decodedFields, 16);
  assert.deepEqual(info.chip.ciKeyIdsForVerification, [
    "81370F5125D0B1D408D4C3B232E6D25E795BEBFB",
  ]);
  assert.equal(info.notifications.length, 2);
  // Zero is a sequence number. Dropping it would hide the oldest pending
  // notification on both chips on the bench.
  assert.equal(info.notifications[0].sequenceNumber, 0);
  assert.deepEqual(info.notifications[1].operations, ["enable"]);
});

test("the profile list the edge already sends is no longer thrown away", () => {
  const info = parseEsimInfoResult(REAL_CHIP_READ);
  assert.ok(info);
  // The bug this test exists for: `parseEsimInfoResult` returned six fields
  // and `profiles` was not one of them, so a card answering with two profiles
  // reached a page that rendered "no eUICC has reported anything yet".
  assert.equal(info.profiles.length, 2);
  assert.equal(info.profiles[0].iccid, "89852351225042214201");
  assert.equal(info.profiles[0].enabled, true);
  assert.equal(info.profiles[0].nickname, null);
  assert.equal(info.profiles[0].profileClass, 2);
  assert.equal(info.profiles[1].iccid, "8901240527197122156");
  assert.equal(info.profiles[1].enabled, false);
  // Nickname is null on both, so the name has to come from somewhere else or
  // the table shows two dashes for a card that named itself.
  assert.equal(esimProfileDisplayName(info.profiles[0]), "WEBBING");
  assert.equal(esimProfileDisplayName(info.profiles[1]), "Wireless");
});

test("a profile with no ICCID is dropped rather than rendered unswitchable", () => {
  const info = parseEsimInfoResult({
    imei: "867018069514820",
    eid: "89086030202200000026000178339240",
    profiles: [{ enabled: true, name: "nameless" }, "nope", null, { iccid: "8944" }],
  });
  assert.ok(info);
  assert.equal(info.profiles.length, 1);
  assert.equal(info.profiles[0].iccid, "8944");
  // Absent reads as disabled: the switch button only shows on a disabled row,
  // so the safe guess is the one that offers the control.
  assert.equal(info.profiles[0].enabled, false);
});

test("the profile table is rebuilt from the last chip read of each eUICC", () => {
  const rows = esimProfileRowsFromReads([
    {
      kind: "read_esim_info",
      status: "succeeded",
      completed_at: 1_756_042_123_000,
      payload: { modem_imei: "867018069514820" },
      result: { status: "succeeded", details: REAL_CHIP_READ },
    },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    eid: "89086030202200000026000178339240",
    iccid: "89852351225042214201",
    state: "enabled",
    nickname: "WEBBING",
    // What the switch button is addressed to. Without it the row renders
    // without its control and the table is a picture, not a page.
    modemImei: "867018069514820",
    collectedAt: 1_756_042_123_000,
    source: "read",
  });
  assert.equal(rows[1].state, "disabled");
  assert.equal(rows[1].iccid, "8901240527197122156");
});

test("only the newest reading of a chip becomes rows", () => {
  const stale = {
    ...REAL_CHIP_READ,
    profiles: [{ iccid: "89852351225042214201", enabled: false, name: "WEBBING" }],
  };
  const rows = esimProfileRowsFromReads([
    {
      kind: "read_esim_info",
      status: "succeeded",
      completed_at: 200,
      payload: { modem_imei: "867018069514820" },
      result: { details: REAL_CHIP_READ },
    },
    {
      kind: "read_esim_info",
      status: "succeeded",
      completed_at: 100,
      payload: { modem_imei: "867018069514820" },
      result: { details: stale },
    },
    // A failed read holds no details and must not blank out the good one.
    {
      kind: "read_esim_info",
      status: "failed",
      completed_at: 300,
      payload: { modem_imei: "867018069514820" },
      result: { status: "failed", reason: REAL_ISDR_REFUSAL },
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "enabled");
  assert.equal(rows[0].collectedAt, 200);
});

test("the inventory and the last reading merge into one row per profile", () => {
  const projected = {
    eid: "89086030202200000026000178339240",
    iccid: "89852351225042214201",
    state: "disabled",
    nickname: "from the projection",
    modemImei: "867018069514820",
    collectedAt: 100,
    source: "inventory" as const,
  };
  const deleted = { ...projected, iccid: "8944000000000000000", state: "deleted" };
  const merged = mergeEsimProfiles(
    [projected, deleted],
    esimProfileRowsFromReads([
      {
        kind: "read_esim_info",
        status: "succeeded",
        completed_at: 200,
        payload: { modem_imei: "867018069514820" },
        result: { details: REAL_CHIP_READ },
      },
    ]),
  );
  // Three rows, not four: same chip and same ICCID is one profile.
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((row) => [row.iccid, row.state, row.source]),
    [
      ["89852351225042214201", "enabled", "read"],
      ["8901240527197122156", "disabled", "read"],
      // The projection remembers what the chip no longer lists, which is the
      // question someone asks after a switch went wrong.
      ["8944000000000000000", "deleted", "inventory"],
    ],
  );
});

test("a stale reading does not overwrite a fresher inventory row", () => {
  const fresh = {
    eid: "89086030202200000026000178339240",
    iccid: "89852351225042214201",
    state: "enabled",
    nickname: "fresh",
    modemImei: "867018069514820",
    collectedAt: 900,
    source: "inventory" as const,
  };
  const merged = mergeEsimProfiles(
    [fresh],
    esimProfileRowsFromReads([
      {
        kind: "read_esim_info",
        status: "succeeded",
        completed_at: 200,
        payload: { modem_imei: "867018069514820" },
        result: { details: REAL_CHIP_READ },
      },
    ]),
  );
  const webbing = merged.find((row) => row.iccid === "89852351225042214201");
  assert.equal(webbing?.source, "inventory");
  assert.equal(webbing?.nickname, "fresh");
});

test("the refresh button's own command reaches the table too", () => {
  // `list_esim_profiles` answers with {imei, profiles} and no EID, which is
  // why the console could not file its rows anywhere. The EID is borrowed from
  // the newest reading of the same module. Without this the button labelled
  // "read the chip" appears to do nothing at all.
  const rows = esimProfileRowsFromReads([
    {
      kind: "read_esim_info",
      status: "succeeded",
      completed_at: 100,
      payload: { modem_imei: "867018069514820" },
      result: { details: REAL_CHIP_READ },
    },
    {
      kind: "list_esim_profiles",
      status: "succeeded",
      completed_at: 200,
      payload: { modem_imei: "867018069514820" },
      result: {
        details: {
          imei: "867018069514820",
          profiles: [
            {
              name: "WEBBING",
              class: 2,
              iccid: "89852351225042214201",
              label: "WEBBING",
              enabled: true,
              isdp_aid: "A0000005591010FFFFFFFF8900001200",
              nickname: null,
              provider: "Saily",
            },
          ],
        },
      },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eid, "89086030202200000026000178339240");
  assert.equal(rows[0].collectedAt, 200);
});

test("a listing whose chip has never been identified is not filed under a guess", () => {
  const listings = latestEsimProfileListings([
    {
      kind: "list_esim_profiles",
      status: "succeeded",
      completed_at: 200,
      payload: { modem_imei: "867018069514820" },
      result: { details: { imei: "867018069514820", profiles: [{ iccid: "8944" }] } },
    },
  ]);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].eid, null);
  // Visible as a listing, absent from the table: a row with no EID has no
  // heading to sit under, and inventing one would be worse than showing none.
  assert.deepEqual(esimProfileRowsFromReads([
    {
      kind: "list_esim_profiles",
      status: "succeeded",
      completed_at: 200,
      payload: { modem_imei: "867018069514820" },
      result: { details: { imei: "867018069514820", profiles: [{ iccid: "8944" }] } },
    },
  ]), []);
});

test("a refused profile list is kept apart from an empty chip", () => {
  const listings = latestEsimProfileListings([
    {
      kind: "read_esim_info",
      status: "succeeded",
      completed_at: 100,
      payload: { modem_imei: "867018069514820" },
      result: {
        details: {
          ...REAL_CHIP_READ,
          profiles: [],
          profiles_error: "eUICC returned profile list error 127 (undefined error)",
        },
      },
    },
  ]);
  assert.equal(listings.length, 1);
  assert.deepEqual(listings[0].profiles, []);
  assert.match(listings[0].profilesError ?? "", /127/);
});

test("a module with no eUICC is reported as that, not as a broken chip", () => {
  const failures = esimReadFailures([
    {
      kind: "read_esim_info",
      status: "failed",
      completed_at: 1_756_000_375_242,
      payload: { modem_imei: "867018069509705" },
      result: { status: "failed", reason: REAL_ISDR_REFUSAL },
    },
    {
      kind: "read_esim_info",
      status: "succeeded",
      completed_at: 1_756_000_374_496,
      payload: { modem_imei: "862547055142811" },
      result: { details: { ...REAL_CHIP_READ, imei: "862547055142811" } },
    },
  ]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].modemImei, "867018069509705");
  assert.equal(failures[0].cause, "no-euicc");
  // The edge's own words survive the classification. Our reading of them is
  // an addition to the page, never a replacement for what it said.
  assert.equal(failures[0].reason, REAL_ISDR_REFUSAL);
});

test("the same refusal from a chip we have read before is a failure, not an absence", () => {
  const failures = esimReadFailures([
    {
      kind: "read_esim_info",
      status: "succeeded",
      completed_at: 100,
      payload: { modem_imei: "867018069514820" },
      result: { details: REAL_CHIP_READ },
    },
    {
      kind: "read_esim_info",
      status: "failed",
      completed_at: 200,
      payload: { modem_imei: "867018069514820" },
      result: { status: "failed", reason: REAL_ISDR_REFUSAL },
    },
  ]);
  assert.equal(failures.length, 1);
  // Byte for byte the same reason as the test above, and a different verdict:
  // this chip has an EID on record, so a slot that answers nothing today is a
  // chip that stopped answering rather than a slot that never had one.
  assert.equal(failures[0].cause, "read-failed");
});

test("a chip in the durable inventory is never called absent", () => {
  const failures = esimReadFailures(
    [
      {
        kind: "list_esim_profiles",
        status: "failed",
        completed_at: 200,
        payload: { modem_imei: "867018069514820" },
        result: { status: "failed", reason: `esim_list_failed: ${REAL_ISDR_REFUSAL}` },
      },
    ],
    [
      {
        eid: "89086030202200000026000178339240",
        iccid: "89852351225042214201",
        state: "enabled",
        nickname: null,
        modemImei: "867018069514820",
        collectedAt: 50,
        source: "inventory",
      },
    ],
  );
  assert.equal(failures[0].cause, "read-failed");
});

test("a failure a later read recovered from is not shown at all", () => {
  const failures = esimReadFailures([
    {
      kind: "read_esim_info",
      status: "failed",
      completed_at: 100,
      payload: { modem_imei: "867018069514820" },
      result: { status: "failed", reason: REAL_ISDR_REFUSAL },
    },
    {
      kind: "read_esim_info",
      status: "succeeded",
      completed_at: 200,
      payload: { modem_imei: "867018069514820" },
      result: { details: REAL_CHIP_READ },
    },
  ]);
  assert.deepEqual(failures, []);
});

test("a failure that names no module is not attributed to one", () => {
  const failures = esimReadFailures([
    {
      kind: "read_esim_info",
      status: "failed",
      completed_at: 100,
      payload: null,
      result: { status: "failed", reason: REAL_ISDR_REFUSAL },
    },
  ]);
  assert.deepEqual(failures, []);
});

test("a reading with no EID identifies nothing and is dropped", () => {
  assert.equal(parseEsimInfoResult({ imei: "867018069514820" }), null);
  assert.equal(parseEsimInfoResult(null), null);
  assert.equal(parseEsimInfoResult("nope"), null);
});

test("ESIM_CHIP_COMMANDS names the two kinds that open an ISD-R channel", () => {
  assert.ok(ESIM_CHIP_COMMANDS.has("read_esim_info"));
  assert.ok(ESIM_CHIP_COMMANDS.has("list_esim_profiles"));
  assert.equal(ESIM_CHIP_COMMANDS.size, 2);
});

test("mergeCommandBatches deduplicates across batches by id", () => {
  const a = [
    { id: "1", kind: "read_esim_info" },
    { id: "2", kind: "at_command" },
  ];
  const b = [
    { id: "2", kind: "at_command" }, // duplicate of a[1]
    { id: "3", kind: "list_esim_profiles" },
  ];
  const merged = mergeCommandBatches(a, b);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((r) => r.id),
    ["1", "2", "3"],
  );
});

test("mergeCommandBatches preserves order: first batch first, then new ids", () => {
  const first = [{ id: "a" }, { id: "b" }];
  const second = [{ id: "b" }, { id: "c" }];
  const merged = mergeCommandBatches(first, second);
  assert.deepEqual(
    merged.map((r) => r.id),
    ["a", "b", "c"],
  );
});

test("a read failure scrolled past the 60-command window is recovered when kind-filtered rows are merged", () => {
  // 60 non-eSIM commands fill the unfiltered window, pushing the failure out.
  // This reproduces the scenario from 2026-08-24: 867018069509705 had its
  // only read_esim_info at position 61+, so the panel showed nothing.
  type TestRow = EsimCommandRow & { id: string };
  const window60: TestRow[] = Array.from({ length: 60 }, (_, i) => ({
    id: `cmd-${i}`,
    kind: "at_command",
    status: "succeeded",
    completed_at: i + 100,
    payload: { modem_imei: "867018069509705" },
    result: null,
  }));
  const beyondWindow: TestRow = {
    id: "cmd-esim",
    kind: "read_esim_info",
    status: "failed",
    completed_at: 50,
    payload: { modem_imei: "867018069509705" },
    result: { status: "failed", reason: REAL_ISDR_REFUSAL },
  };

  // Without kind-filter (today's unfiltered-only behavior): failure invisible.
  assert.equal(esimReadFailures(window60).length, 0);

  // With kind-filter merged in: failure is recovered and correctly classified.
  const merged = mergeCommandBatches(window60, [beyondWindow]);
  const failures = esimReadFailures(merged);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].cause, "no-euicc");
  assert.equal(failures[0].modemImei, "867018069509705");
});

test("a card that refused the notification query says so rather than looking empty", () => {
  const info = parseEsimInfoResult({
    imei: "867018069514820",
    eid: "89086030202200000026000178339240",
    chip: { decoded_fields: 16 },
    notifications: [],
    notifications_error: "eUICC returned notification list error 127 (undefined error)",
  });
  assert.ok(info);
  assert.equal(info.notifications.length, 0);
  assert.match(info.notificationsError ?? "", /127/);
});

test("a fetched notification is not a delivered one", () => {
  const value = parseRetrievedNotification({
    imei: "867018069514820",
    sequence_number: 3,
    operations: ["enable"],
    address: "wbg.prod.ondemandconnectivity.com",
    iccid: "89852351225042214201",
    installation_result: false,
    payload_bytes: 1460,
    payload_hex: "3082",
    delivered: false,
    delivery_blocked_by: "ES9+ handleNotification needs an HTTPS client",
  });
  assert.ok(value);
  assert.equal(value.sequenceNumber, 3);
  assert.equal(value.payloadBytes, 1460);
  assert.equal(value.delivered, false);
  assert.match(value.deliveryBlockedBy ?? "", /ES9\+/);
});

// One real exchange with wbg.prod.ondemandconnectivity.com, trimmed to the
// fields the page reads.
const REAL_AUTHENTICATION = {
  imei: "867018069514820",
  eid: "89086030202200000026000178339240",
  smdp_address: "wbg.prod.ondemandconnectivity.com",
  smdp_address_source: "pending_notification",
  configured_default_smdp: null,
  configured_root_smds: "testrootsmds.gsma.com",
  notification_addresses: ["wbg.prod.ondemandconnectivity.com"],
  euicc_challenge: "8BCF1BE4ADA9C98AF062987330056103",
  transaction_id: "E4F6996D64A543FC8A7F6F8F97F9428D",
  server_address: "wbg.prod.ondemandconnectivity.com",
  server_challenge: "0982F87937A6C56B25569C568E4C4D68",
  echoed_euicc_challenge: "8BCF1BE4ADA9C98AF062987330056103",
  euicc_ci_pkid_to_be_used: "81370F5125D0B1D408D4C3B232E6D25E795BEBFB",
  chip_ci_key_ids: ["81370F5125D0B1D408D4C3B232E6D25E795BEBFB"],
  ci_key_accepted_by_chip: true,
  certificate_key_id: "25F709B3736C0BDA32D6A94A31BDE47CB12A25AA",
  certificate_authority_key_id: "81370F5125D0B1D408D4C3B232E6D25E795BEBFB",
  certificate_sha256:
    "7f93b55b56a9da4e29bc4d4118f698a3dd8d5354b28f936734e7fa0efd8ea9b5",
  certificate_not_after: "270925235959Z",
  certificate_signed_by_ci: true,
  server_signature_valid: true,
  challenge_echoed: true,
  trust_anchor_label: "gsma-rsp2-root-ci1.pem",
  trust_anchor_key_id: "81370F5125D0B1D408D4C3B232E6D25E795BEBFB",
  trust_directory: "/etc/vodoge/rsp-trust",
  trust_anchors: [
    {
      label: "gsma-rsp2-root-ci1.pem",
      key_id: "81370F5125D0B1D408D4C3B232E6D25E795BEBFB",
      sha256: "5e3e91fd454327c3af5d32a7a73bbc59fe43aa7d85fd32d5db44423f80a56bb3",
      not_after: "20520221235959Z",
    },
  ],
  negotiated_tls: "TLSv1_3",
  admin_protocol: "gsma/rsp/v2.2.0",
  http_status: 200,
  elapsed_ms: 812,
  profile_downloaded: false,
  stopped_after: "the server's signed answer",
};

test("an ES9+ exchange keeps each check separate", () => {
  const value = parseEsimAuthentication(REAL_AUTHENTICATION);
  assert.ok(value);
  assert.equal(value.transactionId, "E4F6996D64A543FC8A7F6F8F97F9428D");
  // The chip's challenge and the one the server signed back have to be
  // compared by the reader, so both are carried rather than one flag.
  assert.equal(value.euiccChallenge, value.echoedEuiccChallenge);
  assert.equal(value.certificateSignedByCi, true);
  assert.equal(value.serverSignatureValid, true);
  assert.equal(value.challengeEchoed, true);
  assert.equal(value.ciKeyAcceptedByChip, true);
  assert.equal(value.trustAnchors.length, 1);
  assert.equal(value.trustAnchors[0].notAfter, "20520221235959Z");
  // Stated, not implied.
  assert.equal(value.profileDownloaded, false);
});

test("an edge that did not report a check is not a passed check", () => {
  // An older agent answering this command would leave the verification
  // fields out entirely. Coercing an absent field to true is how a page
  // ends up claiming a signature verified when nothing verified it.
  const partial: Record<string, unknown> = { ...REAL_AUTHENTICATION };
  delete partial.certificate_signed_by_ci;
  delete partial.server_signature_valid;
  delete partial.challenge_echoed;
  const value = parseEsimAuthentication(partial);
  assert.ok(value);
  assert.equal(value.certificateSignedByCi, false);
  assert.equal(value.serverSignatureValid, false);
  assert.equal(value.challengeEchoed, false);
});

test("an exchange with no transaction identifies nothing and is dropped", () => {
  const withoutTransaction: Record<string, unknown> = { ...REAL_AUTHENTICATION };
  delete withoutTransaction.transaction_id;
  assert.equal(parseEsimAuthentication(withoutTransaction), null);
  assert.equal(parseEsimAuthentication(null), null);
  assert.equal(parseEsimAuthentication("nope"), null);
});

// A download result the edge would send after a profile arrived. Shaped after
// EsimDownloadBody in edge-bin, and deliberately without an activation code or
// a matching id: neither is in that struct, and a test that carried one would
// be pinning behaviour nobody wants.
const DOWNLOAD: Record<string, unknown> = {
  imei: "867018069514820",
  eid: "89086030202200000026000178339240",
  smdp_address: "smdp.example.com",
  transaction_id: "AC4F5FD6139AB3433069F3B76BF53382",
  matching_id_supplied: true,
  profile: {
    iccid: "8944478100000123456",
    service_provider_name: "Example US",
    profile_name: "Example",
    class: 2,
    policy_rules: [],
  },
  refused_policy_rules: [],
  before: {
    free_non_volatile_memory: 162256,
    profiles: [{ iccid: "89852351225042214201", label: "WEBBING", enabled: true }],
    notifications: [{ sequence_number: 0, operations: ["install"], address: "a.example.com" }],
  },
  after: {
    free_non_volatile_memory: 121904,
    profiles: [
      { iccid: "89852351225042214201", label: "WEBBING", enabled: true },
      { iccid: "8944478100000123456", label: "Example", enabled: false },
    ],
    notifications: [{ sequence_number: 0, operations: ["install"], address: "a.example.com" }],
  },
  free_memory_consumed: 40352,
  profiles_added: 1,
  authenticate_server_blocks: 6,
  prepare_download_blocks: 4,
  bound_profile_package_bytes: 24576,
  bound_profile_package_blocks: 103,
  bound_profile_package_segments: [
    { label: "header+initialiseSecureChannelRequest", bytes: 120, blocks: 1 },
    { label: "86[0]", bytes: 2048, blocks: 9 },
  ],
  installed: true,
  enabled: false,
  installation_iccid: "8944478100000123456",
  notification_sequence_number: 4,
  notification_bytes: 1400,
  notification_delivered: true,
  notification_removed_code: 0,
  notifications_pending_before: 1,
  notifications_pending_after: 1,
  certificate_signed_by_ci: true,
  server_signature_valid: true,
  challenge_echoed: true,
  ci_key_accepted_by_chip: true,
  negotiated_tls: "TLSv1_3",
  trust_anchor_key_id: "81370F5125D0B1D408D4C3B232E6D25E795BEBFB",
};

test("a download is read as before and after, not as a verdict", () => {
  const value = parseEsimDownload(DOWNLOAD);
  assert.ok(value);
  assert.equal(value.installed, true);
  // Installing and enabling are separate operations, and the page has to be
  // able to say the second one did not happen.
  assert.equal(value.enabled, false);
  assert.equal(value.before.profiles.length, 1);
  assert.equal(value.after?.profiles.length, 2);
  assert.equal(value.after?.profiles[1]?.enabled, false);
  assert.equal(value.freeMemoryConsumed, 40352);
  assert.equal(value.profilesAdded, 1);
  assert.equal(value.boundProfilePackageBlocks, 103);
  assert.equal(value.boundProfilePackageSegments.length, 2);
  assert.equal(value.notificationDelivered, true);
  assert.equal(value.notificationRemovedCode, 0);
  assert.equal(value.profileName, "Example");
  assert.deepEqual(value.policyRules, []);
});

test("a refused download names the policy rules that stopped it", () => {
  const refused: Record<string, unknown> = {
    ...DOWNLOAD,
    profile: { ...(DOWNLOAD.profile as Record<string, unknown>), policy_rules: ["ppr1"] },
    refused_policy_rules: ["ppr1"],
    installed: false,
    after: DOWNLOAD.before,
    free_memory_consumed: 0,
    profiles_added: 0,
    session_cancelled: "pprNotAllowed",
    stopped_after: "the profile carries ppr1, which cannot be removed once installed",
  };
  const value = parseEsimDownload(refused);
  assert.ok(value);
  assert.equal(value.installed, false);
  assert.deepEqual(value.refusedPolicyRules, ["ppr1"]);
  assert.equal(value.sessionCancelled, "pprNotAllowed");
  assert.equal(value.profilesAdded, 0);
});

// An edge that is older than this page sends none of the confirmations. They
// have to read as "not done" rather than as "done": on this command, coercing
// an absent field to true is the difference between a page that says a profile
// was installed and a chip that has nothing on it.
test("a download result missing its confirmations claims nothing", () => {
  const partial: Record<string, unknown> = { ...DOWNLOAD };
  delete partial.installed;
  delete partial.notification_delivered;
  delete partial.certificate_signed_by_ci;
  delete partial.after;
  const value = parseEsimDownload(partial);
  assert.ok(value);
  assert.equal(value.installed, false);
  assert.equal(value.notificationDelivered, false);
  assert.equal(value.certificateSignedByCi, false);
  assert.equal(value.after, null);
});

test("a download with no transaction identifies nothing and is dropped", () => {
  const withoutTransaction: Record<string, unknown> = { ...DOWNLOAD };
  delete withoutTransaction.transaction_id;
  assert.equal(parseEsimDownload(withoutTransaction), null);
  assert.equal(parseEsimDownload(null), null);
  assert.equal(parseEsimDownload("nope"), null);
});

// ---------------------------------------------------------------------------
// USSD sessions.
//
// The console could not send `stage:"continue"` at all until now, so every
// multi-level menu — balance, plan, top-up, the codes an operator actually
// uses — stopped at its first screen. What makes the follow-up delicate is
// that there is no session identifier to carry: the session lives in the
// module, addressed only by which AT port the request goes down, so "the right
// session" means "the same IMEI, soon enough". Getting either wrong does not
// fail loudly. It dials the menu item's number as a fresh USSD code.
// ---------------------------------------------------------------------------

/** The one production USSD result on record (T076): the network never spoke. */
const NETWORK_TIMEOUT = {
  code: "*#100#",
  stage: "network_timeout",
  text: "",
  expects_reply: false,
  elapsed_ms: 30232,
};

const MENU = {
  code: "*101#",
  stage: "needs_reply",
  text: "1. Balance\n2. Plan",
  expects_reply: true,
  dcs: 15,
  elapsed_ms: 1200,
};

function ussdRow(over: Partial<UssdCommandRow> & { details?: unknown } = {}): UssdCommandRow {
  const { details, ...rest } = over;
  return {
    id: "c1",
    kind: "send_ussd",
    status: "succeeded",
    issued_at: 1000,
    completed_at: 2000,
    payload: { modem_imei: "867018069514820", stage: "start", code: "*101#" },
    result: details === undefined ? null : { details },
    ...rest,
  };
}

test("parseUssdResult keeps the stage the network actually reported", () => {
  const value = parseUssdResult(NETWORK_TIMEOUT);
  assert.ok(value);
  assert.equal(value.stage, "network_timeout");
  assert.equal(value.expectsReply, false);
  assert.equal(value.text, "");
  assert.equal(value.elapsedMs, 30232);
  assert.equal(value.dcs, null);
});

// An agent older than `expects_reply` still reports the stage, and the stage is
// what the network said. Reading the absent field as "closed" would hide the
// reply box on exactly the sessions that need one.
test("parseUssdResult derives expectsReply from the stage when the field is absent", () => {
  const older: Record<string, unknown> = { ...MENU };
  delete older.expects_reply;
  assert.equal(parseUssdResult(older)?.expectsReply, true);
  const closed: Record<string, unknown> = { ...NETWORK_TIMEOUT };
  delete closed.expects_reply;
  assert.equal(parseUssdResult(closed)?.expectsReply, false);
});

test("parseUssdResult drops a result with no stage", () => {
  assert.equal(parseUssdResult({ text: "Balance 12.30" }), null);
  assert.equal(parseUssdResult(null), null);
  assert.equal(parseUssdResult("nope"), null);
});

test("latestUssdExchange picks the newest USSD command and ignores the rest", () => {
  const exchange = latestUssdExchange([
    ussdRow({ id: "old", issued_at: 10, details: MENU }),
    { ...ussdRow({ id: "at", issued_at: 99 }), kind: "run_at_command" },
    ussdRow({ id: "new", issued_at: 50, details: NETWORK_TIMEOUT }),
  ]);
  assert.equal(exchange?.commandId, "new");
  assert.equal(exchange?.result?.stage, "network_timeout");
  assert.equal(latestUssdExchange([]), null);
});

// The gateway substitutes "start" for an omitted stage before the device ever
// sees the command, so reading an absent one as anything else would describe a
// request that was not sent.
test("latestUssdExchange reads an omitted stage as the start the gateway sent", () => {
  const exchange = latestUssdExchange([ussdRow({ payload: { modem_imei: "8670" } })]);
  assert.equal(exchange?.stageSent, "start");
  assert.equal(exchange?.modemImei, "8670");
});

test("a session is open only while the device is waiting for a reply", () => {
  const menu = latestUssdExchange([ussdRow({ details: MENU })]);
  assert.equal(ussdSessionState(menu, 5_000), "open");

  const answered = latestUssdExchange([
    ussdRow({ details: { ...MENU, stage: "complete", expects_reply: false } }),
  ]);
  assert.equal(ussdSessionState(answered, 5_000), "none");

  const timedOut = latestUssdExchange([ussdRow({ details: NETWORK_TIMEOUT })]);
  assert.equal(ussdSessionState(timedOut, 5_000), "none");

  assert.equal(ussdSessionState(null, 5_000), "none");
});

// A command still in flight, or one the gateway refused, has not opened
// anything. Only a succeeded one has a device behind it.
test("an unsettled or failed command opens no session", () => {
  for (const status of ["queued", "sent", "executing", "failed", "expired", "cancelled"]) {
    const exchange = latestUssdExchange([ussdRow({ status, details: MENU })]);
    assert.equal(ussdSessionState(exchange, 1_000), "none", status);
  }
});

// Without an IMEI the reply has nowhere to go, and the modem selector is not a
// substitute: it is whatever the operator last clicked, which is how a reply
// ends up dialled on a module that never opened a session.
test("a session with no recorded IMEI cannot be continued", () => {
  const exchange = latestUssdExchange([ussdRow({ payload: { stage: "start" }, details: MENU })]);
  assert.equal(exchange?.modemImei, null);
  assert.equal(ussdSessionState(exchange, 1_000), "none");
  assert.equal(ussdContinueRequest(exchange, "1"), null);
});

test("a session past its guard reads as expired rather than open", () => {
  const menu = latestUssdExchange([ussdRow({ details: MENU })]);
  assert.equal(ussdSessionState(menu, USSD_SESSION_TTL_MS - 1), "open");
  assert.equal(ussdSessionState(menu, USSD_SESSION_TTL_MS), "open");
  assert.equal(ussdSessionState(menu, USSD_SESSION_TTL_MS + 1), "expired");
  // An age the page never measured is treated as too old. Refusing a live
  // session costs one restart; continuing a dead one sends "1" to the carrier
  // as a service code nobody asked for.
  assert.equal(ussdSessionState(menu, null), "expired");
});

test("continuing carries the session's own IMEI, not the selected one", () => {
  const menu = latestUssdExchange([ussdRow({ details: MENU })]);
  assert.deepEqual(ussdContinueRequest(menu, " 2 "), {
    modem_imei: "867018069514820",
    code: "2",
    stage: "continue",
  });
  assert.equal(ussdContinueRequest(menu, "   "), null);
  assert.equal(ussdContinueRequest(null, "2"), null);
});

test("starting and cancelling produce the shapes the contract requires", () => {
  assert.deepEqual(ussdStartRequest("8670", " *101# "), {
    modem_imei: "8670",
    code: "*101#",
    stage: "start",
  });
  assert.equal(ussdStartRequest("8670", " "), null);
  assert.equal(ussdStartRequest("", "*101#"), null);

  // SendUssdCommand requires `code`, so a cancel carries it empty rather than
  // omitting it — the gateway does the same thing on its side.
  const menu = latestUssdExchange([ussdRow({ details: MENU })]);
  assert.deepEqual(ussdCancelRequest(menu, "other-imei"), {
    modem_imei: "867018069514820",
    code: "",
    stage: "cancel",
  });
  // No known session: clearing one the console never saw is what the button is
  // for, so it falls back to whichever module is selected.
  assert.deepEqual(ussdCancelRequest(null, "8670"), {
    modem_imei: "8670",
    code: "",
    stage: "cancel",
  });
  assert.equal(ussdCancelRequest(null, ""), null);
});

test("every stage the edge can report has its own explanation", () => {
  assert.deepEqual(
    [
      "complete",
      "needs_reply",
      "terminated",
      "other_client",
      "not_supported",
      "network_timeout",
    ].map(ussdStageLabelKey),
    [
      "ussdStageComplete",
      "ussdStageNeedsReply",
      "ussdStageTerminated",
      "ussdStageOtherClient",
      "ussdStageNotSupported",
      "ussdStageNetworkTimeout",
    ],
  );
  // `other` is the edge's own name for a +CUSD code it cannot place, and an
  // agent newer than this build can send one this build has never heard of.
  assert.equal(ussdStageLabelKey("other"), "ussdStageOther");
  assert.equal(ussdStageLabelKey("7"), "ussdStageOther");
});

// Two clocks, and the session is young only when both say so. The gateway's
// timestamp is the only one that knows a page just loaded an hour-old menu;
// the page's own observation is the only one with no skew in it.
test("session age is the older of what the gateway says and what the page saw", () => {
  const now = 1_000_000;
  const menu = latestUssdExchange([ussdRow({ completed_at: now - 5_000, details: MENU })]);

  // Agreeing: five seconds either way.
  assert.equal(ussdSessionAgeMs(menu, now - 5_000, now), 5_000);
  // The row looks fresh because the two machines disagree, but this tab has
  // been watching the same answer for ten minutes.
  assert.equal(ussdSessionAgeMs(menu, now - 600_000, now), 600_000);
  // Reloaded onto an hour-old row: nothing was observed, and the row decides.
  const stale = latestUssdExchange([ussdRow({ completed_at: now - 3_600_000, details: MENU })]);
  assert.equal(ussdSessionAgeMs(stale, null, now), 3_600_000);
  assert.equal(ussdSessionState(stale, ussdSessionAgeMs(stale, null, now)), "expired");
  // A row with no completion time at all still ages by observation.
  const undated = latestUssdExchange([ussdRow({ completed_at: null, details: MENU })]);
  assert.equal(ussdSessionAgeMs(undated, now - 1_000, now), 1_000);
  // Neither clock has anything to say, so nothing is known.
  assert.equal(ussdSessionAgeMs(undated, null, now), null);
  assert.equal(ussdSessionAgeMs(null, now, now), null);
});

// The end-to-end shape of the thing this card exists for: a menu arrives, the
// operator picks item 2, and the follow-up carries stage "continue" and the
// IMEI of the module holding the session — not the one in the dropdown.
test("a menu answered in time produces a continue on the session's own modem", () => {
  const now = 1_000_000;
  const rows = [ussdRow({ completed_at: now - 4_000, details: MENU })];
  const exchange = latestUssdExchange(rows);
  const age = ussdSessionAgeMs(exchange, now - 4_000, now);
  assert.equal(ussdSessionState(exchange, age), "open");
  assert.deepEqual(ussdContinueRequest(exchange, "2"), {
    modem_imei: "867018069514820",
    code: "2",
    stage: "continue",
  });

  // Three minutes later the same menu is no longer answerable, and the panel
  // has something to say instead of a control that silently disappeared.
  const late = now + 180_000;
  assert.equal(
    ussdSessionState(exchange, ussdSessionAgeMs(exchange, now - 4_000, late)),
    "expired",
  );
});
