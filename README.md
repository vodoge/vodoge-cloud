# VoDoge Cloud

VoDoge Cloud is the multi-tenant control plane for VoDoge Edge devices.

## Design principles

- Devices connect outward through WSS; customer sites do not need inbound ports.
- Device connections use mTLS and TLS 1.3 only.
- PostgreSQL is the authoritative store; Redis is never the durable command queue.
- Tenant and region boundaries are enforced in the data plane.
- Commands, acknowledgements, and offline recovery are designed for at-least-once delivery.

## Status

The project is in active foundational development. The first milestones establish the protocol contract, TLS transport, tenant isolation, and reliable command-delivery semantics.

See the repository history for independently reviewable implementation slices.
