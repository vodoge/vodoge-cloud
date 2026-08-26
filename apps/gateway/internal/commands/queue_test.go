package commands

import (
	"context"
	"database/sql/driver"
	"encoding/hex"
	"strings"
	"testing"
	"time"
)

// These are the properties the card policy path depends on and that nothing
// else can hold in place: the key is what app.enqueue_command deduplicates on,
// and the key is also where "how many attempts has this intent had" is stored.
// A ledger table would have needed a migration, a second query on the resume
// path, and its own answer to what happens when the two disagree.

const (
	testDevice  = "b0000000-0000-4000-8000-00000000000b"
	testVersion = "1-1787386215"
)

var testPayload = []byte(`{"kind":"UpdateCardPolicy","policy_version":"1-1787386215",` +
	`"policies":[{"iccid":"8985200014632179571","cellular_enabled":true,"vertical":"intl","apn":"cmnet"}]}`)

// The defect: the key used to end in time.Now().UnixNano(), so two pushes of
// one unchanged policy set were two commands that could never collapse onto
// each other -- app.enqueue_command deduplicates on (tenant_id,
// idempotency_key), and a key carrying a clock reading never repeats.
func TestACardPolicyKeyIsAFunctionOfTheIntentAndNothingElse(t *testing.T) {
	t.Parallel()

	first := CardPolicyKey(testDevice, testVersion, testPayload)
	time.Sleep(time.Millisecond)
	second := CardPolicyKey(testDevice, testVersion, testPayload)
	if first != second {
		t.Fatalf("the same intent produced two keys:\n  %s\n  %s\n"+
			"Anything time-dependent in here makes every push a new row", first, second)
	}
}

func TestACardPolicyKeySeparatesIntentsThatMustNotCollapse(t *testing.T) {
	t.Parallel()

	base := CardPolicyKey(testDevice, testVersion, testPayload)
	changed := []byte(strings.Replace(string(testPayload), "cmnet", "cmiot", 1))

	cases := map[string]string{
		"another device":  CardPolicyKey("d-other", testVersion, testPayload),
		"another version": CardPolicyKey(testDevice, "2-1787386300", testPayload),
		// The version is not enough on its own: cards.Version truncates to
		// whole seconds, so two edits inside one second share a version. Reusing
		// a key for a different payload is 23505 from app.enqueue_command, which
		// the console would see as a 500 on save.
		"another set in the same second": CardPolicyKey(testDevice, testVersion, changed),
	}
	for name, key := range cases {
		if key == base {
			t.Errorf("%s produced the same key as the original intent: %s", name, key)
		}
	}
}

// The attempt counter is read back off the key, so a key must never be
// mistakable for one that already carries a counter. It cannot be: the last
// segment is hex and 'r' is not a hex digit.
func TestACardPolicyKeyCannotBeMistakenForARedelivery(t *testing.T) {
	t.Parallel()

	key := CardPolicyKey(testDevice, testVersion, testPayload)
	fingerprint := key[strings.LastIndex(key, ":")+1:]
	if _, err := hex.DecodeString(fingerprint); err != nil {
		t.Fatalf("key fingerprint %q is not hex: %v", fingerprint, err)
	}
	if got := cardPolicyAttempts(key); got != 1 {
		t.Fatalf("attempts for a fresh key = %d, want 1", got)
	}
}

func TestAttemptsAreReadBackFromTheKeyThatCarriesThem(t *testing.T) {
	t.Parallel()

	cases := map[string]int{
		// What production holds: the old key ended in a nanosecond reading, so
		// it must still count as one attempt rather than as a counter.
		"update_card_policy:" + testDevice + ":1-1787386215:1787386215573111733": 1,
		CardPolicyKey(testDevice, testVersion, testPayload):                      1,
		"update_card_policy:d:1-2:abcd:r1":                                       2,
		"update_card_policy:d:1-2:abcd:r2":                                       3,
		"update_card_policy:d:1-2:abcd:r0":                                       1,
		"":                                                                       1,
	}
	for key, want := range cases {
		if got := cardPolicyAttempts(key); got != want {
			t.Errorf("cardPolicyAttempts(%q) = %d, want %d", key, got, want)
		}
	}
}

// Reviving a revival must replace the counter, not stack another one. Stacked
// suffixes would make the attempt unreadable and the bound unenforceable.
func TestARedeliveryKeyNamesTheAttemptWithoutStacking(t *testing.T) {
	t.Parallel()

	base := CardPolicyKey(testDevice, testVersion, testPayload)
	first := cardPolicyRevivalKey(base, 1)
	if first != base+":r1" {
		t.Fatalf("first redelivery key = %q, want %q", first, base+":r1")
	}
	second := cardPolicyRevivalKey(first, 2)
	if second != base+":r2" {
		t.Fatalf("second redelivery key = %q, want %q", second, base+":r2")
	}
	if again := cardPolicyRevivalKey(first, 1); again != first {
		t.Fatalf("the same attempt of the same intent produced two keys: %q and %q. "+
			"app.enqueue_command can only collapse a repeat onto the row it "+
			"already made if the key repeats", first, again)
	}
}

