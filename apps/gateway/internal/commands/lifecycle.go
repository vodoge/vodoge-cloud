package commands

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
	contract "github.com/vodoge/vodoge-cloud/packages/contract"
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
	// Before the read, so a policy re-queued here is delivered in this same pass
	// rather than waiting for the next one. On its own deadline as well as its
	// own transaction: a slow redelivery must not eat the read's budget, since
	// the read is what the session is actually waiting for.
	store.redeliverCardPolicy(tenantID, deviceID, now)
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

// SweepResult is what one tenant's housekeeping pass reclaimed.
//
// A struct rather than a count because the pass now does two unrelated jobs
// that happen to need the same scarce thing -- a tenant id -- and collapsing
// them into one number would make "nothing expired" and "nothing was pruned"
// indistinguishable in the tick report.
type SweepResult struct {
	// ExpiredCommands is how many commands outlived expires_at (L3).
	ExpiredCommands int
	// PrunedIngress is how many app.ingress rows fell outside the retention
	// window (1.8).
	PrunedIngress int
}

// ExpireTenantCommands runs one tenant's periodic housekeeping: it retires
// overdue commands (L3) and enforces the app.ingress retention window (1.8).
//
// The name is narrower than the job. It is the identifier cmd/gateway/main.go
// binds to the scheduler's Sweep hook, and that file is outside this change;
// renaming it is a one-line follow-up for whoever next touches main.go.
//
// # Why both jobs live here
//
// The per-device command sweep above runs on resume, which 0033 picked because
// resume was the only tenant-scoped path that ran on its own -- app.tenants is
// under FORCE row-level security keyed to the current tenant, so nothing can
// enumerate tenants to sweep them globally. Its stated cost was that a device
// which never reconnects keeps its stale rows until it does, and that is
// exactly the device whose rows go stale.
//
// The scheduler tick is the second such path. It holds a tenant id taken from
// a live mTLS session, and unlike resume it does not have to be the device
// being swept that supplied it -- so this form drops the device filter and
// reaches the ones that never come back. Ingress retention needs precisely the
// same thing and has no other way to get it, so it rides the same tick rather
// than growing a second timer that would need a second answer to tenant
// enumeration.
//
// Deliberately not merged with PendingForDevice's call: resume must keep
// sweeping on its own, because a tenant whose only device is mid-reconnect has
// no live session for the scheduler to ride on at that moment.
//
// # Two transactions, not one
//
// A retention failure must not roll back command expiry, and vice versa: they
// share a trigger and nothing else, and one temporary fault in either should
// not stall the other indefinitely. The result carries whatever completed
// before the error so the caller can report it.
//
// The retention window itself is not passed from here. It is the default on
// app.prune_ingress, which keeps the policy in one place next to the deletion
// it authorises instead of in a Go constant that a psql session would not see.
func (store SQLPending) ExpireTenantCommands(
	ctx context.Context, tenantID string, now time.Time,
) (SweepResult, error) {
	var result SweepResult
	if store.DB == nil {
		return result, nil
	}
	if err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx,
			`SELECT app.expire_overdue_tenant_commands($1::uuid, $2)`,
			tenantID, now,
		).Scan(&result.ExpiredCommands)
	}); err != nil {
		return result, err
	}
	if err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx,
			`SELECT app.prune_ingress($1::uuid, $2)`,
			tenantID, now,
		).Scan(&result.PrunedIngress)
	}); err != nil {
		return result, err
	}
	return result, nil
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

