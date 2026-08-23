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

	if err := store.SettleOutbound(
		ctx, "t", commandID, "failed", "no_service", nil,
	); err != nil {
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
	_ = store.SettleOutbound(ctx, "t", commandID, "sent", "", nil)
	_ = store.SettleOutbound(ctx, "t", commandID, "failed", "late duplicate", nil)

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

// A network delivery report is not the command receipt.
//
// The receipt says the modem took the message; this says the recipient got it.
// They arrive minutes apart on different paths, and before this the second one
// had nowhere to land -- a sent message stayed "sent" forever whether it
// arrived or not.
func TestDeliveryIsAStateBeyondSent(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	commandID := "cmd-1"
	_ = store.RecordOutbound(ctx, "t", Message{DeviceID: "d1", Peer: "10086",
		Body: "hi", CommandID: &commandID})

	reference := 42
	if err := store.SettleOutbound(ctx, "t", commandID, "sent", "", &reference); err != nil {
		t.Fatal(err)
	}
	thread, _ := store.Thread(ctx, "t", "10086", 0)
	if thread[0].Status != "sent" {
		t.Fatalf("status = %q, want sent before any report", thread[0].Status)
	}
	if thread[0].DeliveredAt != nil {
		t.Fatal("a message the modem merely accepted has not been delivered")
	}

	store.ApplyStatusReport("t", "10086", reference, "delivered", 9_000)
	thread, _ = store.Thread(ctx, "t", "10086", 0)
	if thread[0].Status != "delivered" {
		t.Fatalf("status = %q, want delivered", thread[0].Status)
	}
	if thread[0].DeliveredAt == nil || *thread[0].DeliveredAt != 9_000 {
		t.Fatal("the discharge time from the report is what says when")
	}
}

// The network taking a message and then failing to hand it over is a different
// outcome from the modem refusing it. Reporting both as "failed" would tell an
// operator to resend in a case where resending changes nothing.
func TestAnUndeliveredMessageIsNotAFailedSend(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	commandID := "cmd-1"
	_ = store.RecordOutbound(ctx, "t", Message{DeviceID: "d1", Peer: "10086",
		Body: "hi", CommandID: &commandID})
	reference := 7
	_ = store.SettleOutbound(ctx, "t", commandID, "sent", "", &reference)
	store.ApplyStatusReport("t", "10086", reference, "failed", 0)

	thread, _ := store.Thread(ctx, "t", "10086", 0)
	if thread[0].Status != "undelivered" {
		t.Fatalf("status = %q, want undelivered", thread[0].Status)
	}
}

// A report quoting a reference this device never used must settle nothing.
// TP-MR is eight bits and wraps, so a report matching by number alone is how a
// delivery lands on an unrelated conversation.
func TestAReportForAnUnknownReferenceSettlesNothing(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	commandID := "cmd-1"
	_ = store.RecordOutbound(ctx, "t", Message{DeviceID: "d1", Peer: "10086",
		Body: "hi", CommandID: &commandID})
	reference := 7
	_ = store.SettleOutbound(ctx, "t", commandID, "sent", "", &reference)

	store.ApplyStatusReport("t", "10086", 8, "delivered", 9_000)
	store.ApplyStatusReport("t", "10010", 7, "delivered", 9_000)

	thread, _ := store.Thread(ctx, "t", "10086", 0)
	if thread[0].Status != "sent" {
		t.Fatalf("status = %q, want sent: neither report was about this message",
			thread[0].Status)
	}
}

func TestUnreadCountsInboundUntilTheThreadIsOpened(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	store.Seed("t", Message{DeviceID: "d1", Direction: "inbound", Peer: "10086",
		Body: "one", Status: "received", ReceivedAt: 1000})
	store.Seed("t", Message{DeviceID: "d1", Direction: "inbound", Peer: "10086",
		Body: "two", Status: "received", ReceivedAt: 2000})
	// An outbound message is not something the operator can leave unread.
	store.Seed("t", Message{DeviceID: "d1", Direction: "outbound", Peer: "10086",
		Body: "reply", Status: "sent", ReceivedAt: 3000})

	threads, _ := store.Threads(ctx, "t")
	if threads[0].Unread != 2 {
		t.Fatalf("unread = %d, want 2", threads[0].Unread)
	}

	marked, err := store.MarkThreadRead(ctx, "t", "10086")
	if err != nil {
		t.Fatal(err)
	}
	if marked != 2 {
		t.Fatalf("marked %d, want 2", marked)
	}
	threads, _ = store.Threads(ctx, "t")
	if threads[0].Unread != 0 {
		t.Fatalf("unread = %d after opening the thread, want 0", threads[0].Unread)
	}

	// Reading twice must not report work it did not do: the console shows
	// this count.
	marked, _ = store.MarkThreadRead(ctx, "t", "10086")
	if marked != 0 {
		t.Fatalf("marked %d on a second pass, want 0", marked)
	}
}

func TestAContactNamesItsConversation(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	store.Seed("t", Message{DeviceID: "d1", Direction: "inbound", Peer: "10086",
		Body: "one", Status: "received", ReceivedAt: 1000})

	threads, _ := store.Threads(ctx, "t")
	if threads[0].Name != "" {
		t.Fatal("an unnamed number must come back unnamed, not filled in")
	}

	if err := store.SaveContact(ctx, "t", Contact{Peer: "10086", Name: "中国移动"}); err != nil {
		t.Fatal(err)
	}
	threads, _ = store.Threads(ctx, "t")
	if threads[0].Name != "中国移动" {
		t.Fatalf("name = %q", threads[0].Name)
	}

	// A contact outlives the conversation. The name took effort to write down
	// and the messages did not.
	if _, err := store.DeleteThread(ctx, "t", "10086"); err != nil {
		t.Fatal(err)
	}
	contacts, _ := store.Contacts(ctx, "t")
	if len(contacts) != 1 || contacts[0].Name != "中国移动" {
		t.Fatalf("contacts = %+v, want the name to survive", contacts)
	}
}
