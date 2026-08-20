package dispatch

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestPollOutboxPublishesOnlyWakeupsAndReschedulesFailures(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC)
	store := &fakeOutboxStore{items: []OutboxItem{
		{ID: 10, Command: testCommand("cmd-ok"), Attempt: 1},
		{ID: 11, Command: testCommand("cmd-retry"), Attempt: 2},
	}}
	wakeups := &fakeWakeupPublisher{errors: map[string]error{"cmd-retry": errors.New("broker unavailable")}}
	dispatcher := newTestDispatcher(t, store, &fakeCommandStore{}, wakeups, &fakeDeliverer{}, &fakeDeliveryIDs{})

	report, err := dispatcher.PollOutbox(context.Background(), "tenant-1", now)
	if err != nil {
		t.Fatalf("PollOutbox() error = %v", err)
	}
	if report.Claimed != 2 || report.Published != 1 || report.Retried != 1 || report.Expired != 0 {
		t.Fatalf("PollOutbox() report = %+v, want claimed=2 published=1 retried=1 expired=0", report)
	}
	if got, want := wakeups.wakeups, []Wakeup{{TenantID: "tenant-1", DeviceID: "device-1", CommandID: "cmd-ok"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("published wakeups = %#v, want %#v", got, want)
	}
	if got, want := store.claims, []claimCall{{tenantID: "tenant-1", workerID: "dispatcher-a", at: now, limit: 10}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("outbox claims = %#v, want %#v", got, want)
	}
	if got, want := store.published, []publishedCall{{tenantID: "tenant-1", outboxID: 10, workerID: "dispatcher-a", at: now}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("published records = %#v, want %#v", got, want)
	}
	if got, want := store.retries, []retryCall{{tenantID: "tenant-1", outboxID: 11, workerID: "dispatcher-a", at: now.Add(2 * time.Second), reason: "broker unavailable"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("retry records = %#v, want %#v", got, want)
	}
}

func TestPollOutboxRejectsClaimOutsideRequestedTenant(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC)
	otherTenantCommand := testCommand("cmd-other-tenant")
	otherTenantCommand.TenantID = "tenant-2"
	store := &fakeOutboxStore{items: []OutboxItem{{ID: 10, Command: otherTenantCommand, Attempt: 1}}}
	wakeups := &fakeWakeupPublisher{}
	dispatcher := newTestDispatcher(t, store, &fakeCommandStore{}, wakeups, &fakeDeliverer{}, &fakeDeliveryIDs{})

	report, err := dispatcher.PollOutbox(context.Background(), "tenant-1", now)
	if !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("PollOutbox() error = %v, want ErrInvalidCommand", err)
	}
	if report.Claimed != 1 || report.Published != 0 || report.Retried != 0 || len(report.Errors) != 1 {
		t.Fatalf("PollOutbox() report = %+v, want one rejected claim and no mutation", report)
	}
	if len(wakeups.wakeups) != 0 || len(store.published) != 0 || len(store.retries) != 0 || len(store.expired) != 0 {
		t.Fatalf("outbox mismatch caused mutations: wakeups=%#v published=%#v retries=%#v expired=%#v", wakeups.wakeups, store.published, store.retries, store.expired)
	}
}

func TestDispatchPendingForDeviceRecoversWithoutWakeupAndUsesNewDeliveryID(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC)
	command := testCommand("cmd-1")
	commands := &fakeCommandStore{pendingResponses: [][]PendingCommand{
		{{Command: command, Attempt: 1}},
		{{Command: command, Attempt: 2}},
	}}
	deliverer := &fakeDeliverer{}
	dispatcher := newTestDispatcher(t, &fakeOutboxStore{}, commands, &fakeWakeupPublisher{}, deliverer, &fakeDeliveryIDs{ids: []string{"delivery-1", "delivery-2"}})

	first, err := dispatcher.DispatchPendingForDevice(context.Background(), "tenant-1", "device-1", now)
	if err != nil {
		t.Fatalf("first DispatchPendingForDevice() error = %v", err)
	}
	second, err := dispatcher.DispatchPendingForDevice(context.Background(), "tenant-1", "device-1", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("second DispatchPendingForDevice() error = %v", err)
	}
	if first.Loaded != 1 || first.Delivered != 1 || second.Loaded != 1 || second.Delivered != 1 {
		t.Fatalf("reports = first=%+v second=%+v, want one delivery in each pass", first, second)
	}

	want := []Delivery{
		{DeliveryID: "delivery-1", Command: command, Attempt: 1},
		{DeliveryID: "delivery-2", Command: command, Attempt: 2},
	}
	if got := deliverer.deliveries; !reflect.DeepEqual(got, want) {
		t.Fatalf("deliveries = %#v, want %#v", got, want)
	}
	wantAttempts := []deliveryAttemptCall{
		{tenantID: "tenant-1", delivery: want[0]},
		{tenantID: "tenant-1", delivery: want[1]},
	}
	if got := commands.recordedAttempts; !reflect.DeepEqual(got, wantAttempts) {
		t.Fatalf("persisted attempts = %#v, want %#v", got, wantAttempts)
	}
	if len(commands.pendingCalls) != 2 {
		t.Fatalf("PendingForDevice calls = %d, want 2; wakeup must not be required", len(commands.pendingCalls))
	}
}