// The bound, at the level it is decided. planCardPolicyRedelivery is called on
// every pending check -- a few seconds apart for a connected device -- so its
// answer has to come from the stored row alone.
func TestTheRedeliveryDecisionIsBoundedAndStateful(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 26, 5, 11, 0, 0, time.UTC)
	lapsed := now.Add(-time.Hour)
	key := CardPolicyKey(testDevice, testVersion, testPayload)

	cases := []struct {
		name string
		row  cardPolicyRow
		want bool
	}{
		{"expired and never taken", cardPolicyRow{Key: key, Status: "expired", ExpiresAt: lapsed}, true},
		{"lapsed but not yet swept", cardPolicyRow{Key: key, Status: "queued", ExpiresAt: lapsed}, true},
		{"still deliverable", cardPolicyRow{Key: key, Status: "queued", ExpiresAt: now.Add(time.Hour)}, false},
		{"acknowledged", cardPolicyRow{Key: key, Status: "expired", ExpiresAt: lapsed, Accepted: true}, false},
		{"answered late", cardPolicyRow{Key: key, Status: "expired", ExpiresAt: lapsed, Late: true}, false},
		{"succeeded", cardPolicyRow{Key: key, Status: "succeeded", ExpiresAt: lapsed}, false},
		{"failed", cardPolicyRow{Key: key, Status: "failed", ExpiresAt: lapsed}, false},
		{"unknown", cardPolicyRow{Key: key, Status: "unknown", ExpiresAt: lapsed}, false},
		{"cancelled", cardPolicyRow{Key: key, Status: "cancelled", ExpiresAt: lapsed}, false},
		{"first redelivery lapsed", cardPolicyRow{Key: key + ":r1", Status: "expired", ExpiresAt: lapsed}, true},
		{"budget spent", cardPolicyRow{Key: key + ":r2", Status: "expired", ExpiresAt: lapsed}, false},
		{"past the budget", cardPolicyRow{Key: key + ":r9", Status: "expired", ExpiresAt: lapsed}, false},
	}
	for _, test := range cases {
		got, why := planCardPolicyRedelivery(test.row, now)
		if got != test.want {
			t.Errorf("%s: redeliver = %v (%s), want %v", test.name, got, why, test.want)
		}
		if !got && why == "" {
			t.Errorf("%s: refused without saying why", test.name)
		}
	}
}

// A cancelled command is the one terminal state an operator chose. Reviving it
// would undo a decision rather than repeat a lost one.
func TestAnOperatorsCancellationIsNotUndoneByTheRedelivery(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 26, 5, 11, 0, 0, time.UTC)
	row := cardPolicyRow{
		Key:       CardPolicyKey(testDevice, testVersion, testPayload),
		Status:    "cancelled",
		ExpiresAt: now.Add(-time.Hour),
	}
	redeliver, why := planCardPolicyRedelivery(row, now)
	if redeliver {
		t.Fatal("a cancelled card policy must stay cancelled")
	}
	if !strings.Contains(why, "cancel") {
		t.Errorf("reason = %q, want it to name the cancellation", why)
	}
}

// One statement for both callers. app.enqueue_command's contract lives in its
// arguments -- six of them, in this order, with these casts -- and a second
// copy drifting from this one would break deduplication silently.
func TestBothEnqueuePathsSendTheSameStatement(t *testing.T) {
	t.Parallel()

	db, rec := newRecordingDB(t, nil)
	rec.answers = func(query string) driver.Rows {
		if strings.Contains(query, "app.enqueue_command") {
			return &valueRows{
				cols: []string{"id"},
				rows: [][]driver.Value{{"c0000000-0000-4000-8000-00000000000c"}},
			}
		}
		return nil
	}

	item := Item{
		TenantID:       "t-a",
		DeviceID:       testDevice,
		Kind:           CardPolicyKind,
		IdempotencyKey: CardPolicyKey(testDevice, testVersion, testPayload),
		Payload:        testPayload,
		ExpiresAt:      time.Date(2026, 8, 26, 5, 41, 0, 0, time.UTC),
	}
	if _, err := (SQL{DB: db}).Enqueue(context.Background(), item); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	enqueue := rec.find(t, "app.enqueue_command")
	if got := len(enqueue.args); got != 6 {
		t.Fatalf("enqueue args = %d, want 6: %+v", got, enqueue.args)
	}
	for index, want := range []any{
		item.TenantID, item.DeviceID, item.Kind, string(item.Payload),
		item.IdempotencyKey, item.ExpiresAt,
	} {
		if got := enqueue.args[index].Value; got != want {
			t.Errorf("argument %d = %v, want %v", index+1, got, want)
		}
	}
	if !strings.Contains(enqueue.query, "$3::app.command_kind") ||
		!strings.Contains(enqueue.query, "$4::jsonb") {
		t.Errorf("the casts app.enqueue_command needs are missing:\n%s", enqueue.query)
	}
	// The tenant bind comes first or every statement in the transaction runs
	// outside the row-level security context it needs.
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if !strings.Contains(rec.execs[0].query, "set_config('app.tenant_id'") {
		t.Fatalf("first statement = %q, want the tenant bind", rec.execs[0].query)
	}
}
