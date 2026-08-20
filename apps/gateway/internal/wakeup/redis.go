package wakeup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
)

// Redis publishes routing hints. It is never a durable store: lost publishes are
// recovered from PostgreSQL by outbox polling or device resume.
type Redis struct {
	broker broker
	nodeID string
	ttl    time.Duration
}

type broker interface {
	Ping(ctx context.Context) error
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	Publish(ctx context.Context, channel string, message []byte) error
	Close() error
}

type goRedisBroker struct {
	client *redis.Client
}

func (b goRedisBroker) Ping(ctx context.Context) error {
	return b.client.Ping(ctx).Err()
}

func (b goRedisBroker) Get(ctx context.Context, key string) (string, error) {
	value, err := b.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	return value, err
}

func (b goRedisBroker) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	return b.client.Set(ctx, key, value, ttl).Err()
}

func (b goRedisBroker) Publish(ctx context.Context, channel string, message []byte) error {
	return b.client.Publish(ctx, channel, message).Err()
}

func (b goRedisBroker) Close() error {
	return b.client.Close()
}

type commandHint struct {
	TenantID  string `json:"tenant_id"`
	DeviceID  string `json:"device_id"`
	CommandID string `json:"command_id"`
}

type eventHint struct {
	TenantID   string `json:"tenant_id"`
	DeviceID   string `json:"device_id"`
	EnvelopeID string `json:"envelope_id"`
	Kind       string `json:"kind"`
	Seq        string `json:"seq"`
}

// Dial builds a Redis publisher from REDIS_URL. Ping is left to the caller so a
// failed ping can log and continue without taking the process down.
func Dial(url, nodeID string) (*Redis, error) {
	url = strings.TrimSpace(url)
	nodeID = strings.TrimSpace(nodeID)
	if url == "" {
		return nil, fmt.Errorf("%w: REDIS_URL is empty", ErrInvalid)
	}
	if nodeID == "" {
		return nil, fmt.Errorf("%w: node ID is required", ErrInvalid)
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("%w: parse REDIS_URL: %v", ErrInvalid, err)
	}
	opts.MaxRetries = 0
	if opts.DialTimeout == 0 {
		opts.DialTimeout = 2 * time.Second
	}
	if opts.ReadTimeout == 0 {
		opts.ReadTimeout = time.Second
	}
	if opts.WriteTimeout == 0 {
		opts.WriteTimeout = time.Second
	}
	opts.ContextTimeoutEnabled = true
	return &Redis{
		broker: goRedisBroker{client: redis.NewClient(opts)},
		nodeID: nodeID,
		ttl:    PresenceTTL,
	}, nil
}

// Ping reports whether the broker currently answers. It is not used by /readyz.
func (r *Redis) Ping(ctx context.Context) error {
	if r == nil || r.broker == nil {
		return fmt.Errorf("%w: redis client is not configured", ErrInvalid)
	}
	if err := r.broker.Ping(ctx); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

// Close releases the underlying client.
func (r *Redis) Close() error {
	if r == nil || r.broker == nil {
		return nil
	}
	return r.broker.Close()
}

// PublishWakeup looks up device:{id}:node and publishes a small hint to
// cmd:{node_id}. The command payload is never placed on the channel.
func (r *Redis) PublishWakeup(ctx context.Context, hint dispatch.Wakeup) error {
	if err := r.ready(); err != nil {
		return err
	}
	switch {
	case strings.TrimSpace(hint.TenantID) == "":
		return fmt.Errorf("%w: tenant ID is required", ErrInvalid)
	case strings.TrimSpace(hint.DeviceID) == "":
		return fmt.Errorf("%w: device ID is required", ErrInvalid)
	case strings.TrimSpace(hint.CommandID) == "":
		return fmt.Errorf("%w: command ID is required", ErrInvalid)
	}

	nodeID, err := r.broker.Get(ctx, DeviceNodeKey(hint.DeviceID))
	if err != nil {
		return fmt.Errorf("%w: lookup device node: %v", ErrUnavailable, err)
	}
	if nodeID == "" {
		return fmt.Errorf("%w: device %s has no live node", ErrUnavailable, hint.DeviceID)
	}

	payload, err := json.Marshal(commandHint{
		TenantID:  hint.TenantID,
		DeviceID:  hint.DeviceID,
		CommandID: hint.CommandID,
	})
	if err != nil {
		return fmt.Errorf("%w: encode command hint: %v", ErrInvalid, err)
	}
	if err := r.broker.Publish(ctx, CommandChannel(nodeID), payload); err != nil {
		return fmt.Errorf("%w: publish cmd:%s: %v", ErrUnavailable, nodeID, err)
	}
	return nil
}

// RegisterDevice writes device:{id}:node = this gateway with a TTL.
func (r *Redis) RegisterDevice(ctx context.Context, deviceID string) error {
	if err := r.ready(); err != nil {
		return err
	}
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return fmt.Errorf("%w: device ID is required", ErrInvalid)
	}
	if err := r.broker.Set(ctx, DeviceNodeKey(deviceID), r.nodeID, r.presenceTTL()); err != nil {
		return fmt.Errorf("%w: register device %s: %v", ErrUnavailable, deviceID, err)
	}
	return nil
}

// PublishEvent notifies evt:{tenant_id} that a new sequenced uplink row exists.
func (r *Redis) PublishEvent(ctx context.Context, event Event) error {
	if err := r.ready(); err != nil {
		return err
	}
	switch {
	case strings.TrimSpace(event.TenantID) == "":
		return fmt.Errorf("%w: tenant ID is required", ErrInvalid)
	case strings.TrimSpace(event.DeviceID) == "":
		return fmt.Errorf("%w: device ID is required", ErrInvalid)
	case strings.TrimSpace(event.EnvelopeID) == "":
		return fmt.Errorf("%w: envelope ID is required", ErrInvalid)
	case strings.TrimSpace(event.Kind) == "":
		return fmt.Errorf("%w: kind is required", ErrInvalid)
	case event.Seq == 0:
		return fmt.Errorf("%w: seq is required", ErrInvalid)
	}

	payload, err := json.Marshal(eventHint{
		TenantID:   event.TenantID,
		DeviceID:   event.DeviceID,
		EnvelopeID: event.EnvelopeID,
		Kind:       event.Kind,
		Seq:        strconv.FormatUint(event.Seq, 10),
	})
	if err != nil {
		return fmt.Errorf("%w: encode event hint: %v", ErrInvalid, err)
	}
	if err := r.broker.Publish(ctx, EventChannel(event.TenantID), payload); err != nil {
		return fmt.Errorf("%w: publish evt:%s: %v", ErrUnavailable, event.TenantID, err)
	}
	return nil
}

func (r *Redis) ready() error {
	if r == nil || r.broker == nil {
		return fmt.Errorf("%w: redis client is not configured", ErrInvalid)
	}
	if strings.TrimSpace(r.nodeID) == "" {
		return fmt.Errorf("%w: node ID is required", ErrInvalid)
	}
	return nil
}

func (r *Redis) presenceTTL() time.Duration {
	if r != nil && r.ttl > 0 {
		return r.ttl
	}
	return PresenceTTL
}

var (
	_ Publisher                = (*Redis)(nil)
	_ dispatch.WakeupPublisher = (*Redis)(nil)
)