func TestDispatchPendingForDeviceLeavesFailedDeliveryDurableForRetry(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC)
	command := testCommand("cmd-1")
	commands := &fakeCommandStore{pendingResponses: [][]PendingCommand{{{Command: command, Attempt: 1}}}}
	deliverer := &fakeDeliverer{err: errors.New("connection closed")}
	dispatcher := newTestDispatcher(t, &fakeOutboxStore{}, commands, &fakeWakeupPublisher{}, deliverer, &fakeDeliveryIDs{ids: []string{"delivery-1"}})

	report, err := dispatcher.DispatchPendingForDevice(context.Background(), "tenant-1", "device-1", now)
	if err == nil {
		t.Fatal("DispatchPendingForDevice() error = nil, want delivery failure")
	}
	if report.Delivered != 0 || len(report.Errors) != 1 {
		t.Fatalf("report = %+v, want no completed delivery and one error", report)
	}
	if len(commands.recordedAttempts) != 1 {
		t.Fatalf("persisted attempts = %d, want 1", len(commands.recordedAttempts))
	}
	if len(commands.expired) != 0 {
		t.Fatalf("expired commands = %#v, want none", commands.expired)
	}
}

func TestDispatchPendingForDeviceExpiresCommandsBeforeSending(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC)
	expired := testCommand("cmd-expired")
	expired.ExpiresAt = now
	commands := &fakeCommandStore{pendingResponses: [][]PendingCommand{{{Command: expired, Attempt: 1}}}}
	deliverer := &fakeDeliverer{}
	dispatcher := newTestDispatcher(t, &fakeOutboxStore{}, commands, &fakeWakeupPublisher{}, deliverer, &fakeDeliveryIDs{})

	report, err := dispatcher.DispatchPendingForDevice(context.Background(), "tenant-1", "device-1", now)
	if err != nil {
		t.Fatalf("DispatchPendingForDevice() error = %v", err)
	}
	if report.Expired != 1 || report.Delivered != 0 {
		t.Fatalf("report = %+v, want one expiry and no delivery", report)
	}
	if got, want := commands.expired, []tenantCommandCall{{tenantID: "tenant-1", commandID: "cmd-expired"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("expired commands = %#v, want %#v", got, want)
	}
	if len(deliverer.deliveries) != 0 {
		t.Fatalf("deliveries = %#v, want none", deliverer.deliveries)
	}
}

func TestRecordReceiptDerivesDurableRetryEffects(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC)
	commands := &fakeCommandStore{receiptResult: ReceiptApplyResult{Duplicate: true}}
	dispatcher := newTestDispatcher(t, &fakeOutboxStore{}, commands, &fakeWakeupPublisher{}, &fakeDeliverer{}, &fakeDeliveryIDs{})

	retryReceipt := Receipt{
		ID:         "receipt-1",
		CommandID:  "cmd-1",
		DeliveryID: "delivery-1",
		Status:     ReceiptRetryLater,
		ReceivedAt: now.Add(-time.Minute),
		RetryAfter: 3 * time.Second,
	}
	result, decision, err := dispatcher.RecordReceipt(context.Background(), "tenant-1", retryReceipt, now)
	if err != nil {
		t.Fatalf("RecordReceipt() error = %v", err)
	}
	if !result.Duplicate {
		t.Fatal("RecordReceipt() Duplicate = false, want true from durable replay")
	}
	if decision.StopDelivery || !decision.RetryAt.Equal(now.Add(3*time.Second)) {
		t.Fatalf("retry decision = %+v, want retry at %s", decision, now.Add(3*time.Second))
	}
	if got, want := commands.receipts, []receiptCall{{tenantID: "tenant-1", receipt: retryReceipt, decision: decision}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("stored receipts = %#v, want %#v", got, want)
	}

	accepted := retryReceipt
	accepted.ID = "receipt-2"
	accepted.Status = ReceiptAccepted
	accepted.RetryAfter = 0
	_, decision, err = dispatcher.RecordReceipt(context.Background(), "tenant-1", accepted, now)
	if err != nil {
		t.Fatalf("RecordReceipt(accepted) error = %v", err)
	}
	if !decision.StopDelivery || !decision.RetryAt.IsZero() {
		t.Fatalf("accepted decision = %+v, want delivery stop", decision)
	}
}

