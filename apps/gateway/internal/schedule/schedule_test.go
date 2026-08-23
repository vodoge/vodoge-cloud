package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func quiet() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// smsTask is the keep-the-number schedule: one message to a service number on
// a fixed cadence, addressed by SIM rather than by module.
func smsTask(interval time.Duration, anchor time.Time) Task {
	return Task{
		Name:            "keepalive",
		Enabled:         true,
		Action:          ActionCommand,
		CommandKind:     "send_sms",
		Selector:        Selector{Mode: SelectorCard, ICCID: "8986003031401770106"},
		Request:         json.RawMessage(`{"to":"10086","body":"1"}`),
		IntervalSeconds: int(interval / time.Second),
		AnchorAt:        anchor,
	}
}

func bench() *Memory {
	return &Memory{
		Modems: map[string]Target{
			"8986003031401770106": {
				DeviceID:  "b0000000-0000-4000-8000-00000000000b",
				ModemIMEI: "867018069509705",
				ICCID:     "8986003031401770106",
			},
		},
		Devices:  map[string]bool{"b0000000-0000-4000-8000-00000000000b": true},
		Readings: map[string]PublicIPReading{},
	}
}

func runnerFor(store Store, now *time.Time) *Runner {
	return &Runner{
		Store:  store,
		Live:   func() map[string][]string { return map[string][]string{"t1": {"d1"}} },
		Owner:  "test",
		Now:    func() time.Time { return *now },
		Logger: quiet(),
	}
}

// The compressed-cadence proof, run against the clock instead of the bench.
//
// Two minutes for thirty minutes is fifteen occurrences. The tick runs four
// times a minute, so most ticks find nothing -- that is the point: a scheduler
// that fires on tick rather than on occurrence would produce 120 messages here.
func TestThirtyMinutesAtTwoMinutesProducesExactlyFifteenSends(t *testing.T) {
	store := bench()
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start
	runner := runnerFor(store, &now)
	taskID := store.Seed("t1", smsTask(2*time.Minute, start))

	for elapsed := time.Duration(0); elapsed <= 30*time.Minute; elapsed += 15 * time.Second {
		now = start.Add(elapsed)
		runner.Tick(context.Background())
	}

	issued := store.Issued["t1"]
	if len(issued) != 15 {
		t.Fatalf("want 15 commands over 30 minutes at 2-minute cadence, got %d", len(issued))
	}
	keys := map[string]int{}
	occurrences := map[int64]int{}
	for _, command := range issued {
		keys[command.IdempotencyKey]++
		occurrences[command.Occurrence]++
	}
	if len(keys) != 15 {
		t.Fatalf("want 15 distinct idempotency keys, got %d (%v)", len(keys), keys)
	}
	for occurrence := int64(1); occurrence <= 15; occurrence++ {
		if occurrences[occurrence] != 1 {
			t.Fatalf("occurrence %d was issued %d times, want exactly 1",
				occurrence, occurrences[occurrence])
		}
	}
	if got := IdempotencyKey(taskID, 1); issued[0].IdempotencyKey != got {
		t.Fatalf("first key %q, want %q", issued[0].IdempotencyKey, got)
	}
}

