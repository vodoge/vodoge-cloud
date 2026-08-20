# Edge-cloud protocol reliability

This document fixes the delivery semantics behind
`packages/contract/schema/edge-cloud.v1.schema.json`. The protocol remains
MessagePack over an edge-initiated WSS connection, but WebSocket delivery is
not treated as durable delivery. PostgreSQL and the edge SQLite database are
the respective sources of truth; Redis is only a wake-up and routing hint.

## Terms and invariants

| Term | Meaning |
| --- | --- |
| `seq` | A device-local, strictly increasing unsigned 64-bit sequence allocated when an edge-to-cloud business event is committed to edge SQLite. It is serialized as a canonical decimal string. |
| `committed_through` | The largest **contiguous** sequence prefix the cloud has durably recorded or explicitly marked as lost through an accepted `UplinkGap`. It is not the largest sequence ever seen. |
| `missing_ranges` | A bounded hint showing known holes above `committed_through`. It is not permission to delete anything. |
| `cmd_id` | The durable, logical identity of one cloud command. Every physical redelivery uses the same `cmd_id`. |
| `delivery_id` | The envelope `id` of one physical `CommandDeliver` attempt. A `CommandReceipt` echoes it. |

The following rules are non-negotiable.

1. Only the edge initiates WSS connections. Cloud services never dial customer
   hardware.
2. mTLS determines `(tenant_id, device_id, region)`. The envelope may not
   override it; a mismatched `device_id` closes the connection.
3. Every sequenced upstream envelope is first committed locally, then sent.
   Retries retain both `id` and `seq`; a new send must never allocate a new
   sequence for an old event.
4. An `UplinkAck` is emitted only after the referenced sequence data is
   durable in the regional PostgreSQL data plane. It confirms receipt, not
   console-side processing, SSE publication, or external webhook completion.
5. A `CommandReceipt` means the edge has durably recorded a command for
   deduplication. It does **not** mean the command ran successfully. Only the
   sequenced `CommandResult` completes a command.
6. Redis may disappear, restart, or lose Pub/Sub messages without losing an
   accepted upstream event or a persisted command intent.

## Frame and connection state

Only binary MessagePack WebSocket frames are valid. The schema sets a 1 MiB
encoded frame limit, 16 KiB control-payload limit, a 30 s edge ping interval,
and a 90 s cloud idle timeout. Per-message compression is disabled. The edge
must send `Resume` within 10 s of a successful mTLS handshake.

Every network connection in this protocol is TLS 1.3 only: minimum version
TLS 1.3, maximum version TLS 1.3, and no TLS 1.2-or-lower fallback. WSS requires
mTLS, including normal server certificate validation and device-certificate
validation/revocation checks. The allowed TLS 1.3 cipher suites are exactly
`TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`, and
`TLS_AES_128_GCM_SHA256`; TLS 1.3 suites outside that list are disabled.

TLS 0-RTT is disabled on the WSS endpoint. No protocol envelope may be carried
as TLS early data, especially not `CommandDeliver`, `CommandReceipt`,
`CommandResult`, `UplinkGap`, or any future non-idempotent message. A reconnect
must complete a normal 1-RTT TLS handshake and mTLS verification before
application data is accepted. `SelfUpdate` artifact retrieval also uses HTTPS
with TLS 1.3 only and does not use early data.

`connection_id` is a new random UUID for each WSS connection. The gateway
keeps at most one active connection per device. A newer successful `Resume`
supersedes the old connection; the old connection receives `ProtocolError`
when possible and is closed. This prevents a stale TCP connection from sending
late acknowledgements or commands after a reconnect.

```
edge                                      gateway / regional data plane
----                                      ------------------------------
mTLS WSS connect  --------------------->  authenticate certificate + region
Resume(connection_id, local cursors) --->  read durable ingress state
ResumeAck(committed_through, holes) <----  bind active connection
replay outstanding sequenced events ---->  insert/deduplicate transactionally
UplinkAck(contiguous prefix) <----------  only after commit
CommandDeliver(cmd_id) <----------------  load persisted command intent
CommandReceipt(delivery_id) ----------->  record durable edge acceptance
CommandResult(cmd_id) ----------------->  transition command terminal state
```

If the certificate's region does not match the gateway region, authentication
fails before `Resume`. If the device's sequence journal was lost or cannot be
reconciled, the gateway returns `ProtocolError(sequence_state_invalid)` and
closes the connection. The edge must enter `reprovision_required`; it must not
restart at sequence `1` under the existing `device_id`.

## Upstream sequencing, acknowledgement, and holes

### Edge-side durable outbox

