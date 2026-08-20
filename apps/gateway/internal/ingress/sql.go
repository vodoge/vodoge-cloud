package ingress

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
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

	ctx, cancel := context.WithTimeout(context.Background(), store.timeout())
	defer cancel()

	tx, err := store.DB.BeginTx(ctx, nil)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, "SELECT set_config('app.tenant_id', $1, true)", record.TenantID); err != nil {
		return Result{}, err
	}

	var status string
	var committed uint64
	var missing json.RawMessage
	var more bool
	err = tx.QueryRowContext(
		ctx,
		`SELECT status, committed_through, missing_ranges, more_missing
		   FROM app.accept_ingress($1, $2, $3, $4, $5, $6::jsonb)`,
		record.TenantID,
		record.DeviceID,
		int64(record.Seq),
		record.EnvelopeID,
		record.Kind,
		string(record.Payload),
	).Scan(&status, &committed, &missing, &more)
	if err != nil {
		return Result{}, mapSQLError(err)
	}
	if err := tx.Commit(); err != nil {
		return Result{}, err
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

	tx, err := store.DB.BeginTx(ctx, nil)
	if err != nil {
		return Window{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return Window{}, err
	}

	var committed uint64
	var missing json.RawMessage
	var more bool
	err = tx.QueryRowContext(
		ctx,
		`SELECT committed_through, missing_ranges, more_missing
		   FROM app.ingress_window($1, $2)`,
		tenantID,
		deviceID,
	).Scan(&committed, &missing, &more)
	if err != nil {
		return Window{}, err
	}
	if err := tx.Commit(); err != nil {
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

func mapSQLError(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "sequence conflict") {
		return fmt.Errorf("%w: %v", ErrConflict, err)
	}
	return err
}
