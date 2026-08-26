// Package commands enqueues durable CommandDeliver work.
package commands

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Item is one queued command.
type Item struct {
	TenantID       string
	DeviceID       string
	Kind           string
	IdempotencyKey string
	Payload        json.RawMessage
	ExpiresAt      time.Time
}

// Queue persists a command and its wakeup in one transaction.
type Queue interface {
	Enqueue(ctx context.Context, item Item) (string, error)
}

// Memory records enqueued items for tests.
type Memory struct {
	mu    sync.Mutex
	Items []Item
}

// Enqueue appends item and returns a synthetic id.
func (queue *Memory) Enqueue(_ context.Context, item Item) (string, error) {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	queue.Items = append(queue.Items, item)
	return item.IdempotencyKey, nil
}

// SQL calls app.enqueue_command.
type SQL struct {
	DB *sql.DB
}

// Enqueue writes commands + outbox through SET LOCAL.
func (queue SQL) Enqueue(ctx context.Context, item Item) (string, error) {
	var id string
	err := tenant.Transact(ctx, queue.DB, item.TenantID, func(tx *sql.Tx) error {
		var err error
		id, err = EnqueueTx(ctx, tx, item)
		return err
	})
	return id, err
}

// EnqueueTx runs the same call on a transaction the caller already owns and has
// already bound to the tenant.
//
// Exists because the redelivery in lifecycle.go must enqueue from inside its own
// transaction. Two copies of this statement would be two places to keep the
// argument list and the casts in step, and app.enqueue_command's contract --
// same key plus same payload returns the original row, same key plus a different
// payload raises 23505 -- is precisely the thing a drifted second copy would
// break silently.
func EnqueueTx(ctx context.Context, tx *sql.Tx, item Item) (string, error) {
	var id string
	err := tx.QueryRowContext(ctx, `
		SELECT id::text
		  FROM app.enqueue_command($1, $2, $3::app.command_kind, $4::jsonb, $5, $6)`,
		item.TenantID,
		item.DeviceID,
		item.Kind,
		string(item.Payload),
		item.IdempotencyKey,
		item.ExpiresAt,
	).Scan(&id)
	return id, err
}

// The card policy set is the one command kind that describes desired state
// rather than an action, and it is the only one no human re-issues when it goes
// missing: an operator who saves a policy has no reason to save it a second
// time, and the console shows the row as saved either way.
//
// Production, 2026-08-26: two update_card_policy commands have ever been issued
// (2026-08-22 08:09 and 08:10) and both reached 'expired' with accepted_at NULL.
// They were not lost to a short link outage. app.schema_migrations records
// 0027_command_grants applied at 08:50:17 -- ten minutes after the second one
// expired -- and that is the migration that made command delivery work at all;
// five commands of four other kinds died in the same window with no receipt,
// and the first accepted receipt in the whole history is 09:29:55. Every other
// kind recovered because somebody issued it again. This one had nobody to.
//
// So the durable defect is not the length of the window, it is that expiry is
// terminal for a kind whose intent outlives it. The redelivery below re-arms it
// when the device is next seen, which makes the window's length almost
// irrelevant -- and that matters, because lengthening the window is actively
// harmful: wss.deliverPending re-sends every still-queued command off any
// inbound traffic, so a command the device never answers is re-sent for the
// whole of its TTL. Measured on the bench the same day: a 2-minute TTL produced
// four CommandDeliver frames before the row expired.
const (
	// CardPolicyKind is app.command_kind's spelling for a card policy push.
	CardPolicyKind = "update_card_policy"

	// CardPolicyTTL is how long one push stays deliverable.
	//
	// Deliberately not raised while adding redelivery. A longer TTL only helps
	// a device that comes back before it lapses, which is the case redelivery
	// already covers; what it certainly does is multiply the re-send loop above
	// for a device that never answers.
	CardPolicyTTL = 30 * time.Minute

	// MaxCardPolicyDeliveries bounds one intent to three command rows: the
	// console's push and two redeliveries. Then it stops, for good, until a
	// human changes the policy -- which is new intent and starts a new chain.
	//
	// A bound is not optional here. The edge keeps CommandResult envelopes in
	// RetentionClass::Protected, so an unbounded chain of redeliveries would be
	// an unbounded chain of protected envelopes queued against a device that has
	// already demonstrated it cannot take them.
	MaxCardPolicyDeliveries = 3
)