func TestEvaluateTerminalResultIsIdempotentButRejectsConflicts(t *testing.T) {
	t.Parallel()

	completed := time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC)
	result := CommandResult{
		CommandID:   "cmd-1",
		Status:      ResultUnknown,
		CompletedAt: completed,
		Attempts:    1,
		ReasonCode:  "outcome_unknown",
		Details:     []byte(`{"modem":"restarting"}`),
	}

	applied, err := EvaluateTerminalResult(nil, result)
	if err != nil || applied != ResultInserted {
		t.Fatalf("EvaluateTerminalResult(nil, result) = (%v, %v), want (%v, nil)", applied, err, ResultInserted)
	}
	applied, err = EvaluateTerminalResult(&result, result)
	if err != nil || applied != ResultDuplicate {
		t.Fatalf("EvaluateTerminalResult(result, result) = (%v, %v), want (%v, nil)", applied, err, ResultDuplicate)
	}

	conflicting := result
	conflicting.Status = ResultSucceeded
	_, err = EvaluateTerminalResult(&result, conflicting)
	if !errors.Is(err, ErrConflictingTerminalResult) {
		t.Fatalf("EvaluateTerminalResult(conflicting) error = %v, want ErrConflictingTerminalResult", err)
	}
}

func TestRecordResultPassesAuthenticatedTenantToDurableStore(t *testing.T) {
	t.Parallel()

	completed := time.Date(2026, time.August, 20, 10, 0, 0, 0, time.UTC)
	terminal := CommandResult{
		CommandID:   "cmd-1",
		Status:      ResultSucceeded,
		CompletedAt: completed,
		Attempts:    1,
	}
	commands := &fakeCommandStore{resultResult: ResultDuplicate}
	dispatcher := newTestDispatcher(t, &fakeOutboxStore{}, commands, &fakeWakeupPublisher{}, &fakeDeliverer{}, &fakeDeliveryIDs{})

	applied, err := dispatcher.RecordResult(context.Background(), "tenant-1", terminal)
	if err != nil {
		t.Fatalf("RecordResult() error = %v", err)
	}
	if applied != ResultDuplicate {
		t.Fatalf("RecordResult() applied = %v, want %v", applied, ResultDuplicate)
	}
	if got, want := commands.results, []resultCall{{tenantID: "tenant-1", result: terminal}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("stored results = %#v, want %#v", got, want)
	}
}

func testCommand(id string) Command {
	issued := time.Date(2026, time.August, 20, 9, 0, 0, 0, time.UTC)
	return Command{
		TenantID:  "tenant-1",
		ID:        id,
		DeviceID:  "device-1",
		Kind:      "send_sms",
		Payload:   []byte(`{"peer":"15550000000","body":"test"}`),
		IssuedAt:  issued,
		ExpiresAt: issued.Add(2 * time.Hour),
	}
}