// A gateway restart is a lost tracker and a lost in-flight tick, not a lost
// occurrence.
//
// The restart is placed inside occurrence 8's window and the tracker is emptied
// the way a fresh process starts it, so the run has to survive both the gap and
// the repopulation. Fifteen in, fifteen out.
func TestARestartMidRunNeitherDoublesNorDropsASend(t *testing.T) {
	store := bench()
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start
	connected := true
	runner := &Runner{
		Store: store,
		Live: func() map[string][]string {
			if !connected {
				return map[string][]string{}
			}
			return map[string][]string{"t1": {"d1"}}
		},
		Owner:  "gateway-a",
		Now:    func() time.Time { return now },
		Logger: quiet(),
	}
	store.Seed("t1", smsTask(2*time.Minute, start))

	for elapsed := time.Duration(0); elapsed <= 30*time.Minute; elapsed += 15 * time.Second {
		now = start.Add(elapsed)
		// Down from 16:05 to 16:35: straddles occurrence 8, which falls at
		// 16:00, and covers the moment the container comes back with an empty
		// tracker before any device has resumed.
		connected = elapsed < 16*time.Minute+5*time.Second ||
			elapsed > 16*time.Minute+35*time.Second
		if !connected {
			// A new process also gets a new lease owner.
			runner.Owner = "gateway-b"
			continue
		}
		runner.Tick(context.Background())
	}

	issued := store.Issued["t1"]
	if len(issued) != 15 {
		t.Fatalf("want 15 commands across a restart, got %d", len(issued))
	}
	seen := map[string]bool{}
	for _, command := range issued {
		if seen[command.IdempotencyKey] {
			t.Fatalf("idempotency key %q was issued twice", command.IdempotencyKey)
		}
		seen[command.IdempotencyKey] = true
	}
}

// The property everything else rests on: replaying an occurrence produces the
// command that already exists, not a second one.
//
// Written against the store's own bookkeeping being rolled back, which is
// stronger than the transaction actually allows. If the derived key is ever
// replaced by anything that varies per call, this is the test that fails.
func TestReplayingAnOccurrenceProducesNoSecondCommand(t *testing.T) {
	store := bench()
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start.Add(2 * time.Minute)
	runner := runnerFor(store, &now)
	taskID := store.Seed("t1", smsTask(2*time.Minute, start))

	runner.Tick(context.Background())
	if len(store.Issued["t1"]) != 1 {
		t.Fatalf("want one command after the first occurrence, got %d", len(store.Issued["t1"]))
	}
	first := store.Issued["t1"][0]

	// Pretend the bookkeeping never landed: the task still owes occurrence 1.
	store.mu.Lock()
	store.find("t1", taskID).LastOccurrence = 0
	store.mu.Unlock()

	runner.Tick(context.Background())
	if got := len(store.Issued["t1"]); got != 1 {
		t.Fatalf("replaying occurrence 1 created %d commands, want 1", got)
	}
	store.mu.Lock()
	advanced := store.find("t1", taskID).LastOccurrence
	command := store.find("t1", taskID).LastCommandID
	store.mu.Unlock()
	if advanced != 1 {
		t.Fatalf("replay left last_occurrence at %d, want 1", advanced)
	}
	if command != first.CommandID {
		t.Fatalf("replay reported command %q, want the existing %q", command, first.CommandID)
	}
}

// A lease that lapses while a worker is still running is the reason the key has
// to be derived. Two workers, same occurrence, one command.
func TestALapsedLeaseCannotProduceASecondCommand(t *testing.T) {
	store := bench()
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start.Add(2 * time.Minute)
	store.Seed("t1", smsTask(2*time.Minute, start))

	// Worker A claims the occurrence with a lease so short it has already
	// lapsed, then stalls before doing anything with it.
	claims, err := store.ClaimDue(context.Background(), "t1", "gateway-a", now, time.Nanosecond, 8)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim: %v (%d claims)", err, len(claims))
	}
	// Worker B finds the lapsed lease, claims the same occurrence, and sends.
	fast := &Runner{
		Store: store, Owner: "gateway-b", Logger: quiet(),
		Live: func() map[string][]string { return map[string][]string{"t1": {"d1"}} },
		Now:  func() time.Time { return now },
	}
	fast.Tick(context.Background())
	// Worker A wakes up and finishes the occurrence it still believes it owns.
	slow := &Runner{
		Store: store, Owner: "gateway-a", Logger: quiet(),
		Now: func() time.Time { return now },
	}
	var report Report
	slow.run(context.Background(), "t1", claims[0], now, &report)

	if got := len(store.Issued["t1"]); got != 1 {
		t.Fatalf("two workers on one occurrence produced %d commands, want 1", got)
	}
}

