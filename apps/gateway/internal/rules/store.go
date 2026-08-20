package rules

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Rule is one tenant extract/forward definition.
type Rule struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Matcher json.RawMessage `json:"matcher"`
	Action  json.RawMessage `json:"action"`
	Enabled bool            `json:"enabled"`
}

// Store loads tenant rules through SET LOCAL.
type Store interface {
	List(ctx context.Context, tenantID string) ([]Rule, error)
}

// Memory is an in-process rule list for tests.
type Memory struct {
	mu    sync.Mutex
	Rules map[string][]Rule
}

// List returns rules for tenantID only.
func (store *Memory) List(_ context.Context, tenantID string) ([]Rule, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := store.Rules[tenantID]
	if out == nil {
		return []Rule{}, nil
	}
	copied := make([]Rule, len(out))
	copy(copied, out)
	return copied, nil
}

// SQL reads app.rules.
type SQL struct {
	DB *sql.DB
}

// List returns enabled and disabled rules for the tenant.
func (store SQL) List(ctx context.Context, tenantID string) ([]Rule, error) {
	var rules []Rule
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text, name, matcher, action, enabled
			  FROM app.rules
			 ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Rule
			if err := rows.Scan(&item.ID, &item.Name, &item.Matcher, &item.Action, &item.Enabled); err != nil {
				return err
			}
			rules = append(rules, item)
		}
		return rows.Err()
	})
	if rules == nil {
		rules = []Rule{}
	}
	return rules, err
}
