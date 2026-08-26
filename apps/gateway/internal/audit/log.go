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
//
// The tags are wire format, not decoration. This struct is what GET /v1/audit
// answers with, and it went out untagged for long enough that the console read
// row.action, got undefined, dropped every row and drew an empty audit log over
// a populated one -- silently, because a missing key is not an error anywhere.
// The names match the app.audit_log columns below and the lowercase style every
// other response struct in this gateway already uses.
type Event struct {
	Actor  string          `json:"actor"`
	Action string          `json:"action"`
	Target string          `json:"target"`
	Detail json.RawMessage `json:"detail"`
}

// Log records an event. Implementations must not update existing rows.
type Log interface {
	Append(ctx context.Context, tenantID string, event Event) error
	List(ctx context.Context, tenantID string) ([]Event, error)
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
	events, _ := log.List(context.Background(), tenantID)
	return events
}

// List returns events for tenantID only.
func (log *Memory) List(_ context.Context, tenantID string) ([]Event, error) {
	log.mu.Lock()
	defer log.mu.Unlock()
	out := make([]Event, 0)
	for _, item := range log.Events {
		if item.TenantID == tenantID {
			out = append(out, item.Event)
		}
	}
	return out, nil
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

// List returns the newest 200 audit rows for the tenant.
func (log SQL) List(ctx context.Context, tenantID string) ([]Event, error) {
	var events []Event
	err := tenant.Transact(ctx, log.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT actor, action, COALESCE(target, ''), detail
			  FROM app.audit_log
			 ORDER BY at DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Event
			if err := rows.Scan(&item.Actor, &item.Action, &item.Target, &item.Detail); err != nil {
				return err
			}
			events = append(events, item)
		}
		return rows.Err()
	})
	if events == nil {
		events = []Event{}
	}
	return events, err
}