// A payload that varies between two attempts at one occurrence breaks the only
// duplicate protection there is, so it is pinned rather than trusted.
func TestThePayloadForAnOccurrenceIsByteIdenticalEveryTime(t *testing.T) {
	task := smsTask(2*time.Minute, time.Now())
	target := Target{DeviceID: "d", ModemIMEI: "867018069509705"}
	first, err := buildRequest(task, target)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	second, err := buildRequest(task, target)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if string(first) != string(second) {
		t.Fatalf("payload is not stable across attempts:\n%s\n%s", first, second)
	}
	if strings.Contains(string(first), "2026") {
		t.Fatalf("payload carries what looks like a timestamp: %s", first)
	}
}

// The key names an occurrence and nothing else. Anything time-based, random or
// payload-derived here reintroduces double sending.
func TestIdempotencyKeyDependsOnlyOnTaskAndOccurrence(t *testing.T) {
	if a, b := IdempotencyKey("task-1", 7), IdempotencyKey("task-1", 7); a != b {
		t.Fatalf("same occurrence produced two keys: %q and %q", a, b)
	}
	if a, b := IdempotencyKey("task-1", 7), IdempotencyKey("task-1", 8); a == b {
		t.Fatalf("two occurrences share key %q", a)
	}
	if a, b := IdempotencyKey("task-1", 7), IdempotencyKey("task-2", 7); a == b {
		t.Fatalf("two tasks share key %q", a)
	}
}

// A failure before anything leaves the cloud is the only retryable one, and the
// occurrence must stay owed so the retry means something.
func TestAPreparationFailureLeavesTheOccurrenceOwedAndSendsNothing(t *testing.T) {
	store := bench()
	delete(store.Modems, "8986003031401770106") // the SIM is not in the inventory yet
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start.Add(2 * time.Minute)
	runner := runnerFor(store, &now)
	taskID := store.Seed("t1", smsTask(2*time.Minute, start))

	runner.Tick(context.Background())
	if got := len(store.Issued["t1"]); got != 0 {
		t.Fatalf("a preparation failure enqueued %d commands, want 0", got)
	}
	store.mu.Lock()
	task := *store.find("t1", taskID)
	store.mu.Unlock()
	if task.LastOccurrence != 0 {
		t.Fatalf("last_occurrence advanced to %d on a preparation failure", task.LastOccurrence)
	}
	if task.LastStatus != StatusPrepareFailed {
		t.Fatalf("last_status is %q, want %q", task.LastStatus, StatusPrepareFailed)
	}

	// The SIM appears. The same occurrence is retried and now succeeds.
	store.mu.Lock()
	store.Modems["8986003031401770106"] = Target{
		DeviceID: "b0000000-0000-4000-8000-00000000000b", ModemIMEI: "867018069509705",
	}
	store.mu.Unlock()
	runner.Tick(context.Background())
	if got := len(store.Issued["t1"]); got != 1 {
		t.Fatalf("retry after the target appeared produced %d commands, want 1", got)
	}
	if got := store.Issued["t1"][0].Occurrence; got != 1 {
		t.Fatalf("retry issued occurrence %d, want the one that was owed (1)", got)
	}
}