// CardPolicyKey is the idempotency key for one card policy intent.
//
// Derived from the device, the set's version, and a fingerprint of the payload,
// and from nothing else. It used to end in time.Now().UnixNano(), which meant
// two identical pushes were two rows: app.enqueue_command deduplicates on
// (tenant_id, idempotency_key), and a key carrying a clock reading can never
// collide, so the deduplication it offers was unreachable.
//
// The fingerprint is not redundant with the version. cards.Version truncates to
// whole seconds, so two edits inside one second share a version while carrying
// different policies -- and app.enqueue_command answers a key reused for a
// different payload with 23505, which the console would see as a 500 on save.
func CardPolicyKey(deviceID, version string, payload []byte) string {
	sum := sha256.Sum256(payload)
	return CardPolicyKind + ":" + deviceID + ":" + version + ":" + hex.EncodeToString(sum[:8])
}

// revivalSuffix matches the counter a redelivery appends to the original key.
//
// A key produced by CardPolicyKey can never match it: the last segment is hex,
// and 'r' is not a hex digit. That is what keeps "how many attempts has this
// intent had" answerable from the newest row alone, with no ledger table and no
// second query.
var revivalSuffix = regexp.MustCompile(`:r([0-9]+)$`)

// cardPolicyAttempts reports how many command rows this intent has already had,
// read from the newest row's key. An unsuffixed key is the first attempt.
func cardPolicyAttempts(key string) int {
	match := revivalSuffix.FindStringSubmatch(key)
	if match == nil {
		return 1
	}
	attempt, err := strconv.Atoi(match[1])
	if err != nil || attempt < 1 {
		return 1
	}
	return attempt + 1
}

// cardPolicyRevivalKey names attempt n of the intent behind key.
//
// Idempotent in the key as well as in the attempt: reviving a revival replaces
// the counter instead of stacking one, so the same attempt of the same intent
// always produces the same key and app.enqueue_command collapses a repeat onto
// the row it already made.
func cardPolicyRevivalKey(key string, attempt int) string {
	return revivalSuffix.ReplaceAllString(key, "") + ":r" + strconv.Itoa(attempt)
}

// cardPolicyRow is the newest card policy command a device has been given.
type cardPolicyRow struct {
	Key       string
	Status    string
	ExpiresAt time.Time
	Accepted  bool
	// Late records a device answer that arrived after the cloud retired the
	// command (lifecycle.go's recordLateResultSQL). The device did have it.
	Late    bool
	Payload []byte
}

// planCardPolicyRedelivery decides whether a resumed device should be given its
// card policy again, and says why not when the answer is no.
//
// The reason is returned rather than logged here so the decision stays a pure
// function of the row: this runs on every pending check, which is every few
// seconds for a connected device, and "did we already do this" has to be
// answerable from stored state alone or the answer changes with call frequency.
func planCardPolicyRedelivery(row cardPolicyRow, now time.Time) (bool, string) {
	switch {
	case row.Accepted:
		return false, "the device acknowledged it"
	case row.Late:
		return false, "the device answered it after it expired"
	case row.Status == "succeeded" || row.Status == "failed" || row.Status == "unknown":
		return false, "the device already answered it"
	case row.Status == "cancelled":
		return false, "an operator cancelled it"
	case row.Status != "expired" && row.ExpiresAt.After(now):
		// Still deliverable. The pending read below is about to send it again
		// on its own, and enqueueing a second row here would be the duplicate
		// delivery this whole path exists to avoid.
		return false, "it is still deliverable"
	case cardPolicyAttempts(row.Key) >= MaxCardPolicyDeliveries:
		return false, "its redelivery budget is spent"
	}
	return true, ""
}