// settleOutboxSQL retires the wakeup row for a command that has reached a
// terminal state.
//
// The status column is driven to 'published', not left where it was. It used to
// write only resolved_at, and the production consequence was that app.outbox_status
// never left 'pending': 97 of 97 rows pending, 96 of them already resolved, zero
// ever published. app.command_outbox_pending_idx is a partial index on
// `status = 'pending'`, so it covered every wakeup this deployment had ever
// created and could never shrink. At today's volume that is dirty data; once
// scheduled jobs issue commands in batches it is an index that only grows.
//
// The reason nothing published them is that nothing leases them. The two
// existing settle paths in 0002/0033 advance the status with
// `CASE WHEN status = 'leased' THEN 'published' ELSE status END`, which assumes
// every wakeup passes through dispatch.Dispatcher first. Dispatcher has no live
// implementation of OutboxStore.MarkWakeupPublished outside tests, so a row goes
// straight from 'pending' to settled without ever being leased and the CASE
// falls through. Making the settle path unconditional is right regardless of
// whether a publisher appears later: a command with a terminal result has no
// wakeup left to send, and both claim_command_outbox and
// requeue_unresolved_outbox already refuse rows with resolved_at set, so the
// row is unreachable by every scheduler either way.
//
// published_at is deliberately left NULL. Nothing was published. resolved_at
// carries when the row settled, and requeue_unresolved_outbox reads published_at
// only for rows with resolved_at IS NULL, so the NULL is never compared.
// Writing a fabricated publish timestamp would destroy the only evidence that
// distinguishes a wakeup that was really sent from one that never was.
//
// Clearing the lease columns is mandatory, not tidiness:
// command_outbox_lease_shape requires lease_owner and lease_expires_at to be
// NULL for any status other than 'leased'. Forcing 'published' on a leased row
// without clearing them would raise a check violation inside the settle
// transaction -- a database error on the result path, which is how device
// sessions get killed.
const settleOutboxSQL = `
	UPDATE app.command_outbox
	   SET resolved_at = COALESCE(resolved_at, now()),
	       status = 'published',
	       lease_owner = NULL,
	       lease_expires_at = NULL
	 WHERE command_id = $1::uuid
	   AND resolved_at IS NULL`

