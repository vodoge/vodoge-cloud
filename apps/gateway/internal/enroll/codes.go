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

// CodeSummary is one code as the console may see it again: everything needed to
// manage it, and **not the code**.
//
// 🔴 刻意漏掉那个秘密，和 `Certificate` 刻意不带 PEM 是同一条理由。OpenAPI 从
//
//	一开始就写着这个码「is returned once here」「in full, for the only time」,
//	而在这之前 `GET /v1/enrollment-codes` 把它原样发回来 —— 一个能被反复读取
//	的一次性凭据不是一次性的，控制台上那句「只显示一次」也就成了假话。
//
// ⚠️ 连前缀都不给。8 个字符的码给出任何一段都是在削减它的熵，而列表要回答的
//
//	问题（还有几个没被用掉、哪个什么时候过期、哪台设备用掉了哪一个）一个字符
//	的码都不需要。
type CodeSummary struct {
	ID        string  `json:"id"`
	ExpiresAt int64   `json:"expires_at"`
	UsedAt    *int64  `json:"used_at"`
	DeviceID  *string `json:"device_id"`
}

// CodeStore lists and creates tenant enrollment codes.
type CodeStore interface {
	List(ctx context.Context, tenantID string) ([]CodeSummary, error)
	Create(ctx context.Context, tenantID string, ttl time.Duration) (Code, error)
}

// MemoryCodes is an in-process code list for tests.
type MemoryCodes struct {
	mu    sync.Mutex
	Codes map[string][]Code
}

// List returns codes for tenantID only, without the codes themselves.
func (store *MemoryCodes) List(_ context.Context, tenantID string) ([]CodeSummary, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := make([]CodeSummary, 0, len(store.Codes[tenantID]))
	for _, item := range store.Codes[tenantID] {
		out = append(out, CodeSummary{
			ID:        item.ID,
			ExpiresAt: item.ExpiresAt,
			UsedAt:    item.UsedAt,
			DeviceID:  item.DeviceID,
		})
	}
	return out, nil
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
	// 🔴 id 和码必须是两个不同的值。生产上 id 是一个独立的 uuid（见下面
	//    SQLCodes.Create 的 RETURNING），而这个替身原来把两者写成同一个串 ——
	//    于是「响应里出现了那个秘密」这条断言在它身上永远分不清是 id 漏了还是
	//    码漏了。一个 id 等于秘密的替身，测不出秘密有没有漏。
	id, err := randomCode(12)
	if err != nil {
		return Code{}, err
	}
	item := Code{
		ID:        id,
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
func (store SQLCodes) List(ctx context.Context, tenantID string) ([]CodeSummary, error) {
	var codes []CodeSummary
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		// 🔴 `code` 不在 SELECT 里。不是取出来再不序列化 —— 根本不读，秘密就
		//    没有经过这个进程的内存、日志和任何一层 marshal。
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text, expires_at, used_at, device_id::text
			  FROM app.enrollment_codes
			 ORDER BY created_at DESC
			 LIMIT 100`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item CodeSummary
			var expires time.Time
			var used sql.NullTime
			var device sql.NullString
			if err := rows.Scan(&item.ID, &expires, &used, &device); err != nil {
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
		codes = []CodeSummary{}
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
