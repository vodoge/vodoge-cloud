package events

import "testing"

func TestPublishDoesNotBlockWhenNobodyListens(t *testing.T) {
	t.Parallel()
	bus := NewBus()
	bus.Publish("t1", "sms")
}

func TestSubscribeReceivesOnlyItsTenant(t *testing.T) {
	t.Parallel()
	bus := NewBus()
	ch, cancel := bus.Subscribe("t1")
	t.Cleanup(cancel)
	bus.Publish("t2", "other")
	bus.Publish("t1", "mine")
	got := <-ch
	if got != "mine" {
		t.Fatalf("got %q", got)
	}
	select {
	case extra := <-ch:
		t.Fatalf("unexpected extra %q", extra)
	default:
	}
}
