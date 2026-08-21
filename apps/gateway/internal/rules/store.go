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
	Create(ctx context.Context, tenantID string, rule Rule) (Rule, error)
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

// Create appends a rule for tenantID.
func (store *Memory) Create(_ context.Context, tenantID string, rule Rule) (Rule, error) {
	if rule.ID == "" {
		rule.ID = rule.Name
	}
	if len(rule.Matcher) == 0 {
		rule.Matcher = json.RawMessage(`{}`)
	}
	if len(rule.Action) == 0 {
		rule.Action = json.RawMessage(`{"kind":"extract"}`)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.Rules == nil {
		store.Rules = map[string][]Rule{}
	}
	store.Rules[tenantID] = append(store.Rules[tenantID], rule)
	return rule, nil
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

// Create inserts one tenant rule.
func (store SQL) Create(ctx context.Context, tenantID string, rule Rule) (Rule, error) {
	if len(rule.Matcher) == 0 {
		rule.Matcher = json.RawMessage(`{}`)
	}
	if len(rule.Action) == 0 {
		rule.Action = json.RawMessage(`{"kind":"extract"}`)
	}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `
			INSERT INTO app.rules (tenant_id, name, matcher, action, enabled)
			VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)
			RETURNING id::text, name, matcher, action, enabled`,
			tenantID, rule.Name, string(rule.Matcher), string(rule.Action), rule.Enabled,
		).Scan(&rule.ID, &rule.Name, &rule.Matcher, &rule.Action, &rule.Enabled)
	})
	return rule, err
}
