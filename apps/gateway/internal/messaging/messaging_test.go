package messaging

import (
	"context"
	"testing"
)

func TestAConversationHasBothHalves(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	store.Seed("t", Message{
		DeviceID: "d1", Direction: "inbound", Peer: "10086",
		Body: "余额 12.34 元", Status: "received", ReceivedAt: 1000,
	})
	commandID := "cmd-1"
	if err := store.RecordOutbound(ctx, "t", Message{
		DeviceID: "d1", Peer: "10086", Body: "CXYE", CommandID: &commandID,
		ReceivedAt: 2000,
	}); err != nil {
		t.Fatal(err)
	}

	thread, err := store.Thread(ctx, "t", "10086", 0)
	if err != nil {
		t.Fatal(err)
	}
	// Before outbound messages were recorded, this returned one message and
	// the console showed a conversation with half of it missing.
	if len(thread) != 2 {
		t.Fatalf("thread has %d messages, want both halves", len(thread))
	}
	if thread[0].Direction != "inbound" || thread[1].Direction != "outbound" {
		t.Fatalf("thread is out of order: %+v", thread)
	}
	if thread[1].Status != "queued" {
		t.Fatalf("a message not yet sent should say so, got %q", thread[1].Status)
	}
}

// The device's answer is what turns "queued" into an answer to "did it arrive".
func TestASendIsSettledByWhatTheDeviceReported(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	commandID := "cmd-1"
	_ = store.RecordOutbound(ctx, "t", Message{DeviceID: "d1", Peer: "10086",
		Body: "hi", CommandID: &commandID})

	if err := store.SettleOutbound(ctx, "t", commandID, "failed", "no_service"); err != nil {
		t.Fatal(err)
	}
	thread, _ := store.Thread(ctx, "t", "10086", 0)
	if thread[0].Status != "failed" {
		t.Fatalf("status = %q, want failed", thread[0].Status)
	}
	if thread[0].FailureReason == nil || *thread[0].FailureReason != "no_service" {
		t.Fatal("the reason a send failed is the useful half")
	}
}

// A command can be redelivered, and the edge deduplicates by cmd_id. The
// conversation must not gain a second copy of the same message.
func TestARedeliveredCommandDoesNotDuplicateTheMessage(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	commandID := "cmd-1"
	for i := 0; i < 3; i++ {
		_ = store.RecordOutbound(ctx, "t", Message{DeviceID: "d1", Peer: "10086",
			Body: "hi", CommandID: &commandID})
	}
	thread, _ := store.Thread(ctx, "t", "10086", 0)
	if len(thread) != 1 {
		t.Fatalf("thread has %d copies of one message", len(thread))
	}
}

// A settled message must not be re-settled by a later duplicate result.
func TestSettlingIsOnlyForSomethingStillWaiting(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	commandID := "cmd-1"
	_ = store.RecordOutbound(ctx, "t", Message{DeviceID: "d1", Peer: "10086",
		Body: "hi", CommandID: &commandID})
	_ = store.SettleOutbound(ctx, "t", commandID, "sent", "")
	_ = store.SettleOutbound(ctx, "t", commandID, "failed", "late duplicate")

	thread, _ := store.Thread(ctx, "t", "10086", 0)
	if thread[0].Status != "sent" {
		t.Fatalf("status = %q, want the first terminal result to stand", thread[0].Status)
	}
}

func TestThreadsAreListedMostRecentFirstWithUnsentCounted(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	store.Seed("t", Message{DeviceID: "d1", Direction: "inbound", Peer: "10086",
		Body: "old", Status: "received", ReceivedAt: 1000})
	store.Seed("t", Message{DeviceID: "d1", Direction: "outbound", Peer: "10010",
		Body: "stuck", Status: "failed", ReceivedAt: 5000})

	threads, err := store.Threads(ctx, "t")
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 2 {
		t.Fatalf("threads = %d, want 2", len(threads))
	}
	if threads[0].Peer != "10010" {
		t.Fatalf("first thread = %s, want the most recent", threads[0].Peer)
	}
	// A conversation with something stuck in it is the one worth opening.
	if threads[0].Unsent != 1 {
		t.Fatalf("unsent = %d, want 1", threads[0].Unsent)
	}
	if threads[1].Unsent != 0 {
		t.Fatalf("a received message is not unsent")
	}
}

func TestDeletingAThreadSaysHowMuchWent(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		store.Seed("t", Message{DeviceID: "d1", Direction: "inbound", Peer: "10086",
			Body: "x", Status: "received", ReceivedAt: int64(i)})
	}
	removed, err := store.DeleteThread(ctx, "t", "10086")
	if err != nil {
		t.Fatal(err)
	}
	if removed != 3 {
		t.Fatalf("removed = %d, want 3", removed)
	}
	// A delete that matched nothing looks exactly like one that worked.
	again, _ := store.DeleteThread(ctx, "t", "10086")
	if again != 0 {
		t.Fatalf("second delete removed %d", again)
	}
}
