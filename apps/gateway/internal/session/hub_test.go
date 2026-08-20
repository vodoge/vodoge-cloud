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
