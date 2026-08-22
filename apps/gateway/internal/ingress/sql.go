package ingress

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// SQLStore persists sequenced envelopes through app.accept_ingress.
type SQLStore struct {
	DB      *sql.DB
	Timeout time.Duration
}

func (store *SQLStore) timeout() time.Duration {
	if store.Timeout > 0 {
		return store.Timeout
	}
	return 5 * time.Second
}

// Ping reports whether PostgreSQL is reachable.
func (store *SQLStore) Ping() error {
	if store == nil || store.DB == nil {
		return fmt.Errorf("%w: sql store is not configured", ErrInvalidRecord)
	}
	ctx, cancel := context.WithTimeout(context.Background(), store.timeout())
	defer cancel()
	return store.DB.PingContext(ctx)
}

// Accept records one sequenced envelope in PostgreSQL, then returns the durable window.
func (store *SQLStore) Accept(record Record) (Result, error) {
	if store == nil || store.DB == nil {
		return Result{}, fmt.Errorf("%w: sql store is not configured", ErrInvalidRecord)
	}
	if record.TenantID == "" {
		return Result{}, fmt.Errorf("%w: tenant is required", ErrInvalidRecord)
	}
	if !json.Valid(record.Payload) {
		return Result{}, fmt.Errorf("%w: payload is not JSON", ErrInvalidRecord)
	}
	// jsonb cannot hold a NUL and rejects the whole document over one. The
	// record is otherwise fine, so the code point goes rather than the record.
	payload, scrubbed := stripNulls(record.Payload)
	if scrubbed {
		slog.Warn("removed NUL code points a jsonb column cannot store",
			"tenant_id", record.TenantID, "device_id", record.DeviceID,
			"kind", record.Kind, "envelope_id", record.EnvelopeID, "seq", record.Seq)
	}

	ctx, cancel := context.WithTimeout(context.Background(), store.timeout())
	defer cancel()

	var status string
	var committed uint64
	var missing json.RawMessage
	var more bool
	err := tenant.Transact(ctx, store.DB, record.TenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(
			ctx,
			`SELECT status, committed_through, missing_ranges, more_missing
			   FROM app.accept_ingress($1, $2, $3, $4, $5, $6::jsonb)`,
			record.TenantID,
			record.DeviceID,
			int64(record.Seq),
			record.EnvelopeID,
			record.Kind,
			string(payload),
		).Scan(&status, &committed, &missing, &more)
	})
	if err != nil {
		return Result{}, mapSQLError(err)
	}

	window, err := parseWindow(committed, missing, more)
	if err != nil {
		return Result{}, err
	}
	result := Result{Window: window}
	switch status {
	case "inserted":
		result.Status = StatusInserted
	case "duplicate":
		result.Status = StatusDuplicate
	default:
		return Result{}, fmt.Errorf("%w: unknown ingress status %q", ErrInvalidRecord, status)
	}
	return result, nil
}

// RecordUnstorable fills a sequence with a tombstone when the real record can
// never be stored, so the device's contiguous prefix can advance past it.
//
// Without this the uplink stalls permanently on the first such record: the
// prefix cannot cross a sequence that was never written, so the device replays
// it on every reconnect and everything queued behind it waits forever.
func (store *SQLStore) RecordUnstorable(record Record, reason string) error {
	if store == nil || store.DB == nil {
		return fmt.Errorf("%w: sql store is not configured", ErrInvalidRecord)
	}
	if record.TenantID == "" || record.DeviceID == "" || record.EnvelopeID == "" {
		return fmt.Errorf("%w: tenant, device, and envelope are required", ErrInvalidRecord)
	}

	ctx, cancel := context.WithTimeout(context.Background(), store.timeout())
	defer cancel()

	var status string
	err := tenant.Transact(ctx, store.DB, record.TenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(
			ctx,
			`SELECT app.record_unstorable_ingress($1, $2, $3, $4, $5, $6)`,
			record.TenantID,
			record.DeviceID,
			int64(record.Seq),
			record.EnvelopeID,
			record.Kind,
			reason,
		).Scan(&status)
	})
	if err != nil {
		return fmt.Errorf("record unstorable ingress: %w", err)
	}
	return nil
}

// Snapshot reads the durable contiguous prefix for a device.
func (store *SQLStore) Snapshot(tenantID, deviceID string) (Window, error) {
	if store == nil || store.DB == nil {
		return Window{}, fmt.Errorf("%w: sql store is not configured", ErrInvalidRecord)
	}
	if tenantID == "" || deviceID == "" {
		return Window{}, fmt.Errorf("%w: tenant and device are required", ErrInvalidRecord)
	}

	ctx, cancel := context.WithTimeout(context.Background(), store.timeout())
	defer cancel()

	var committed uint64
	var missing json.RawMessage
	var more bool
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(
			ctx,
			`SELECT committed_through, missing_ranges, more_missing
			   FROM app.ingress_window($1, $2)`,
			tenantID,
			deviceID,
		).Scan(&committed, &missing, &more)
	})
	if err != nil {
		return Window{}, err
	}
	return parseWindow(committed, missing, more)
}

func parseWindow(committed uint64, missing json.RawMessage, more bool) (Window, error) {
	type encodedRange struct {
		From    string `json:"from"`
		Through string `json:"through"`
	}
	ranges := make([]encodedRange, 0)
	if len(missing) > 0 && string(missing) != "null" {
		if err := json.Unmarshal(missing, &ranges); err != nil {
			return Window{}, fmt.Errorf("decode missing_ranges: %w", err)
		}
	}
	window := Window{
		CommittedThrough: committed,
		MissingRanges:    make([]Range, 0, len(ranges)),
		MoreMissing:      more,
	}
	for _, item := range ranges {
		from, err := parseDecimal(item.From)
		if err != nil {
			return Window{}, err
		}
		through, err := parseDecimal(item.Through)
		if err != nil {
			return Window{}, err
		}
		window.MissingRanges = append(window.MissingRanges, Range{From: from, Through: through})
	}
	return window, nil
}

func parseDecimal(raw string) (uint64, error) {
	var value uint64
	if raw == "" {
		return 0, fmt.Errorf("%w: empty sequence", ErrInvalidRecord)
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("%w: invalid sequence %q", ErrInvalidRecord, raw)
		}
		value = value*10 + uint64(r-'0')
	}
	return value, nil
}

// ErrMalformed marks a record this database can never store, however many
// times it is offered — a field that does not fit its column's type, or a
// constraint the value violates by construction.
//
// It exists so the uplink can tell "try again" from "this will never work".
// Treating the second as the first is how one bad envelope from one device
// becomes a permanent reconnect loop: the session dies, the edge replays the
// same record, and nothing else that device has to say ever gets through.
var ErrMalformed = errors.New("record cannot be stored")

func mapSQLError(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "sequence conflict") {
		return fmt.Errorf("%w: %v", ErrConflict, err)
	}
	// PostgreSQL class 22 is data exception and class 23 is integrity
	// constraint violation. Both mean the value is wrong, not that the
	// database is unwell, and no amount of retrying changes either.
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) &&
		(strings.HasPrefix(pgErr.Code, "22") || strings.HasPrefix(pgErr.Code, "23")) {
		return fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return err
}
