// Package tenant is the only way a gateway transaction binds app.tenant_id.
//
// SET LOCAL (set_config is_local=true) is mandatory. A pooled connection that
// reused SET without LOCAL would leak the previous tenant into the next request.
package tenant

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var (
	// ErrMissingTenant means the caller tried to open a tenant transaction without an id.
	ErrMissingTenant = errors.New("tenant id is required")
)

// BindSQL is the first statement of every tenant-scoped transaction.
// The third argument true is SET LOCAL: the setting dies with the transaction.
const BindSQL = "SELECT set_config('app.tenant_id', $1, true)"

// Transact opens a transaction, binds tenant_id, runs fn, then commits.
func Transact(ctx context.Context, db *sql.DB, tenantID string, fn func(*sql.Tx) error) error {
	if strings.TrimSpace(tenantID) == "" {
		return ErrMissingTenant
	}
	if db == nil {
		return errors.New("database is not configured")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, BindSQL, tenantID); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}
