import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchAudit,
  fetchContacts,
  fetchDevices,
  fetchRules,
  fetchMessages,
  fetchSchedules,
  fetchSessions,
  fetchThread,
  fetchThreads,
  parseDevice,
  parseEsimAuthentication,
  parseEsimDownload,
  parseEsimInfoResult,
  parseMessage,
  parseRetrievedNotification,
  parseSchedule,
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

test("a reading with no EID identifies nothing and is dropped", () => {
  assert.equal(parseEsimInfoResult({ imei: "867018069514820" }), null);
  assert.equal(parseEsimInfoResult(null), null);
  assert.equal(parseEsimInfoResult("nope"), null);
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