// An outage longer than the cadence must not turn into a burst of messages when
// the gateway comes back, and the skip must be visible rather than silent.
func TestOccurrencesOlderThanOnePeriodAreSkippedNotReplayed(t *testing.T) {
	store := bench()
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start
	runner := runnerFor(store, &now)
	taskID := store.Seed("t1", smsTask(2*time.Minute, start))

	// Nothing ran for an hour: thirty occurrences came and went.
	now = start.Add(time.Hour)
	runner.Tick(context.Background())
	if got := len(store.Issued["t1"]); got != 0 {
		t.Fatalf("catch-up sent %d messages, want 0", got)
	}
	store.mu.Lock()
	task := *store.find("t1", taskID)
	store.mu.Unlock()
	if task.LastStatus != StatusSkippedStale {
		t.Fatalf("last_status is %q, want %q", task.LastStatus, StatusSkippedStale)
	}
	if task.LastOccurrence != 29 {
		t.Fatalf("pointer moved to %d, want 29 so occurrence 30 fires next", task.LastOccurrence)
	}

	// The current occurrence is not stale, so it goes out on the very next tick
	// rather than after another full period of silence.
	now = start.Add(time.Hour + 15*time.Second)
	runner.Tick(context.Background())
	if got := len(store.Issued["t1"]); got != 1 {
		t.Fatalf("want one send once the pointer caught up, got %d", got)
	}
	if got := store.Issued["t1"][0].Occurrence; got != 30 {
		t.Fatalf("sent occurrence %d, want 30", got)
	}
}

// Editing a task while an occurrence is in flight must close that occurrence,
// never re-issue it under a fresh key.
func TestAnEditedPayloadClosesTheOccurrenceInsteadOfSendingAgain(t *testing.T) {
	store := bench()
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start.Add(2 * time.Minute)
	runner := runnerFor(store, &now)
	taskID := store.Seed("t1", smsTask(2*time.Minute, start))

	runner.Tick(context.Background())
	if got := len(store.Issued["t1"]); got != 1 {
		t.Fatalf("setup: want 1 command, got %d", got)
	}

	// The body changes and the same occurrence is somehow owed again.
	store.mu.Lock()
	task := store.find("t1", taskID)
	task.Request = json.RawMessage(`{"to":"10086","body":"2"}`)
	task.LastOccurrence = 0
	store.mu.Unlock()

	runner.Tick(context.Background())
	if got := len(store.Issued["t1"]); got != 1 {
		t.Fatalf("an edited payload produced %d commands for one occurrence, want 1", got)
	}
	store.mu.Lock()
	status := store.find("t1", taskID).LastStatus
	advanced := store.find("t1", taskID).LastOccurrence
	store.mu.Unlock()
	if status != StatusKeyConflict {
		t.Fatalf("last_status is %q, want %q", status, StatusKeyConflict)
	}
	if advanced != 1 {
		t.Fatalf("a key conflict left last_occurrence at %d, want 1", advanced)
	}
}

// L3: the sweep runs for every tenant the tick can see, whether or not that
// tenant owes a scheduled task.
func TestTheTickSweepsOverdueCommandsForEveryLiveTenant(t *testing.T) {
	store := bench()
	swept := map[string]int{}
	runner := &Runner{
		Store:  store,
		Owner:  "test",
		Logger: quiet(),
		Live: func() map[string][]string {
			return map[string][]string{"t1": {"d1"}, "t2": {"d2"}}
		},
		Sweep: func(_ context.Context, tenantID string, _ time.Time) (int, error) {
			swept[tenantID]++
			return 3, nil
		},
	}
	report := runner.Tick(context.Background())
	if swept["t1"] != 1 || swept["t2"] != 1 {
		t.Fatalf("sweep ran %v, want once per live tenant", swept)
	}
	if report.Expired != 6 {
		t.Fatalf("report says %d expired, want 6", report.Expired)
	}
}

// A tenant with nothing connected does not tick. Stated as a test because it is
// the cost of using live sessions as the tenant carrier, and a future change
// that quietly removes it should have to remove this too.
func TestATenantWithNoLiveDeviceDoesNotTick(t *testing.T) {
	store := bench()
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start.Add(2 * time.Minute)
	runner := &Runner{
		Store:  store,
		Owner:  "test",
		Logger: quiet(),
		Now:    func() time.Time { return now },
		Live:   func() map[string][]string { return map[string][]string{} },
	}
	store.Seed("t1", smsTask(2*time.Minute, start))
	if report := runner.Tick(context.Background()); report.Claimed != 0 {
		t.Fatalf("claimed %d tasks with no live tenant", report.Claimed)
	}
	if got := len(store.Issued["t1"]); got != 0 {
		t.Fatalf("issued %d commands with no live tenant", got)
	}
}

