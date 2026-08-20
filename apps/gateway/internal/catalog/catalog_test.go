package catalog

import (
	"context"
	"testing"
)

func TestEmptyStoreReturnsEmptySlices(t *testing.T) {
	t.Parallel()

	store := Empty{}
	devices, err := store.ListDevices(context.Background(), "t1")
	if err != nil || len(devices) != 0 {
		t.Fatalf("devices = %v err=%v", devices, err)
	}
	messages, err := store.ListMessages(context.Background(), "t1")
	if err != nil || len(messages) != 0 {
		t.Fatalf("messages = %v err=%v", messages, err)
	}
	sessions, err := store.ListSessions(context.Background(), "t1")
	if err != nil || len(sessions) != 0 {
		t.Fatalf("sessions = %v err=%v", sessions, err)
	}
}

func TestMemoryStoreIsTenantScoped(t *testing.T) {
	t.Parallel()

	store := &Memory{
		Devices: map[string][]Device{
			"t-a": {{ID: "d-a", Name: "lab-a", State: "online"}},
			"t-b": {{ID: "d-b", Name: "lab-b", State: "offline"}},
		},
		Messages: map[string][]Message{
			"t-a": {
				{ID: "m1", DeviceID: "d-a", Direction: "inbound", Peer: "10086", Body: "old", Bearer: "cellular", ReceivedAt: 1, Seq: 1},
				{ID: "m2", DeviceID: "d-a", Direction: "inbound", Peer: "10086", Body: "new", Bearer: "cellular", ReceivedAt: 2, Seq: 2},
				{ID: "m3", DeviceID: "d-a", Direction: "inbound", Peer: "95588", Body: "bank", Bearer: "ims", ReceivedAt: 3, Seq: 3},
			},
			"t-b": {
				{ID: "m9", DeviceID: "d-b", Direction: "inbound", Peer: "10086", Body: "other-tenant", Bearer: "cellular", ReceivedAt: 9, Seq: 1},
			},
		},
	}

	devices, err := store.ListDevices(context.Background(), "t-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].ID != "d-a" {
		t.Fatalf("devices = %+v", devices)
	}

	missing, err := store.ListDevices(context.Background(), "t-missing")
	if err != nil || len(missing) != 0 {
		t.Fatalf("missing tenant devices = %v err=%v", missing, err)
	}

	sessions, err := store.ListSessions(context.Background(), "t-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("sessions = %+v", sessions)
	}
	if sessions[0].Peer != "95588" || sessions[0].Count != 1 || sessions[0].LastBody != "bank" {
		t.Fatalf("newest session = %+v", sessions[0])
	}
	if sessions[1].Peer != "10086" || sessions[1].Count != 2 || sessions[1].LastBody != "new" {
		t.Fatalf("10086 session = %+v", sessions[1])
	}

	other, err := store.ListSessions(context.Background(), "t-b")
	if err != nil {
		t.Fatal(err)
	}
	if len(other) != 1 || other[0].LastBody != "other-tenant" {
		t.Fatalf("tenant b sessions leaked or missing: %+v", other)
	}
}

func TestSessionsFromOrdersByLastReceived(t *testing.T) {
	t.Parallel()

	got := SessionsFrom([]Message{
		{Peer: "b", Body: "1", ReceivedAt: 10, DeviceID: "d1"},
		{Peer: "a", Body: "2", ReceivedAt: 10, DeviceID: "d1"},
		{Peer: "b", Body: "3", ReceivedAt: 11, DeviceID: "d2"},
	})
	if len(got) != 2 {
		t.Fatalf("len = %d", len(got))
	}
	if got[0].Peer != "b" || got[0].Count != 2 || got[0].LastBody != "3" || got[0].DeviceID != "d2" {
		t.Fatalf("first = %+v", got[0])
	}
	if got[1].Peer != "a" || got[1].Count != 1 {
		t.Fatalf("second = %+v", got[1])
	}
}
