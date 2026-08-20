// Package catalog lists tenant-scoped devices, messages, and SMS sessions.
package catalog

import (
	"context"
	"database/sql"
	"sort"
	"sync"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Device is one edge box as shown on the tenant dashboard.
type Device struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	State    string `json:"state"`
	LastSeen *int64 `json:"last_seen"`
}

// Message is one SMS row in the tenant inbox.
type Message struct {
	ID         string `json:"id"`
	DeviceID   string `json:"device_id"`
	Direction  string `json:"direction"`
	Peer       string `json:"peer"`
	Body       string `json:"body"`
	Bearer     string `json:"bearer"`
	ReceivedAt int64  `json:"received_at"`
	Seq        int64  `json:"seq"`
}

// Session is one peer thread in the tenant inbox.
type Session struct {
	Peer           string `json:"peer"`
	Count          int    `json:"count"`
	LastBody       string `json:"last_body"`
	LastReceivedAt int64  `json:"last_received_at"`
	DeviceID       string `json:"device_id"`
}

// Store loads console data. SQL implementations must bind tenant_id with SET LOCAL.
type Store interface {
	ListDevices(ctx context.Context, tenantID string) ([]Device, error)
	ListMessages(ctx context.Context, tenantID string) ([]Message, error)
	ListSessions(ctx context.Context, tenantID string) ([]Session, error)
}

// Empty is used when PostgreSQL is not configured.
type Empty struct{}

// ListDevices returns no devices.
func (Empty) ListDevices(context.Context, string) ([]Device, error) {
	return []Device{}, nil
}

// ListMessages returns no messages.
func (Empty) ListMessages(context.Context, string) ([]Message, error) {
	return []Message{}, nil
}

// ListSessions returns no sessions.
func (Empty) ListSessions(context.Context, string) ([]Session, error) {
	return []Session{}, nil
}

// Memory is an in-process catalog used by tests.
type Memory struct {
	mu       sync.Mutex
	Devices  map[string][]Device
	Messages map[string][]Message
}

// ListDevices returns devices for tenantID, never another tenant's rows.
func (store *Memory) ListDevices(_ context.Context, tenantID string) ([]Device, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return cloneDevices(store.Devices[tenantID]), nil
}

// ListMessages returns messages for tenantID, never another tenant's rows.
func (store *Memory) ListMessages(_ context.Context, tenantID string) ([]Message, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return cloneMessages(store.Messages[tenantID]), nil
}

// ListSessions aggregates tenantID messages by peer.
func (store *Memory) ListSessions(ctx context.Context, tenantID string) ([]Session, error) {
	messages, err := store.ListMessages(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	return SessionsFrom(messages), nil
}

// SQL reads app.devices and app.messages through tenant.Transact.
type SQL struct {
	DB *sql.DB
}

// ListDevices returns the tenant's devices ordered by name.
func (store SQL) ListDevices(ctx context.Context, tenantID string) ([]Device, error) {
	var devices []Device
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text,
			       name,
			       CASE
			         WHEN last_seen_at IS NULL THEN 'unknown'
			         WHEN last_seen_at > now() - interval '2 minutes' THEN 'online'
			         ELSE 'offline'
			       END,
			       last_seen_at
			  FROM app.devices
			 ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Device
			var lastSeen sql.NullTime
			if err := rows.Scan(&item.ID, &item.Name, &item.State, &lastSeen); err != nil {
				return err
			}
			if lastSeen.Valid {
				ms := lastSeen.Time.UnixMilli()
				item.LastSeen = &ms
			}
			devices = append(devices, item)
		}
		return rows.Err()
	})
	if devices == nil {
		devices = []Device{}
	}
	return devices, err
}

// ListMessages returns the newest 200 SMS rows for the tenant.
func (store SQL) ListMessages(ctx context.Context, tenantID string) ([]Message, error) {
	var messages []Message
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text,
			       device_id::text,
			       direction,
			       peer,
			       body,
			       bearer,
			       (EXTRACT(EPOCH FROM received_at) * 1000)::bigint,
			       seq
			  FROM app.messages
			 ORDER BY received_at DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Message
			if err := rows.Scan(
				&item.ID, &item.DeviceID, &item.Direction, &item.Peer,
				&item.Body, &item.Bearer, &item.ReceivedAt, &item.Seq,
			); err != nil {
				return err
			}
			messages = append(messages, item)
		}
		return rows.Err()
	})
	if messages == nil {
		messages = []Message{}
	}
	return messages, err
}

// ListSessions returns the newest 200 peer threads for the tenant.
func (store SQL) ListSessions(ctx context.Context, tenantID string) ([]Session, error) {
	var sessions []Session
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT peer,
			       COUNT(*)::int,
			       (ARRAY_AGG(body ORDER BY received_at DESC))[1],
			       (EXTRACT(EPOCH FROM MAX(received_at)) * 1000)::bigint,
			       (ARRAY_AGG(device_id::text ORDER BY received_at DESC))[1]
			  FROM app.messages
			 GROUP BY peer
			 ORDER BY MAX(received_at) DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Session
			if err := rows.Scan(
				&item.Peer, &item.Count, &item.LastBody, &item.LastReceivedAt, &item.DeviceID,
			); err != nil {
				return err
			}
			sessions = append(sessions, item)
		}
		return rows.Err()
	})
	if sessions == nil {
		sessions = []Session{}
	}
	return sessions, err
}

// SessionsFrom groups messages into peer threads, newest first.
func SessionsFrom(messages []Message) []Session {
	type acc struct {
		session Session
	}
	byPeer := make(map[string]*acc)
	for _, message := range messages {
		existing, ok := byPeer[message.Peer]
		if !ok {
			byPeer[message.Peer] = &acc{session: Session{
				Peer:           message.Peer,
				Count:          1,
				LastBody:       message.Body,
				LastReceivedAt: message.ReceivedAt,
				DeviceID:       message.DeviceID,
			}}
			continue
		}
		existing.session.Count++
		if message.ReceivedAt >= existing.session.LastReceivedAt {
			existing.session.LastBody = message.Body
			existing.session.LastReceivedAt = message.ReceivedAt
			existing.session.DeviceID = message.DeviceID
		}
	}
	sessions := make([]Session, 0, len(byPeer))
	for _, item := range byPeer {
		sessions = append(sessions, item.session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].LastReceivedAt == sessions[j].LastReceivedAt {
			return sessions[i].Peer < sessions[j].Peer
		}
		return sessions[i].LastReceivedAt > sessions[j].LastReceivedAt
	})
	if len(sessions) > 200 {
		sessions = sessions[:200]
	}
	return sessions
}

func cloneDevices(in []Device) []Device {
	if in == nil {
		return []Device{}
	}
	out := make([]Device, len(in))
	copy(out, in)
	return out
}

func cloneMessages(in []Message) []Message {
	if in == nil {
		return []Message{}
	}
	out := make([]Message, len(in))
	copy(out, in)
	return out
}

// UnixMilli is exported for tests that compare last_seen.
func UnixMilli(ts time.Time) int64 {
	return ts.UnixMilli()
}
