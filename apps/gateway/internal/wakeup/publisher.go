// Package wakeup is the non-durable Redis routing layer.
//
// PostgreSQL remains the source of truth for uplink and commands. This package
// only publishes presence, command wake-ups, and tenant event hints. A missing,
// slow, or failing broker must never block Accept or UplinkAck.
package wakeup

import (
	"context"
	"errors"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
)

const (
	// HintTimeout is the budget for one non-durable Redis call. Exceeding it is
	// a lost hint, not a failed Accept.
	HintTimeout = 200 * time.Millisecond
	// PresenceTTL is how long device:{id}:node survives without a refresh.
	// It matches the WSS idle timeout so a silent connection expires together
	// with its routing hint.
	PresenceTTL = 90 * time.Second
)

var (
	// ErrInvalid indicates a wakeup call is missing required identity fields.
	ErrInvalid = errors.New("invalid wakeup")
	// ErrUnavailable indicates the broker was down, timed out, or had no live node.
	ErrUnavailable = errors.New("wakeup broker unavailable")
)

// Event is a best-effort notice that a new sequenced uplink row exists.
// It must not carry the durable payload; subscribers load that from PostgreSQL.
type Event struct {
	TenantID   string
	DeviceID   string
	EnvelopeID string
	Kind       string
	Seq        uint64
}

// Publisher is the gateway-facing hint API. Implementations must fail fast.
type Publisher interface {
	dispatch.WakeupPublisher
	RegisterDevice(ctx context.Context, deviceID string) error
	PublishEvent(ctx context.Context, event Event) error
}

// Nop is used when REDIS_URL is unset. Every call succeeds and does nothing.
type Nop struct{}

// PublishWakeup implements dispatch.WakeupPublisher.
func (Nop) PublishWakeup(context.Context, dispatch.Wakeup) error { return nil }

// RegisterDevice implements Publisher.
func (Nop) RegisterDevice(context.Context, string) error { return nil }

// PublishEvent implements Publisher.
func (Nop) PublishEvent(context.Context, Event) error { return nil }

// Failing always returns ErrUnavailable. Callers must treat it like a down
// Redis: Accept and UplinkAck still succeed.
type Failing struct{}

// PublishWakeup implements dispatch.WakeupPublisher.
func (Failing) PublishWakeup(context.Context, dispatch.Wakeup) error { return ErrUnavailable }

// RegisterDevice implements Publisher.
func (Failing) RegisterDevice(context.Context, string) error { return ErrUnavailable }

// PublishEvent implements Publisher.
func (Failing) PublishEvent(context.Context, Event) error { return ErrUnavailable }

// Maybe returns Nop when publisher is nil so session code can call unconditionally.
func Maybe(publisher Publisher) Publisher {
	if publisher == nil {
		return Nop{}
	}
	return publisher
}

// DeviceNodeKey is the ephemeral presence mapping device:{id}:node.
func DeviceNodeKey(deviceID string) string {
	return "device:" + deviceID + ":node"
}

// CommandChannel is the per-gateway command wake-up channel cmd:{node_id}.
func CommandChannel(nodeID string) string {
	return "cmd:" + nodeID
}

// EventChannel is the per-tenant uplink notice channel evt:{tenant_id}.
func EventChannel(tenantID string) string {
	return "evt:" + tenantID
}

var (
	_ Publisher                = Nop{}
	_ Publisher                = Failing{}
	_ dispatch.WakeupPublisher = Nop{}
	_ dispatch.WakeupPublisher = Failing{}
)