When an edge event is produced, the edge transaction assigns the next `seq`,
creates a stable envelope UUID, stores the complete encoded logical event in
SQLite, and commits. Only then may the uplink worker send it. For received SMS,
this transaction occurs before the modem storage entry is acknowledged or
deleted.

The outbox contains all `SmsReceived`, `DeviceState`, `CommandResult`,
`EsimInventory`, and `Alert` envelopes. State snapshots may later be coalesced
for display, but their sequence journal records must remain intact so a state
event can never create an unexplained hole. `CommandResult` records and
verification-code SMS are high-priority and are never capacity-evicted.

### Cloud-side durable ingress

The cloud transactionally records each accepted envelope in a per-device
ingress journal keyed by `(device_id, seq)`, plus the domain row or state
projection it drives. Its behavior is:

- an unseen `(device_id, seq)` is inserted and processed;
- a retry with the same stable envelope ID and identical content is a no-op;
- the same `(device_id, seq)` with different content or a different envelope
  ID is a `sequence_conflict` integrity incident, not a last-write-wins update;
- after the transaction, the cloud advances `committed_through` across every
  contiguous durable event and accepted loss marker, then sends `UplinkAck`.

The `messages(device_id, seq)` uniqueness constraint from the blueprint stays
mandatory for SMS. The ingress journal is broader because it also makes
`CommandResult`, state, inventory, and alerts replay-safe.

An acknowledgement is cumulative. Given received sequences `1, 2, 4, 5`, the
cloud may persist all four, but it acknowledges only `committed_through = 2`
and reports `[3, 3]` in `missing_ranges`. The edge deletes only locally stored
records with `seq <= committed_through`. It consequently retains `4` and `5`
until the hole is resolved, which is deliberate and makes crash/reconnect
semantics simple.

`missing_ranges` is capped at 128 ranges. It improves recovery latency but is
only a hint: on a reconnect the edge must replay every retained event above the
cumulative cursor in ascending order, subject to `max_in_flight`, even if a
range does not appear in that bounded list. `more_missing = true` means the
cloud has omitted additional hints, not that the edge may discard data.

### Reconnect and resume

`Resume` gives the cloud the edge's last allocated sequence, lowest retained
unacknowledged sequence, locally observed acknowledgement cursor, and pending
loss notices. The cloud reads its own durable cursor rather than trusting those
values, then returns `ResumeAck` with the authoritative cursor and recovery
window.

The edge resends outstanding `UplinkGap` notices first, then transmits retained
sequenced messages from `committed_through + 1` in ascending order. It may
prioritize an explicitly requested missing range only when doing so does not
violate the configured in-flight bound. After any disconnect, the same steps
restart; receiving no acknowledgement is indistinguishable from the peer not
receiving the frame.

The cloud must persist `connection_id` only as session/routing state, never as
the identity of an event. Acks for a stale connection ID are ignored by the
edge. Sequence state is keyed only by the stable `device_id` and regional data
plane.

### Explicit data-loss declaration

The blueprint permits capacity eviction only for the oldest non-verification
messages and requires an alert. That exception cannot coexist with a cumulative
acknowledgement protocol unless the resulting holes are explicit.

Before evicting an unacknowledged record, the edge writes a durable
`UplinkGap(gap_id, ranges, reason, ...)` record. It retries that non-sequenced
notice until the cloud durably accepts it with `UplinkGapAck`. The cloud stores
an audit record and treats exactly those ranges as intentional loss markers;
only then may it advance `committed_through` across them. The edge retains the
gap notice until its acknowledgement, and emits a sequenced `Alert` where
capacity allows.

Gap ranges must be exact, sorted, non-overlapping records that were actually
evicted. They cannot cover retained verification-code SMS, command results, or
other protected control records. A non-contiguous eviction is represented as
several ranges and may use multiple gap notices. An unaccepted notice must not
be forgotten merely because a later connection succeeds.

This is an audited loss path, not a claim of zero loss under exhausted storage.
Normal operation guarantees at-least-once delivery; operators need capacity
alerts well before the eviction policy can activate.

## Downstream command delivery

Commands have three deliberately separate facts: the console accepted the
intent, the edge accepted the command durably, and the hardware operation
finished. They must never be collapsed into one WebSocket response.

```
console/API                  PostgreSQL + outbox        Redis/gateway              edge SQLite + modem
-----------                  --------------------        -------------              -------------------
create command  ---------->  command + outbox COMMIT
                              lease pending outbox
                              publish wake-up  ------->  locate active connection
                                                          CommandDeliver --------->  persist cmd_id
                                                          <-------- CommandReceipt   no execution claim
                              persist receipt
                                                          retry same cmd_id if needed
                                                          <-------- CommandResult    persist terminal result
                              mark terminal
```

