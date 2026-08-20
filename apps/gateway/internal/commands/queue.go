// Package commands enqueues durable CommandDeliver work.
package commands

import (
	"context"
	"database/sql"
	"encoding/json"
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
		return tx.QueryRowContext(ctx, `
			SELECT id::text
			  FROM app.enqueue_command($1, $2, $3::app.command_kind, $4::jsonb, $5, $6)`,
			item.TenantID,
			item.DeviceID,
			item.Kind,
			string(item.Payload),
			item.IdempotencyKey,
			item.ExpiresAt,
		).Scan(&id)
	})
	return id, err
}
