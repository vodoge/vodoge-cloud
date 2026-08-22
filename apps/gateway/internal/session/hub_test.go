package session

import (
	"testing"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
)

func TestBindSupersedesPreviousConnection(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	device := identity.Device{TenantID: "t1", DeviceID: "dev-1", Region: "cn"}
	now := time.Now()
	previous := hub.Bind(Connection{ID: "conn-a", Device: device, ConnectedAt: now, LastPacketAt: now})
	if previous != nil {
		t.Fatal("first bind must not supersede anyone")
	}

	old := hub.Bind(Connection{ID: "conn-b", Device: device, ConnectedAt: now, LastPacketAt: now})
	if old == nil || old.ID != "conn-a" {
		t.Fatalf("superseded = %+v, want conn-a", old)
	}
	got, ok := hub.Lookup("dev-1")
	if !ok || got.ID != "conn-b" {
		t.Fatalf("lookup = %+v, want conn-b", got)
	}
	if hub.Touch("conn-a", now.Add(time.Second)) {
		t.Fatal("superseded connection must not refresh idle time")
	}
	if !hub.Touch("conn-b", now.Add(time.Second)) {
		t.Fatal("active connection must accept a heartbeat")
	}
}

func TestSweepIdleUnbindsSilentDevices(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	now := time.Now()
	hub.Bind(Connection{
		ID:           "conn-1",
		Device:       identity.Device{DeviceID: "dev-1", TenantID: "t", Region: "intl"},
		ConnectedAt:  now,
		LastPacketAt: now.Add(-IdleTimeout - time.Second),
	})
	hub.Bind(Connection{
		ID:           "conn-2",
		Device:       identity.Device{DeviceID: "dev-2", TenantID: "t", Region: "intl"},
		ConnectedAt:  now,
		LastPacketAt: now,
	})

	expired := hub.SweepIdle(now)
	if len(expired) != 1 || expired[0].ID != "conn-1" {
		t.Fatalf("expired = %+v", expired)
	}
	if _, ok := hub.Lookup("dev-1"); ok {
		t.Fatal("idle device must be unbound")
	}
	if _, ok := hub.Lookup("dev-2"); !ok {
		t.Fatal("fresh device must remain")
	}
}

func TestUnbindIgnoresSupersededConnection(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	device := identity.Device{TenantID: "t", DeviceID: "dev-1", Region: "cn"}
	now := time.Now()
	hub.Bind(Connection{ID: "conn-a", Device: device, ConnectedAt: now, LastPacketAt: now})
	hub.Bind(Connection{ID: "conn-b", Device: device, ConnectedAt: now, LastPacketAt: now})

	if hub.Unbind("conn-a") {
		t.Fatal("superseded connection must not unbind the live session")
	}
	got, ok := hub.Lookup("dev-1")
	if !ok || got.ID != "conn-b" {
		t.Fatalf("lookup after stale unbind = %+v", got)
	}
	if !hub.Unbind("conn-b") {
		t.Fatal("live connection must unbind")
	}
	if _, ok := hub.Lookup("dev-1"); ok {
		t.Fatal("device must be offline after live unbind")
	}
}

// The hub hands back a closer so the caller can actually end the connection it
// replaced. Carrying only bookkeeping is what left a superseded session running
// against a socket the device had abandoned.
func TestBindReturnsACloserForTheSupersededConnection(t *testing.T) {
	hub := NewHub()
	closed := false

	hub.Bind(Connection{
		ID:     "first",
		Device: identity.Device{DeviceID: "device-1"},
		Close:  func() { closed = true },
	})
	previous := hub.Bind(Connection{
		ID:     "second",
		Device: identity.Device{DeviceID: "device-1"},
		Close:  func() {},
	})

	if previous == nil {
		t.Fatal("binding over a live connection returned no previous connection")
	}
	if previous.ID != "first" {
		t.Fatalf("previous connection = %q, want %q", previous.ID, "first")
	}
	if previous.Close == nil {
		t.Fatal("previous connection carries no closer, so nothing can end it")
	}
	previous.Close()
	if !closed {
		t.Fatal("the returned closer did not close the connection it came from")
	}
}

// Same requirement on the reaping path: a device that vanishes without
// reconnecting supersedes nothing, so the sweep is the only thing that ends it.
func TestSweepIdleReturnsClosersForExpiredConnections(t *testing.T) {
	hub := NewHub()
	closed := false
	start := time.Now()

	hub.Bind(Connection{
		ID:           "stale",
		Device:       identity.Device{DeviceID: "device-1"},
		LastPacketAt: start,
		Close:        func() { closed = true },
	})

	expired := hub.SweepIdle(start.Add(IdleTimeout + time.Second))
	if len(expired) != 1 {
		t.Fatalf("swept %d connections, want 1", len(expired))
	}
	if expired[0].Close == nil {
		t.Fatal("expired connection carries no closer")
	}
	expired[0].Close()
	if !closed {
		t.Fatal("the returned closer did not close the connection it came from")
	}
}
