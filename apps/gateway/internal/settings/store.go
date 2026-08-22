package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Store reads and writes one tenant's settings.
type Store interface {
	All(ctx context.Context, tenantID string) (map[string]map[string]any, error)
	Get(ctx context.Context, tenantID, section string) (map[string]any, error)
	Put(ctx context.Context, tenantID, section string, document map[string]any) error
}

// SQL is the PostgreSQL store, reading through the tenant's RLS context.
type SQL struct{ DB *sql.DB }

func (store SQL) All(ctx context.Context, tenantID string) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT section, value FROM app.tenant_settings ORDER BY section`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var section string
			var raw []byte
			if err := rows.Scan(&section, &raw); err != nil {
				return err
			}
			var document map[string]any
			if err := json.Unmarshal(raw, &document); err != nil {
				return err
			}
			out[section] = document
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	// Every section is present in the response whether or not it has ever been
	// saved, so the console renders the same form either way.
	for _, section := range Sections() {
		if _, ok := out[section]; !ok {
			out[section] = map[string]any{}
		}
	}
	return out, nil
}

func (store SQL) Get(ctx context.Context, tenantID, section string) (map[string]any, error) {
	document := map[string]any{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		var raw []byte
		err := tx.QueryRowContext(ctx,
			`SELECT value FROM app.tenant_settings WHERE section = $1`, section).Scan(&raw)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, &document)
	})
	if err != nil {
		return nil, err
	}
	return document, nil
}

func (store SQL) Put(ctx context.Context, tenantID, section string, document map[string]any) error {
	encoded, err := json.Marshal(document)
	if err != nil {
		return err
	}
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.tenant_settings (tenant_id, section, value)
			VALUES (app.current_tenant_id(), $1, $2::jsonb)
			ON CONFLICT (tenant_id, section) DO UPDATE
			   SET value = EXCLUDED.value,
			       updated_at = now()`, section, string(encoded))
		return err
	})
}

// Memory is the store used when PostgreSQL is not configured, and by tests.
type Memory struct {
	mu    sync.Mutex
	items map[string]map[string]map[string]any
}

func (store *Memory) All(_ context.Context, tenantID string) (map[string]map[string]any, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := map[string]map[string]any{}
	for section, document := range store.items[tenantID] {
		out[section] = document
	}
	for _, section := range Sections() {
		if _, ok := out[section]; !ok {
			out[section] = map[string]any{}
		}
	}
	return out, nil
}

func (store *Memory) Get(_ context.Context, tenantID, section string) (map[string]any, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if document, ok := store.items[tenantID][section]; ok {
		return document, nil
	}
	return map[string]any{}, nil
}

func (store *Memory) Put(
	_ context.Context,
	tenantID, section string,
	document map[string]any,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.items == nil {
		store.items = map[string]map[string]map[string]any{}
	}
	if store.items[tenantID] == nil {
		store.items[tenantID] = map[string]map[string]any{}
	}
	store.items[tenantID][section] = document
	return nil
}