// recordLateResultSQL preserves a device answer that arrived after the cloud
// already retired the command.
//
// 0037 lets app.expire_overdue_commands retire commands in status 'accepted',
// which opens a window that did not exist before: the device took the command,
// said nothing until after expires_at, and then answered. The primary UPDATE
// above refuses to overwrite a terminal row, so without this the answer would
// be dropped on the floor -- no error, no 500, and no record either.
//
// Only 'expired' and 'cancelled' qualify. Those are the two terminal states the
// cloud assigns on its own, so a later device answer is new information rather
// than a contradiction. 'succeeded', 'failed' and 'unknown' came from the device
// itself; a differing result there is an integrity conflict, and quietly merging
// it would paper over exactly the disagreement worth seeing.
//
// The answer is merged under its own key instead of replacing the row's status.
// The command really did expire -- that is what the cloud decided and acted on,
// and rewriting it to 'succeeded' would make the timeout unauditable.
const recordLateResultSQL = `
	UPDATE app.commands
	   SET result = COALESCE(result, '{}'::jsonb)
	                || jsonb_build_object('late_result', $1::jsonb),
	       updated_at = now()
	 WHERE id = $2::uuid
	   AND status IN ('expired', 'cancelled')`

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
		applied, err := tx.ExecContext(ctx, `
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
		changed, err := applied.RowsAffected()
		if err != nil {
			return err
		}
		if changed == 0 {
			// Either the command is already terminal or it does not exist. The
			// first case is the one worth handling: a device that answered a
			// command the cloud had already given up on.
			late, err := tx.ExecContext(ctx, recordLateResultSQL, string(detail), result.CommandID)
			if err != nil {
				return err
			}
			if recorded, err := late.RowsAffected(); err == nil && recorded > 0 {
				slog.Warn("device answered a command the cloud had already retired",
					"tenant_id", tenantID, "command_id", result.CommandID,
					"late_status", status, "reason_code", result.ReasonCode)
			}
		}
		_, err = tx.ExecContext(ctx, settleOutboxSQL, result.CommandID)
		return err
	})
}

// newestCardPolicySQL reads the last card policy command a device was given.
//
// The newest row is the whole answer. It carries the current intent (an older
// row can only hold a policy set the console has already replaced), and its
// idempotency key carries how many attempts that intent has had -- which is why
// this needs no ledger table and no second counting query on a path that runs
// every few seconds per connected session.
//
// The tenant is named even though row-level security already scopes the read.
// commands_device_issued_idx leads with tenant_id, and without it in the
// predicate this is a sequential scan of every command the deployment holds --
// on a statement that runs every few seconds for every connected session.
// Checked against production: with the tenant it plans as an Index Scan using
// commands_device_issued_idx, stopping at the first row the LIMIT wants.
const newestCardPolicySQL = `
	SELECT c.idempotency_key,
	       c.status::text,
	       c.expires_at,
	       c.accepted_at IS NOT NULL,
	       c.result -> 'late_result' IS NOT NULL,
	       c.payload
	  FROM app.commands AS c
	 WHERE c.tenant_id = $1::uuid
	   AND c.device_id = $2::uuid
	   AND c.kind = 'update_card_policy'
	 ORDER BY c.issued_at DESC
	 LIMIT 1`

// redeliverCardPolicy re-queues the card policy set a device never took.
//
// # Why this is the resume path and not a timer
//
// The set is desired state, and the console is its only producer: an operator
// saves a policy once. When that single push lapses, nothing in the system ever
// derives it again -- and lapsing is not hypothetical, it is the entire recorded
// history of the kind (see queue.go). The device coming back is the moment the
// answer changes, and this is the only hook that runs then and knows which
// device it is.
//
// # Its own transaction
//
// Same reason ExpireTenantCommands uses two: a fault here must not cost the
// caller its pending read. It cannot be folded into that transaction and
// swallowed, because a failed statement aborts the surrounding transaction in
// PostgreSQL -- the read would then fail on commit, PendingForDevice would log
// and return nil, and every queued command for the device would stop being
// delivered. A redelivery that can silence delivery is worse than no redelivery.
//
// Committing first is also what lets the row it writes be picked up by the very
// same pending read, so a device that reconnects after a long outage gets the
// policy in that session rather than the next one.
func (store SQLPending) redeliverCardPolicy(tenantID, deviceID string, now time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var row cardPolicyRow
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, newestCardPolicySQL, tenantID, deviceID).Scan(
			&row.Key, &row.Status, &row.ExpiresAt, &row.Accepted, &row.Late, &row.Payload)
		if errors.Is(err, sql.ErrNoRows) {
			// No policy has ever been pushed to this device. Nothing to repeat:
			// deriving one from app.card_policies here would push a set to a
			// device the console never chose to push to.
			return nil
		}
		if err != nil {
			return err
		}
		if redeliver, why := planCardPolicyRedelivery(row, now); !redeliver {
			slog.Debug("card policy not re-queued", "device_id", deviceID, "reason", why)
			return nil
		}
		payload, err := contractCardPolicyPayload(row.Payload)
		if err != nil {
			// A payload that cannot be read cannot be repaired, and sending it
			// again would only repeat whatever the device already rejected.
			return err
		}
		attempt := cardPolicyAttempts(row.Key)
		id, err := EnqueueTx(ctx, tx, Item{
			TenantID:       tenantID,
			DeviceID:       deviceID,
			Kind:           CardPolicyKind,
			IdempotencyKey: cardPolicyRevivalKey(row.Key, attempt),
			Payload:        payload,
			ExpiresAt:      now.Add(CardPolicyTTL),
		})
		if err != nil {
			return err
		}
		slog.Info("re-queued the card policy this device never took",
			"tenant_id", tenantID, "device_id", deviceID, "command_id", id,
			"attempt", attempt+1, "of", MaxCardPolicyDeliveries, "after", row.Key)
		return nil
	})
	if err != nil {
		slog.Warn("card policy could not be re-queued",
			"tenant_id", tenantID, "device_id", deviceID, "error", err)
	}
}

// contractCardPolicyPayload re-renders a stored payload through the generated
// contract type.
//
// Repairs as well as copies, and that is the point. The edge parses CardPolicy
// with deny_unknown_fields over exactly four fields, and every payload this
// deployment has ever stored carries a fifth: card_routes.go marshalled the
// database row, whose updated_at is not on the wire contract. Verified against
// the deployed binary on 2026-08-26 -- the device logged
//
//	command: invalid envelope: unknown field `updated_at`,
//	expected one of `iccid`, `cellular_enabled`, `vertical`, `apn`
//
// and never answered. Re-rendering keeps the four contract fields verbatim and
// drops what the contract does not define, so a redelivery of a row stored by
// the old code is deliverable even though the original was not.
func contractCardPolicyPayload(stored []byte) ([]byte, error) {
	var command contract.UpdateCardPolicyCommand
	if err := json.Unmarshal(stored, &command); err != nil {
		return nil, err
	}
	if command.Kind == "" || len(command.Policies) == 0 {
		return nil, errors.New("stored card policy payload carries no policies")
	}
	return json.Marshal(command)
}
