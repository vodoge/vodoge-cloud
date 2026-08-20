// Package audit appends tenant-scoped operator actions.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Event is one append-only audit row.
type Event struct {
	Actor  string
	Action string
	Target string
	Detail json.RawMessage
}

// Log records an event. Implementations must not update existing rows.
type Log interface {
	Append(ctx context.Context, tenantID string, event Event) error
}

// Memory keeps events for tests.
type Memory struct {
	mu     sync.Mutex
	Events []stored
}

type stored struct {
	TenantID string
	Event    Event
}

// Append records event.
func (log *Memory) Append(_ context.Context, tenantID string, event Event) error {
	log.mu.Lock()
	defer log.mu.Unlock()
	log.Events = append(log.Events, stored{TenantID: tenantID, Event: event})
	return nil
}

// ForTenant returns events for tenantID only.
func (log *Memory) ForTenant(tenantID string) []Event {
	log.mu.Lock()
	defer log.mu.Unlock()
	out := make([]Event, 0)
	for _, item := range log.Events {
		if item.TenantID == tenantID {
			out = append(out, item.Event)
		}
	}
	return out
}

// SQL inserts into app.audit_log.
type SQL struct {
	DB *sql.DB
}

// Append writes one immutable row.
func (log SQL) Append(ctx context.Context, tenantID string, event Event) error {
	if len(event.Detail) == 0 {
		event.Detail = []byte("{}")
	}
	return tenant.Transact(ctx, log.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.audit_log (tenant_id, actor, action, target, detail)
			VALUES ($1, $2, $3, $4, $5::jsonb)`,
			tenantID, event.Actor, event.Action, event.Target, string(event.Detail))
		return err
	})
}