// A public IP check answers from what the edge already reported instead of
// spending a device round trip on it.
func TestAPublicIPCheckRecordsTheLastReportedAddress(t *testing.T) {
	store := bench()
	store.Readings["b0000000-0000-4000-8000-00000000000b"] = PublicIPReading{
		PublicIP: "203.0.113.9", ReportedAt: time.Unix(1700000000, 0).UTC(), Found: true,
	}
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start.Add(2 * time.Minute)
	runner := runnerFor(store, &now)
	taskID := store.Seed("t1", Task{
		Name:            "egress",
		Enabled:         true,
		Action:          ActionPublicIPCheck,
		Selector:        Selector{Mode: SelectorDevice, DeviceID: "b0000000-0000-4000-8000-00000000000b"},
		IntervalSeconds: 120,
		AnchorAt:        start,
	})

	runner.Tick(context.Background())
	if got := len(store.Issued["t1"]); got != 0 {
		t.Fatalf("a public IP check enqueued %d commands, want 0", got)
	}
	store.mu.Lock()
	task := *store.find("t1", taskID)
	store.mu.Unlock()
	if task.LastStatus != StatusChecked {
		t.Fatalf("last_status is %q, want %q", task.LastStatus, StatusChecked)
	}
	if !strings.Contains(string(task.LastDetail), "203.0.113.9") {
		t.Fatalf("detail does not carry the address: %s", task.LastDetail)
	}
}

func TestValidateRefusesWhatCannotSucceed(t *testing.T) {
	cases := []struct {
		name string
		task Task
		want string
	}{
		{
			name: "an SMS with no body",
			task: Task{
				Name: "n", Action: ActionCommand, CommandKind: "send_sms",
				Selector: Selector{Mode: SelectorCard, ICCID: "1"}, IntervalSeconds: 120,
				Request: json.RawMessage(`{"to":"10086"}`),
			},
			want: "body",
		},
		{
			name: "a destination that is not a number",
			task: Task{
				Name: "n", Action: ActionCommand, CommandKind: "send_sms",
				Selector: Selector{Mode: SelectorCard, ICCID: "1"}, IntervalSeconds: 120,
				Request: json.RawMessage(`{"to":"not a number","body":"1"}`),
			},
			want: "phone number",
		},
		{
			name: "a cadence faster than the tick can serve",
			task: Task{
				Name: "n", Action: ActionCommand, CommandKind: "send_sms",
				Selector: Selector{Mode: SelectorCard, ICCID: "1"}, IntervalSeconds: 30,
				Request: json.RawMessage(`{"to":"10086","body":"1"}`),
			},
			want: "interval_seconds",
		},
		{
			name: "a module command in device mode with no IMEI to use",
			task: Task{
				Name: "n", Action: ActionCommand, CommandKind: "modem_report",
				Selector:        Selector{Mode: SelectorDevice, DeviceID: "d"},
				IntervalSeconds: 3600,
			},
			want: "modem_imei",
		},
		{
			name: "a command kind that does not exist",
			task: Task{
				Name: "n", Action: ActionCommand, CommandKind: "dial",
				Selector: Selector{Mode: SelectorCard, ICCID: "1"}, IntervalSeconds: 3600,
			},
			want: "unsupported command kind",
		},
		{
			name: "no way to find a target",
			task: Task{
				Name: "n", Action: ActionCommand, CommandKind: "send_sms",
				Selector: Selector{Mode: "everything"}, IntervalSeconds: 3600,
				Request: json.RawMessage(`{"to":"10086","body":"1"}`),
			},
			want: "selector.mode",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			task := test.task
			err := Validate(&task)
			if err == nil {
				t.Fatalf("accepted a task that cannot succeed")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("reason %q does not mention %q", err.Error(), test.want)
			}
		})
	}
}

