package wakeup

import (
	"context"
	"errors"
	"testing"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
)

func TestNopSucceedsAndFailingDoesNot(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	hint := dispatch.Wakeup{TenantID: "t", DeviceID: "d", CommandID: "c"}
	event := Event{TenantID: "t", DeviceID: "d", EnvelopeID: "e", Kind: "SmsReceived", Seq: 1}

	var nop Nop
	if err := nop.PublishWakeup(ctx, hint); err != nil {
		t.Fatalf("Nop.PublishWakeup() = %v", err)
	}
	if err := nop.RegisterDevice(ctx, "d"); err != nil {
		t.Fatalf("Nop.RegisterDevice() = %v", err)
	}
	if err := nop.PublishEvent(ctx, event); err != nil {
		t.Fatalf("Nop.PublishEvent() = %v", err)
	}

	var failing Failing
	if err := failing.PublishWakeup(ctx, hint); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Failing.PublishWakeup() = %v, want ErrUnavailable", err)
	}
	if err := failing.RegisterDevice(ctx, "d"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Failing.RegisterDevice() = %v, want ErrUnavailable", err)
	}
	if err := failing.PublishEvent(ctx, event); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Failing.PublishEvent() = %v, want ErrUnavailable", err)
	}
}

func TestMaybeNilIsNop(t *testing.T) {
	t.Parallel()

	if err := Maybe(nil).PublishEvent(context.Background(), Event{}); err != nil {
		t.Fatalf("Maybe(nil).PublishEvent() = %v", err)
	}
	if err := Maybe(Failing{}).PublishEvent(context.Background(), Event{}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Maybe(Failing).PublishEvent() = %v, want ErrUnavailable", err)
	}
}

func TestChannelNames(t *testing.T) {
	t.Parallel()

	if got, want := DeviceNodeKey("dev-1"), "device:dev-1:node"; got != want {
		t.Fatalf("DeviceNodeKey() = %q, want %q", got, want)
	}
	if got, want := CommandChannel("gw-a"), "cmd:gw-a"; got != want {
		t.Fatalf("CommandChannel() = %q, want %q", got, want)
	}
	if got, want := EventChannel("tenant-1"), "evt:tenant-1"; got != want {
		t.Fatalf("EventChannel() = %q, want %q", got, want)
	}
}