func newTestDispatcher(t *testing.T, outbox OutboxStore, commands CommandStore, wakeups WakeupPublisher, deliverer DeviceDeliverer, ids DeliveryIDSource) *Dispatcher {
	t.Helper()
	dispatcher, err := New(Dependencies{
		Outbox:      outbox,
		Commands:    commands,
		Wakeups:     wakeups,
		Deliverer:   deliverer,
		DeliveryIDs: ids,
		WorkerID:    "dispatcher-a",
		BatchSize:   10,
		WakeupRetryWait: func(attempt int) time.Duration {
			return time.Duration(attempt) * time.Second
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return dispatcher
}

type fakeOutboxStore struct {
	items     []OutboxItem
	claims    []claimCall
	published []publishedCall
	retries   []retryCall
	expired   []tenantCommandCall
}

func (s *fakeOutboxStore) ClaimDue(_ context.Context, tenantID, workerID string, at time.Time, limit int) ([]OutboxItem, error) {
	s.claims = append(s.claims, claimCall{tenantID: tenantID, workerID: workerID, at: at, limit: limit})
	return s.items, nil
}

func (s *fakeOutboxStore) MarkWakeupPublished(_ context.Context, tenantID string, outboxID int64, workerID string, at time.Time) error {
	s.published = append(s.published, publishedCall{tenantID: tenantID, outboxID: outboxID, workerID: workerID, at: at})
	return nil
}

func (s *fakeOutboxStore) RetryWakeup(_ context.Context, tenantID string, outboxID int64, workerID string, at time.Time, reason string) error {
	s.retries = append(s.retries, retryCall{tenantID: tenantID, outboxID: outboxID, workerID: workerID, at: at, reason: reason})
	return nil
}

func (s *fakeOutboxStore) ExpireCommand(_ context.Context, tenantID, commandID string, _ time.Time) error {
	s.expired = append(s.expired, tenantCommandCall{tenantID: tenantID, commandID: commandID})
	return nil
}

type claimCall struct {
	tenantID string
	workerID string
	at       time.Time
	limit    int
}

type publishedCall struct {
	tenantID string
	outboxID int64
	workerID string
	at       time.Time
}

type retryCall struct {
	tenantID string
	outboxID int64
	workerID string
	at       time.Time
	reason   string
}

type tenantCommandCall struct {
	tenantID  string
	commandID string
}

type fakeCommandStore struct {
	pendingResponses [][]PendingCommand
	pendingCalls     []pendingCall
	recordedAttempts []deliveryAttemptCall
	expired          []tenantCommandCall
	receipts         []receiptCall
	receiptResult    ReceiptApplyResult
	results          []resultCall
	resultResult     ResultApplyResult
}

func (s *fakeCommandStore) PendingForDevice(_ context.Context, tenantID, deviceID string, at time.Time, limit int) ([]PendingCommand, error) {
	s.pendingCalls = append(s.pendingCalls, pendingCall{tenantID: tenantID, deviceID: deviceID, at: at, limit: limit})
	if len(s.pendingResponses) == 0 {
		return nil, nil
	}
	response := s.pendingResponses[0]
	s.pendingResponses = s.pendingResponses[1:]
	return response, nil
}

func (s *fakeCommandStore) RecordDeliveryAttempt(_ context.Context, tenantID string, delivery Delivery, _ time.Time) error {
	s.recordedAttempts = append(s.recordedAttempts, deliveryAttemptCall{tenantID: tenantID, delivery: delivery})
	return nil
}

func (s *fakeCommandStore) ExpireCommand(_ context.Context, tenantID, commandID string, _ time.Time) error {
	s.expired = append(s.expired, tenantCommandCall{tenantID: tenantID, commandID: commandID})
	return nil
}

func (s *fakeCommandStore) ApplyReceipt(_ context.Context, tenantID string, receipt Receipt, decision ReceiptDecision) (ReceiptApplyResult, error) {
	s.receipts = append(s.receipts, receiptCall{tenantID: tenantID, receipt: receipt, decision: decision})
	return s.receiptResult, nil
}

func (s *fakeCommandStore) ApplyTerminalResult(_ context.Context, tenantID string, result CommandResult) (ResultApplyResult, error) {
	s.results = append(s.results, resultCall{tenantID: tenantID, result: result})
	return s.resultResult, nil
}

type pendingCall struct {
	tenantID string
	deviceID string
	at       time.Time
	limit    int
}

type receiptCall struct {
	tenantID string
	receipt  Receipt
	decision ReceiptDecision
}

type deliveryAttemptCall struct {
	tenantID string
	delivery Delivery
}

type resultCall struct {
	tenantID string
	result   CommandResult
}

type fakeWakeupPublisher struct {
	wakeups []Wakeup
	errors  map[string]error
}

func (p *fakeWakeupPublisher) PublishWakeup(_ context.Context, wakeup Wakeup) error {
	if err := p.errors[wakeup.CommandID]; err != nil {
		return err
	}
	p.wakeups = append(p.wakeups, wakeup)
	return nil
}

type fakeDeliverer struct {
	deliveries []Delivery
	err        error
}

func (d *fakeDeliverer) DeliverCommand(_ context.Context, delivery Delivery) error {
	d.deliveries = append(d.deliveries, delivery)
	return d.err
}

type fakeDeliveryIDs struct {
	ids []string
}

func (s *fakeDeliveryIDs) NextDeliveryID() (string, error) {
	if len(s.ids) == 0 {
		return "", errors.New("no delivery IDs available")
	}
	id := s.ids[0]
	s.ids = s.ids[1:]
	return id, nil
}
