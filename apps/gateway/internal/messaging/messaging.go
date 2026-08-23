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
	Encoding string `json:"encoding"`
	// Status is the send lifecycle: queued, sent, delivered, undelivered,
	// failed -- or received, for a message that arrived.
	//
	// sent and delivered are two states because they come from two different
	// places. sent is the modem saying it took the message; delivered is the
	// network saying the recipient got it, minutes later and over a separate
	// path. Collapsing them would mean claiming the second on the evidence of
	// the first, which is the one thing an operator asks this column.
	Status     string `json:"status"`
	ReceivedAt int64  `json:"received_at"`
	// DeliveredAt is the discharge time from the network's report, not the
	// moment the report reached us. It can be well before ReceivedAt.
	DeliveredAt *int64 `json:"delivered_at,omitempty"`
	// DeliveryCode is TP-ST verbatim, kept because the status above throws
	// away the reason and the reason is what says whether to resend.
	DeliveryCode *int `json:"delivery_code,omitempty"`
	// ProviderReference is the TP-MR the modem used for this send. It is the
	// only thing a delivery report names the message by.
	ProviderReference *int    `json:"provider_reference,omitempty"`
	ReadAt            *int64  `json:"read_at,omitempty"`
	CommandID         *string `json:"command_id,omitempty"`
	FailureReason     *string `json:"failure_reason,omitempty"`
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
	Peer string `json:"peer"`
	// Name is the contact's, or empty when the number has none. Empty rather
	// than the number repeated: the console decides how to show an unnamed
	// conversation, and a store that pre-filled it could not tell the two
	// apart afterwards.
	Name     string `json:"name"`
	DeviceID string `json:"device_id"`
	Messages int    `json:"messages"`
	// Unsent counts messages that never left: queued and failed. An
	// undelivered one did leave, so it is not counted here -- the difference
	// is whether resending is the obvious next step.
	Unsent int `json:"unsent"`
	// Unread counts inbound messages nobody has opened.
	Unread      int    `json:"unread"`
	LastBody    string `json:"last_body"`
	LastAt      int64  `json:"last_at"`
	LastInbound bool   `json:"last_inbound"`
}

// Contact is a name for a number.
type Contact struct {
	Peer      string `json:"peer"`
	Name      string `json:"name"`
	Note      string `json:"note"`
	UpdatedAt int64  `json:"updated_at"`
}

