package wakeup

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
)

func TestDialRejectsEmptyURLAndNode(t *testing.T) {
	t.Parallel()

	if _, err := Dial("", "gw-a"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Dial empty url = %v, want ErrInvalid", err)
	}
	if _, err := Dial("redis://127.0.0.1:6379/0", ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Dial empty node = %v, want ErrInvalid", err)
	}
	if _, err := Dial("://not-a-url", "gw-a"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Dial bad url = %v, want ErrInvalid", err)
	}
}

func TestRedisRegisterDeviceSetsTTL(t *testing.T) {
	t.Parallel()

	broker := newMemoryBroker()
	client := &Redis{broker: broker, nodeID: "gw-a", ttl: 90 * time.Second}
	if err := client.RegisterDevice(context.Background(), "dev-1"); err != nil {
		t.Fatal(err)
	}
	if got := broker.kv[DeviceNodeKey("dev-1")]; got != "gw-a" {
		t.Fatalf("presence = %q, want gw-a", got)
	}
	if got := broker.ttl[DeviceNodeKey("dev-1")]; got != 90*time.Second {
		t.Fatalf("ttl = %s, want 90s", got)
	}
}

func TestRedisPublishWakeupUsesDeviceNodeHint(t *testing.T) {
	t.Parallel()

	broker := newMemoryBroker()
	broker.kv[DeviceNodeKey("dev-1")] = "gw-a"
	client := &Redis{broker: broker, nodeID: "gw-b", ttl: time.Minute}

	err := client.PublishWakeup(context.Background(), dispatch.Wakeup{
		TenantID:  "tenant-1",
		DeviceID:  "dev-1",
		CommandID: "cmd-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(broker.published) != 1 {
		t.Fatalf("published = %d, want 1", len(broker.published))
	}
	got := broker.published[0]
	if got.channel != CommandChannel("gw-a") {
		t.Fatalf("channel = %q, want cmd:gw-a", got.channel)
	}
	var payload commandHint
	if err := json.Unmarshal(got.message, &payload); err != nil {
		t.Fatal(err)
	}
	if payload != (commandHint{TenantID: "tenant-1", DeviceID: "dev-1", CommandID: "cmd-1"}) {
		t.Fatalf("payload = %+v", payload)
	}
	if string(got.message) != `{"tenant_id":"tenant-1","device_id":"dev-1","command_id":"cmd-1"}` {
		t.Fatalf("raw payload = %s", got.message)
	}
}

func TestRedisPublishWakeupFailsWhenDeviceUnregistered(t *testing.T) {
	t.Parallel()

	client := &Redis{broker: newMemoryBroker(), nodeID: "gw-a", ttl: time.Minute}
	err := client.PublishWakeup(context.Background(), dispatch.Wakeup{
		TenantID: "t", DeviceID: "offline", CommandID: "c",
	})
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("error = %v, want ErrUnavailable", err)
	}
}

func TestRedisPublishEventUsesTenantChannel(t *testing.T) {
	t.Parallel()

	broker := newMemoryBroker()
	client := &Redis{broker: broker, nodeID: "gw-a", ttl: time.Minute}
	err := client.PublishEvent(context.Background(), Event{
		TenantID:   "tenant-1",
		DeviceID:   "dev-1",
		EnvelopeID: "env-1",
		Kind:       "SmsReceived",
		Seq:        7,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(broker.published) != 1 || broker.published[0].channel != EventChannel("tenant-1") {
		t.Fatalf("published = %+v, want evt:tenant-1", broker.published)
	}
	var payload eventHint
	if err := json.Unmarshal(broker.published[0].message, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Seq != "7" || payload.Kind != "SmsReceived" {
		t.Fatalf("payload = %+v", payload)
	}
}

func TestRedisBrokerErrorsSurfaceAsUnavailable(t *testing.T) {
	t.Parallel()

	broker := newMemoryBroker()
	broker.setErr = errors.New("connection reset")
	broker.pubErr = errors.New("pubsub down")
	client := &Redis{broker: broker, nodeID: "gw-a", ttl: time.Minute}

	if err := client.RegisterDevice(context.Background(), "dev-1"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("RegisterDevice() = %v, want ErrUnavailable", err)
	}
	if err := client.PublishEvent(context.Background(), Event{
		TenantID: "t", DeviceID: "d", EnvelopeID: "e", Kind: "Alert", Seq: 1,
	}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("PublishEvent() = %v, want ErrUnavailable", err)
	}
}

type published struct {
	channel string
	message []byte
}

type memoryBroker struct {
	mu        sync.Mutex
	kv        map[string]string
	ttl       map[string]time.Duration
	published []published
	pingErr   error
	getErr    error
	setErr    error
	pubErr    error
}

func newMemoryBroker() *memoryBroker {
	return &memoryBroker{
		kv:  make(map[string]string),
		ttl: make(map[string]time.Duration),
	}
}

func (b *memoryBroker) Ping(context.Context) error { return b.pingErr }

func (b *memoryBroker) Get(_ context.Context, key string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.getErr != nil {
		return "", b.getErr
	}
	return b.kv[key], nil
}

func (b *memoryBroker) Set(_ context.Context, key, value string, ttl time.Duration) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.setErr != nil {
		return b.setErr
	}
	b.kv[key] = value
	b.ttl[key] = ttl
	return nil
}

func (b *memoryBroker) Publish(_ context.Context, channel string, message []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pubErr != nil {
		return b.pubErr
	}
	copied := append([]byte(nil), message...)
	b.published = append(b.published, published{channel: channel, message: copied})
	return nil
}

func (b *memoryBroker) Close() error { return nil }