### Persist first; Redis only wakes work

In one PostgreSQL transaction, the API inserts the command intent and a durable
outbox row. The transaction commits before any Redis publish or gateway send.
An outbox dispatcher leases due rows and may publish a small wake-up containing
the command/device identity to `cmd:{node_id}`. The payload is not authoritative
in Redis; the gateway loads the command from PostgreSQL before it sends it.

There are three recovery paths for a lost Redis message, a Redis outage, or a
gateway restart:

1. the dispatcher periodically scans due, unleased, or expired-lease outbox
   rows and retries them;
2. a gateway queries durable pending commands when a device successfully
   resumes; and
3. retry scheduling uses the command's durable status and expiry timestamp,
   never a Pub/Sub acknowledgement.

Thus Redis improves latency and routes work to the current gateway node, but
cannot be the only copy of a command or the only trigger that sends one. Redis
loss must not block upstream PostgreSQL writes or active edge connections.

### Receipt, deduplication, and result

`CommandDeliver` uses its envelope `id` as `delivery_id` and its payload's
`cmd_id` as the logical command identity. The cloud may send multiple delivery
IDs for one `cmd_id`. Before replying, the edge stores the command keyed by
`cmd_id` in SQLite:

- first receipt: persist the command and reply `CommandReceipt(accepted)`;
- repeat with the same `cmd_id`: do not execute again, reply
  `CommandReceipt(duplicate)`;
- temporarily unable to persist: reply `CommandReceipt(retry_later)` with a
  bounded retry time, without starting the operation.

The gateway persists the receipt against the command attempt, but it does not
mark the command succeeded. The edge writes a terminal result to its sequenced
outbox and repeatedly sends `CommandResult` until cumulative upstream ack
removes that record. The cloud makes `cmd_id` terminal exactly once; a duplicate
result is a no-op if identical and an integrity incident if contradictory.

For physical side effects, exactly-once execution cannot be proven across a
process or modem crash after the hardware action begins. The edge must persist
`executing` before invoking the modem. If it restarts with an operation whose
physical outcome is unknown, it must not automatically repeat a non-idempotent
action such as `SendSms` or eSIM profile switching. It emits
`CommandResult(status = unknown)` for reconciliation. This avoids silently
sending duplicate SMS while preserving a truthful command history.

The cloud retries delivery only until a durable `accepted`/`duplicate` receipt
or command expiry. It never invents a new `cmd_id` for a retry. Expiry is
enforced by both sides; an edge that accepts an already-expired delivery records
a terminal `CommandResult(status = expired)` rather than executing it.

## Failure behavior

| Failure | Required behavior |
| --- | --- |
| Edge crashes after SQLite outbox commit, before send | Reconnect and send the original envelope ID and sequence. |
| Gateway crashes after DB commit, before `UplinkAck` | Edge retransmits; database deduplication makes it a no-op. |
| Cloud receives sequence after a hole | Persist it, do not cumulatively ack past the hole, request/replay the missing range. |
| Edge has evicted a needed sequence | Durable `UplinkGap`/`UplinkGapAck` records the loss; there is no silent cursor jump. |
| Redis is unavailable | Upstream continues to write PostgreSQL; commands remain in the durable outbox and are delivered by scans or resume. |
| WebSocket closes after `CommandDeliver` | Retry the same `cmd_id`; edge deduplication handles a received-but-unacknowledged delivery. |
| Edge crashes after modem side effect starts | Do not auto-repeat non-idempotent work; produce an `unknown` terminal result after recovery. |
| Same sequence with different data | Log tenant/device/trace context, send `ProtocolError(sequence_conflict)` when possible, close the connection, and investigate. |

## Required tests before implementation is called complete

1. Send `1, 2, 4, 5`, disconnect, then send `3`; verify no local records above
   `2` are deleted until the cloud advances through `5`.
2. Simulate a cloud commit followed by a gateway crash before the ack; replay
   the event and prove there is one domain row and one ingress record.
3. Simulate edge storage exhaustion with protected and non-protected records;
   verify only eligible records create exact accepted gap ranges and an audit
   trail.
4. Drop the Redis wake-up and restart a gateway; verify a committed command is
   delivered from the PostgreSQL outbox after scan or device resume.
5. Drop a `CommandReceipt`; redeliver the command and verify the edge does not
   execute it twice.
6. Crash the edge after it marks `SendSms` executing; verify recovery produces
   an `unknown` result rather than a second send.
7. Attempt a connection with a valid certificate for another device or region;
   verify no frame reaches domain handling.
