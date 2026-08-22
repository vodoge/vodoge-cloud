package commands

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
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
	// The error is reported, not discarded. Discarding it is why the command
	// relay silently did nothing on every deployment: the query failed on a
	// missing grant, returned no rows, and a queued command that is never
	// delivered looks exactly like one waiting for a device to reconnect.
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		// Retire this device's lapsed commands before reading the rest.
		//
		// The SELECT below filters on expires_at, so a lapsed command was
		// already undeliverable -- but nothing ever moved it off 'queued', and
		// the console reports that status as waiting for the device. Seventeen
		// commands issued while the uplink was down were still reported as
		// pending hours after they expired.
		//
		// Resume is the trigger because it is the only tenant-scoped path that
		// runs on its own: app.tenants is under FORCE row-level security keyed
		// to the current tenant, so nothing can enumerate tenants to sweep them
		// globally. A device that never reconnects keeps its stale rows until
		// it does.
		var expired int
		if err := tx.QueryRowContext(ctx,
			`SELECT app.expire_overdue_commands($1::uuid, $2::uuid, $3)`,
			tenantID, deviceID, now,
		).Scan(&expired); err != nil {
			return err
		}
		if expired > 0 {
			slog.Info("retired commands that outlived their expiry",
				"tenant_id", tenantID, "device_id", deviceID, "count", expired)
		}

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
	if err != nil {
		slog.Warn("pending commands could not be read",
			"tenant_id", tenantID, "device_id", deviceID, "error", err)
		return nil
	}
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
