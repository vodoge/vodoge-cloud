# Edge-cloud contract

`schema/edge-cloud.v1.schema.json` is the only authoritative definition of the
edge-to-cloud application protocol. It describes the logical MessagePack map
carried in one binary WSS frame. Its JSON form exists so standard JSON Schema
tools and language generators can consume it; the runtime does not send JSON.

The application frames use `vodoge.edge.v1` as their WebSocket subprotocol. A
connection is authenticated by mTLS before any application frame is accepted.
The `device_id` in every envelope must equal the device identity in that
certificate; `tenant_id` is intentionally absent from the wire contract.

## Transport security

All network traffic defined by this contract uses WSS with mutual TLS and TLS
1.3 **only**. Both the minimum and maximum protocol version are TLS 1.3; TLS
1.2 and lower are not fallback options. The only permitted TLS 1.3 cipher
suites are `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`, and
`TLS_AES_128_GCM_SHA256`. Server certificate validation is mandatory.

TLS early data (0-RTT) is disabled for the WSS connection. In particular, no
application envelope, command, acknowledgement, or message with a possible
side effect may be sent as early data because it could be replayed. The same
TLS 1.3-only policy applies when an edge follows the HTTPS artifact URL in a
`SelfUpdate` command.

## Source-of-truth rules

- Do not hand-maintain Rust, Go, and TypeScript protocol structures. Generate
  them from this schema or from an intermediate representation generated from
  this schema.
- Generated validators must enforce standard JSON Schema constraints and every
  `x-vodoge-invariant` / `x-vodoge-wire-type` annotation. JSON Schema alone
  cannot compare decimal strings as unsigned 64-bit numbers.
- `seq`, acknowledgement cursors, and range boundaries are canonical decimal
  strings on the wire. This avoids JavaScript number precision loss while still
  representing the blueprint's `u64` range exactly. Rust and Go bindings should
  expose `u64`; TypeScript should expose a branded string or `bigint` adapter.
- The MessagePack encoder must use the field names from the schema, reject
  unknown fields, and preserve `seq` as a string. It must reject a frame whose
  encoded size exceeds `x-vodoge-contract.wire.max_frame_bytes` before decoding
  unbounded nested data.
- `id` is stable across retries of the same envelope. A resend must retain the
  original `id` and, for sequenced messages, the original `seq`.

## Compatibility policy

Protocol v1 is closed: unknown fields and kinds are rejected. Additive fields
are therefore a versioned change unless they are introduced as an explicitly
defined optional field in this schema. Any incompatible change creates a new
`edge-cloud.v<N>.schema.json`, a new WebSocket subprotocol, and a negotiated
rollout plan; it must not silently alter v1 behavior.

The payload schemas intentionally use named definitions instead of an opaque
`bytes` field. In MessagePack this is still one envelope with a nested payload
map, while the nested shape remains available to validation and code generation.

## Required generated artifacts

Generated artifacts are committed:

- Go models in `go/`
- TypeScript types in `ts/`
- Rust models in `vodoge-edge/contract` from a copy of the same schema

Regenerate and fail CI on drift:

```sh
python3 packages/contract/codegen/generate.py --check \
  --go packages/contract/go/contract.go \
  --ts packages/contract/ts/index.ts
```

The state-machine semantics that those bindings must implement are in
[`../../docs/protocol-reliability.md`](../../docs/protocol-reliability.md).
