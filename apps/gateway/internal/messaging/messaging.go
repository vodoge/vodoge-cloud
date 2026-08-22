// Package messaging is the tenant's SMS: conversations, delivery, and removal.
//
// Inbound messages arrive through the ingress projection. Outbound ones are
// recorded here when the command that sends them is queued, and updated when
// the device reports what happened — before this, a sent message existed only
// as a command payload, so the console could show a conversation with half of
// it missing and could not answer "did it arrive".
package messaging

import (
	"context"
	"database/sql"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Message is one SMS in either direction.
type Message struct {
	ID        string `json:"id"`
	DeviceID  string `json:"device_id"`
	Direction string `json:"direction"`
	Peer      string `json:"peer"`
	Body      string `json:"body"`
	Bearer    string `json:"bearer"`
	// Encoding is the alphabet the message arrived in. A reader needs it: an
	// "8bit" body is hex because the message was binary, not because decoding
	// failed.
	Encoding      string  `json:"encoding"`
	Status        string  `json:"status"`
	ReceivedAt    int64   `json:"received_at"`
	CommandID     *string `json:"command_id,omitempty"`
	FailureReason *string `json:"failure_reason,omitempty"`
	// createdAt is when the send was accepted, which is not ReceivedAt.
	//
	// SettleOutbound moves ReceivedAt to the moment the device answered, so a
	// message queued two hours ago and acknowledged a minute ago looks like a
	// minute old. Anything counting recent sends has to use this instead.
	// Unexported: it mirrors the messages.created_at column and exists for the
	// in-memory store to behave the same way, not for callers to set.
	createdAt time.Time
}

// Thread is one conversation, as the console lists them.
type Thread struct {
	Peer        string `json:"peer"`
	DeviceID    string `json:"device_id"`
	Messages    int    `json:"messages"`
	Unsent      int    `json:"unsent"`
	LastBody    string `json:"last_body"`
	LastAt      int64  `json:"last_at"`
	LastInbound bool   `json:"last_inbound"`
}

// Store reads and writes a tenant's messages.
type Store interface {
	Threads(ctx context.Context, tenantID string) ([]Thread, error)
	Thread(ctx context.Context, tenantID, peer string, limit int) ([]Message, error)
	RecordOutbound(ctx context.Context, tenantID string, message Message) error
	// CountOutboundSince counts sends accepted at or after a moment, which is
	// what an hourly send limit is a limit on.
	CountOutboundSince(ctx context.Context, tenantID string, since time.Time) (int, error)
	SettleOutbound(ctx context.Context, tenantID, commandID, status, reason string) error
	DeleteMessage(ctx context.Context, tenantID, id string) error
	DeleteThread(ctx context.Context, tenantID, peer string) (int64, error)
}

// SQL reads through the tenant's RLS context.
type SQL struct{ DB *sql.DB }

// Threads lists conversations, most recent first.
//
// Grouped by peer rather than by peer and device: the same number reached from
// two devices is one conversation to the person reading it, and splitting it
// would hide half the exchange behind a distinction they did not make.
func (store SQL) Threads(ctx context.Context, tenantID string) ([]Thread, error) {
	out := []Thread{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT DISTINCT ON (m.peer)
			       m.peer,
			       m.device_id::text,
			       count(*) OVER (PARTITION BY m.peer),
			       count(*) FILTER (WHERE m.status IN ('queued', 'failed'))
			           OVER (PARTITION BY m.peer),
			       m.body,
			       m.received_at,
			       m.direction = 'inbound'
			  FROM app.messages AS m
			 ORDER BY m.peer, m.received_at DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var thread Thread
			var last time.Time
			if err := rows.Scan(
				&thread.Peer, &thread.DeviceID, &thread.Messages, &thread.Unsent,
				&thread.LastBody, &last, &thread.LastInbound,
			); err != nil {
				return err
			}
			thread.LastAt = last.UnixMilli()
			out = append(out, thread)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	// Sorted here rather than in SQL: DISTINCT ON dictates the ORDER BY, and
	// wrapping the query in a subselect to reorder it is more machinery than
	// a list of conversations is worth.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].LastAt > out[j-1].LastAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// Thread returns one conversation oldest first, which is how it is read.
func (store SQL) Thread(
	ctx context.Context,
	tenantID, peer string,
	limit int,
) ([]Message, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	out := []Message{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text, device_id::text, direction, peer, body, bearer,
			       encoding, status, received_at, command_id::text, failure_reason
			  FROM (
			    SELECT * FROM app.messages
			     WHERE peer = $1
			     ORDER BY received_at DESC
			     LIMIT $2
			  ) AS recent
			 ORDER BY received_at`, peer, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var message Message
			var at time.Time
			var commandID, reason sql.NullString
			if err := rows.Scan(
				&message.ID, &message.DeviceID, &message.Direction, &message.Peer,
				&message.Body, &message.Bearer, &message.Encoding, &message.Status,
				&at, &commandID, &reason,
			); err != nil {
				return err
			}
			message.ReceivedAt = at.UnixMilli()
			if commandID.Valid {
				value := commandID.String
				message.CommandID = &value
			}
			if reason.Valid {
				value := reason.String
				message.FailureReason = &value
			}
			out = append(out, message)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RecordOutbound stores a message at the moment its command is queued.
//
// Recorded before the device has done anything, so the conversation shows the
// message immediately with an honest `queued` status. Waiting for the device
// would mean a sent message vanishing for however long the device takes.
func (store SQL) RecordOutbound(ctx context.Context, tenantID string, message Message) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.messages
			    (tenant_id, device_id, direction, peer, body, bearer,
			     status, received_at, seq, command_id)
			VALUES (app.current_tenant_id(), $1::uuid, 'outbound', $2, $3, 'unknown',
			        'queued', now(), 0, $4::uuid)
			ON CONFLICT (command_id) WHERE command_id IS NOT NULL DO NOTHING`,
			message.DeviceID, message.Peer, message.Body, message.CommandID)
		return err
	})
}

// CountOutboundSince counts sends this tenant accepted since a moment.
//
// created_at rather than received_at: SettleOutbound rewrites received_at when
// the device answers, so counting on it would let an old message that just got
// its receipt consume a slot in the current hour.
func (store SQL) CountOutboundSince(
	ctx context.Context,
	tenantID string,
	since time.Time,
) (int, error) {
	var count int
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `
			SELECT count(*) FROM app.messages
			 WHERE direction = 'outbound'
			   AND created_at >= $1`, since).Scan(&count)
	})
	return count, err
}

// SettleOutbound applies what the device reported about a send.
func (store SQL) SettleOutbound(
	ctx context.Context,
	tenantID, commandID, status, reason string,
) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE app.messages
			   SET status = $2,
			       failure_reason = nullif($3, ''),
			       received_at = now()
			 WHERE command_id = $1::uuid
			   AND status = 'queued'`, commandID, status, reason)
		return err
	})
}

func (store SQL) DeleteMessage(ctx context.Context, tenantID, id string) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM app.messages WHERE id = $1::uuid`, id)
		return err
	})
}

// DeleteThread removes a whole conversation and says how many rows went.
//
// The count is returned because a delete that silently matched nothing looks
// exactly like one that worked, and the console shows it.
func (store SQL) DeleteThread(ctx context.Context, tenantID, peer string) (int64, error) {
	var removed int64
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `DELETE FROM app.messages WHERE peer = $1`, peer)
		if err != nil {
			return err
		}
		removed, err = result.RowsAffected()
		return err
	})
	return removed, err
}