func TestValidateAcceptsTheKeepaliveShape(t *testing.T) {
	task := smsTask(2*time.Minute, time.Now())
	if err := Validate(&task); err != nil {
		t.Fatalf("rejected the keepalive schedule: %v", err)
	}
	check := Task{
		Name: "egress", Action: ActionPublicIPCheck,
		Selector: Selector{Mode: SelectorDevice, DeviceID: "d"}, IntervalSeconds: 3600,
	}
	if err := Validate(&check); err != nil {
		t.Fatalf("rejected a public IP check: %v", err)
	}
}

// A command TTL has to stay ahead of issued_at even when the tick fires late:
// app.commands has a CHECK on it, and a violation would be a database error
// raised inside the enqueue transaction.
func TestCommandTTLIsAlwaysPositiveAndBounded(t *testing.T) {
	for _, interval := range []int{60, 120, 3600, 86400, 604800} {
		ttl := commandTTL(interval)
		if ttl < 5*time.Minute || ttl > 30*time.Minute {
			t.Fatalf("interval %d gave a TTL of %s, want between 5m and 30m", interval, ttl)
		}
	}
}

func TestOccurrenceMathFloorsTowardsThePast(t *testing.T) {
	anchor := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		at   time.Time
		want int64
	}{
		{anchor, 0},
		{anchor.Add(119 * time.Second), 0},
		{anchor.Add(120 * time.Second), 1},
		{anchor.Add(121 * time.Second), 1},
		// An anchor in the future must not read as an occurrence already
		// reached; Go's integer division truncates towards zero, which would
		// say 0 here and make the task instantly due.
		{anchor.Add(-1 * time.Second), -1},
		{anchor.Add(-121 * time.Second), -2},
	}
	for _, test := range cases {
		if got := occurrenceAt(anchor, 120, test.at); got != test.want {
			t.Fatalf("occurrenceAt(%s) = %d, want %d", test.at, got, test.want)
		}
	}
}

func TestNextDueAtIsAWholeNumberOfPeriodsFromTheAnchor(t *testing.T) {
	anchor := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	task := Task{IntervalSeconds: 3600, AnchorAt: anchor, LastOccurrence: 5}
	if got, want := task.NextDueAt(), anchor.Add(6*time.Hour); !got.Equal(want) {
		t.Fatalf("next due %s, want %s", got, want)
	}
}

// A store error on the enqueue means nothing committed, so the occurrence stays
// owed -- and the retry is safe because it recomputes the same key.
func TestAFailedEnqueueLeavesTheOccurrenceOwed(t *testing.T) {
	base := bench()
	store := &failingFire{Memory: base, fail: true}
	start := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	now := start.Add(2 * time.Minute)
	runner := runnerFor(store, &now)
	taskID := base.Seed("t1", smsTask(2*time.Minute, start))

	runner.Tick(context.Background())
	base.mu.Lock()
	task := *base.find("t1", taskID)
	base.mu.Unlock()
	if task.LastOccurrence != 0 {
		t.Fatalf("a failed enqueue advanced the pointer to %d", task.LastOccurrence)
	}
	if task.LastStatus != StatusStoreFailed {
		t.Fatalf("last_status is %q, want %q", task.LastStatus, StatusStoreFailed)
	}

	store.fail = false
	runner.Tick(context.Background())
	if got := len(base.Issued["t1"]); got != 1 {
		t.Fatalf("retry produced %d commands, want 1", got)
	}
	if got := base.Issued["t1"][0].Occurrence; got != 1 {
		t.Fatalf("retry issued occurrence %d, want 1", got)
	}
}

// failingFire stands in for an enqueue transaction that does not commit.
type failingFire struct {
	*Memory
	fail bool
}

func (store *failingFire) Fire(ctx context.Context, tenantID string, plan Plan) (string, error) {
	if store.fail {
		return "", errors.New("connection reset by peer")
	}
	return store.Memory.Fire(ctx, tenantID, plan)
}