// Store reads and writes a tenant's messages.
type Store interface {
	Threads(ctx context.Context, tenantID string) ([]Thread, error)
	Thread(ctx context.Context, tenantID, peer string, limit int) ([]Message, error)
	RecordOutbound(ctx context.Context, tenantID string, message Message) error
	// CountOutboundSince counts sends accepted at or after a moment, which is
	// what an hourly send limit is a limit on.
	CountOutboundSince(ctx context.Context, tenantID string, since time.Time) (int, error)
	// SettleOutbound applies the command receipt: the modem took the message,
	// or refused it. `reference` is the TP-MR the modem used, which is stored
	// so a network delivery report -- a different event, arriving later on a
	// different path -- can find this exact message again.
	SettleOutbound(
		ctx context.Context,
		tenantID, commandID, status, reason string,
		reference *int,
	) error
	// MarkThreadRead clears the unread state for one conversation and says how
	// many messages it covered.
	MarkThreadRead(ctx context.Context, tenantID, peer string) (int64, error)
	Contacts(ctx context.Context, tenantID string) ([]Contact, error)
	SaveContact(ctx context.Context, tenantID string, contact Contact) error
	DeleteContact(ctx context.Context, tenantID, peer string) error
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
			       coalesce(c.name, ''),
			       m.device_id::text,
			       count(*) OVER (PARTITION BY m.peer),
			       count(*) FILTER (WHERE m.status IN ('queued', 'failed'))
			           OVER (PARTITION BY m.peer),
			       count(*) FILTER (
			           WHERE m.direction = 'inbound' AND m.read_at IS NULL)
			           OVER (PARTITION BY m.peer),
			       m.body,
			       m.received_at,
			       m.direction = 'inbound'
			  FROM app.messages AS m
			  LEFT JOIN app.contacts AS c
			         ON c.tenant_id = m.tenant_id AND c.peer = m.peer
			 ORDER BY m.peer, m.received_at DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var thread Thread
			var last time.Time
			if err := rows.Scan(
				&thread.Peer, &thread.Name, &thread.DeviceID, &thread.Messages,
				&thread.Unsent, &thread.Unread,
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
			       encoding, status, received_at, delivered_at, delivery_code,
			       read_at, command_id::text, failure_reason
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
			var delivered, read sql.NullTime
			var code sql.NullInt64
			var commandID, reason sql.NullString
			if err := rows.Scan(
				&message.ID, &message.DeviceID, &message.Direction, &message.Peer,
				&message.Body, &message.Bearer, &message.Encoding, &message.Status,
				&at, &delivered, &code, &read, &commandID, &reason,
			); err != nil {
				return err
			}
			message.ReceivedAt = at.UnixMilli()
			if delivered.Valid {
				value := delivered.Time.UnixMilli()
				message.DeliveredAt = &value
			}
			if read.Valid {
				value := read.Time.UnixMilli()
				message.ReadAt = &value
			}
			if code.Valid {
				value := int(code.Int64)
				message.DeliveryCode = &value
			}
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
//
// This is the command receipt and nothing more: the modem accepted the message
// or refused it. Whether it arrived is a separate event on a separate path --
// an SMS-STATUS-REPORT projected by accept_ingress -- and the only thing this
// does about it is write down `reference`, the TP-MR the modem used, which is
// how that later report finds this row.
func (store SQL) SettleOutbound(
	ctx context.Context,
	tenantID, commandID, status, reason string,
	reference *int,
) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE app.messages
			   SET status = $2,
			       failure_reason = nullif($3, ''),
			       received_at = now(),
			       -- Left alone when the device did not report one, so an
			       -- agent older than this column does not erase a reference
			       -- a retry already established.
			       provider_reference = coalesce($4, provider_reference)
			 WHERE command_id = $1::uuid
			   AND status = 'queued'`, commandID, status, reason, reference)
		return err
	})
}

// MarkThreadRead clears unread state for one conversation.
//
// Only inbound messages have it: an outbound message was written here, so
// "unread" would be a claim about the sender not reading their own words.
func (store SQL) MarkThreadRead(
	ctx context.Context,
	tenantID, peer string,
) (int64, error) {
	var marked int64
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `
			UPDATE app.messages
			   SET read_at = now()
			 WHERE peer = $1
			   AND direction = 'inbound'
			   AND read_at IS NULL`, peer)
		if err != nil {
			return err
		}
		marked, err = result.RowsAffected()
		return err
	})
	return marked, err
}

// Contacts lists every named number, including ones with no messages.
//
// Not derived from the message table: a contact saved before the first message
// is exactly the case a phone book is for, and deriving the list would make it
// impossible to add one.
func (store SQL) Contacts(ctx context.Context, tenantID string) ([]Contact, error) {
	out := []Contact{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT peer, name, note, updated_at
			  FROM app.contacts
			 ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var contact Contact
			var updated time.Time
			if err := rows.Scan(
				&contact.Peer, &contact.Name, &contact.Note, &updated,
			); err != nil {
				return err
			}
			contact.UpdatedAt = updated.UnixMilli()
			out = append(out, contact)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SaveContact names a number, or renames one already named.
func (store SQL) SaveContact(ctx context.Context, tenantID string, contact Contact) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.contacts (tenant_id, peer, name, note)
			VALUES (app.current_tenant_id(), $1, $2, $3)
			ON CONFLICT (tenant_id, peer) DO UPDATE SET
			    name = EXCLUDED.name,
			    note = EXCLUDED.note,
			    updated_at = now()`,
			contact.Peer, contact.Name, contact.Note)
		return err
	})
}

// DeleteContact forgets the name, leaving the conversation alone.
func (store SQL) DeleteContact(ctx context.Context, tenantID, peer string) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM app.contacts WHERE peer = $1`, peer)
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
