package commands

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// SQLPending loads queued commands for a resumed device.
type SQLPending struct {
	DB *sql.DB
}

// PendingForDevice returns durable commands that still need CommandDeliver.
func (store SQLPending) PendingForDevice(tenantID, deviceID string, now time.Time) []dispatch.PendingCommand {
	if store.DB == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var pending []dispatch.PendingCommand
	_ = tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT c.id::text,
			       c.device_id::text,
			       c.kind::text,
			       c.payload,
			       c.issued_at,
			       c.expires_at,
			       GREATEST(COALESCE(o.attempt_count, 0), 1)
			  FROM app.commands AS c
			  LEFT JOIN app.command_outbox AS o
			    ON o.tenant_id = c.tenant_id
			   AND o.command_id = c.id
			 WHERE c.device_id = $1::uuid
			   AND c.status IN ('queued', 'dispatched')
			   AND c.expires_at > $2
			 ORDER BY c.issued_at
			 LIMIT 32`, deviceID, now)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item dispatch.PendingCommand
			item.Command.TenantID = tenantID
			if err := rows.Scan(
				&item.Command.ID,
				&item.Command.DeviceID,
				&item.Command.Kind,
				&item.Command.Payload,
				&item.Command.IssuedAt,
				&item.Command.ExpiresAt,
				&item.Attempt,
			); err != nil {
				return err
			}
			pending = append(pending, item)
		}
		return rows.Err()
	})
	return pending
}

// SQLLifecycle records receipts and terminal results.
type SQLLifecycle struct {
	DB *sql.DB
}

// RecordReceipt marks the command accepted without requiring a delivery_attempt row.
func (store SQLLifecycle) RecordReceipt(tenantID string, receipt dispatch.Receipt, now time.Time) error {
	if store.DB == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.command_receipts (id, tenant_id, command_id, kind, detail, received_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::app.command_receipt_kind, '{}'::jsonb, $5)
			ON CONFLICT (id) DO NOTHING`,
			receipt.ID, tenantID, receipt.CommandID, string(receipt.Status), receipt.ReceivedAt)
		if err != nil {
			return err
		}
		if receipt.Status == dispatch.ReceiptAccepted || receipt.Status == dispatch.ReceiptDuplicate {
			_, err = tx.ExecContext(ctx, `
				UPDATE app.commands
				   SET status = 'accepted',
				       accepted_at = $1
				 WHERE id = $2::uuid
				   AND status IN ('queued', 'dispatched')`, now, receipt.CommandID)
		}
		return err
	})
}

// RecordResult applies a sequenced CommandResult to app.commands.
func (store SQLLifecycle) RecordResult(tenantID string, result dispatch.CommandResult) error {
	if store.DB == nil {
		return nil
	}
	status := string(result.Status)
	record := map[string]any{
		"status":      status,
		"attempts":    result.Attempts,
		"reason_code": result.ReasonCode,
		"reason":      result.Reason,
	}
	// A diagnostic's reading is the point of running it, so it is stored
	// alongside the outcome rather than only logged. Kept as raw JSON: the
	// shape differs per command and the gateway has no reason to interpret it.
	if len(result.Details) > 0 {
		record["details"] = json.RawMessage(result.Details)
	}
	detail, err := json.Marshal(record)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE app.commands
			   SET status = $1::app.command_status,
			       completed_at = $2,
			       result = $3::jsonb
			 WHERE id = $4::uuid
			   AND status NOT IN ('succeeded', 'failed', 'unknown', 'expired', 'cancelled')`,
			status, result.CompletedAt, string(detail), result.CommandID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE app.command_outbox
			   SET resolved_at = now()
			 WHERE command_id = $1::uuid
			   AND resolved_at IS NULL`, result.CommandID)
		return err
	})
}
