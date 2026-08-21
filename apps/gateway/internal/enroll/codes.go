package enroll

import (
	"context"
	"crypto/rand"
	"database/sql"
	"strings"
	"sync"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// Code is one one-time enrollment code shown to an operator.
type Code struct {
	ID        string  `json:"id"`
	Code      string  `json:"code"`
	ExpiresAt int64   `json:"expires_at"`
	UsedAt    *int64  `json:"used_at"`
	DeviceID  *string `json:"device_id"`
}

// CodeStore lists and creates tenant enrollment codes.
type CodeStore interface {
	List(ctx context.Context, tenantID string) ([]Code, error)
	Create(ctx context.Context, tenantID string, ttl time.Duration) (Code, error)
}

// MemoryCodes is an in-process code list for tests.
type MemoryCodes struct {
	mu    sync.Mutex
	Codes map[string][]Code
}

// List returns codes for tenantID only.
func (store *MemoryCodes) List(_ context.Context, tenantID string) ([]Code, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := store.Codes[tenantID]
	if out == nil {
		return []Code{}, nil
	}
	copied := make([]Code, len(out))
	copy(copied, out)
	return copied, nil
}

// Create appends a new unused code.
func (store *MemoryCodes) Create(_ context.Context, tenantID string, ttl time.Duration) (Code, error) {
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	value, err := randomCode(8)
	if err != nil {
		return Code{}, err
	}
	item := Code{
		ID:        value,
		Code:      value,
		ExpiresAt: time.Now().Add(ttl).UnixMilli(),
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.Codes == nil {
		store.Codes = map[string][]Code{}
	}
	store.Codes[tenantID] = append([]Code{item}, store.Codes[tenantID]...)
	return item, nil
}

// SQLCodes reads and inserts app.enrollment_codes.
type SQLCodes struct {
	DB *sql.DB
}

// List returns unused and used codes, newest first.
func (store SQLCodes) List(ctx context.Context, tenantID string) ([]Code, error) {
	var codes []Code
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text, code, expires_at, used_at, device_id::text
			  FROM app.enrollment_codes
			 ORDER BY created_at DESC
			 LIMIT 100`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Code
			var expires time.Time
			var used sql.NullTime
			var device sql.NullString
			if err := rows.Scan(&item.ID, &item.Code, &expires, &used, &device); err != nil {
				return err
			}
			item.ExpiresAt = expires.UnixMilli()
			if used.Valid {
				ms := used.Time.UnixMilli()
				item.UsedAt = &ms
			}
			if device.Valid {
				item.DeviceID = &device.String
			}
			codes = append(codes, item)
		}
		return rows.Err()
	})
	if codes == nil {
		codes = []Code{}
	}
	return codes, err
}

// Create inserts a one-time code that POST /v1/enroll can consume.
func (store SQLCodes) Create(ctx context.Context, tenantID string, ttl time.Duration) (Code, error) {
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	value, err := randomCode(8)
	if err != nil {
		return Code{}, err
	}
	var item Code
	var expires time.Time
	err = tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `
			INSERT INTO app.enrollment_codes (tenant_id, code, expires_at)
			VALUES ($1::uuid, $2, now() + make_interval(secs => $3))
			RETURNING id::text, code, expires_at`,
			tenantID, value, int(ttl.Seconds()),
		).Scan(&item.ID, &item.Code, &expires)
	})
	if err != nil {
		return Code{}, err
	}
	item.ExpiresAt = expires.UnixMilli()
	return item, nil
}

func randomCode(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	var b strings.Builder
	b.Grow(n)
	for _, value := range raw {
		b.WriteByte(codeAlphabet[int(value)%len(codeAlphabet)])
	}
	return b.String(), nil
}
