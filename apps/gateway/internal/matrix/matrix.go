// Package matrix stores the tenant capability overlay and its sha256.
package matrix

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

var (
	// ErrInvalidDocument means the overlay is not a JSON object with a version.
	ErrInvalidDocument = errors.New("invalid capability matrix")
)

// Overlay is the tenant-scoped matrix the edge should install.
type Overlay struct {
	Version  string          `json:"version"`
	SHA256   string          `json:"sha256"`
	Document json.RawMessage `json:"matrix"`
}

// Store loads and saves one overlay per tenant.
type Store interface {
	Get(ctx context.Context, tenantID string) (Overlay, bool, error)
	Put(ctx context.Context, tenantID string, overlay Overlay) error
}

// Empty never has an overlay.
type Empty struct{}

// Get reports a miss.
func (Empty) Get(context.Context, string) (Overlay, bool, error) {
	return Overlay{}, false, nil
}

// Put rejects writes when PostgreSQL is not configured.
func (Empty) Put(context.Context, string, Overlay) error {
	return errors.New("capability matrix store is not configured")
}

// Memory is an in-process overlay used by tests.
type Memory struct {
	mu      sync.Mutex
	entries map[string]Overlay
}

// Get returns the overlay for tenantID only.
func (store *Memory) Get(_ context.Context, tenantID string) (Overlay, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	overlay, ok := store.entries[tenantID]
	return overlay, ok, nil
}

// Put replaces the overlay for tenantID.
func (store *Memory) Put(_ context.Context, tenantID string, overlay Overlay) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.entries == nil {
		store.entries = map[string]Overlay{}
	}
	store.entries[tenantID] = overlay
	return nil
}

// SQL persists app.capability_matrix through tenant.Transact.
type SQL struct {
	DB *sql.DB
}

// Get loads the tenant overlay.
func (store SQL) Get(ctx context.Context, tenantID string) (Overlay, bool, error) {
	var overlay Overlay
	var found bool
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `
			SELECT version, sha256, document
			  FROM app.capability_matrix`).Scan(&overlay.Version, &overlay.SHA256, &overlay.Document)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		return nil
	})
	return overlay, found, err
}

// Put upserts the tenant overlay.
func (store SQL) Put(ctx context.Context, tenantID string, overlay Overlay) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.capability_matrix (tenant_id, version, sha256, document)
			VALUES ($1, $2, $3, $4::jsonb)
			ON CONFLICT (tenant_id) DO UPDATE
			   SET version = excluded.version,
			       sha256 = excluded.sha256,
			       document = excluded.document,
			       updated_at = now()`,
			tenantID, overlay.Version, overlay.SHA256, string(overlay.Document))
		return err
	})
}

// Parse validates the matrix object, canonicalizes it, and fills version/sha256.
func Parse(raw json.RawMessage) (Overlay, error) {
	canonical, err := Canonical(raw)
	if err != nil {
		return Overlay{}, err
	}
	var document struct {
		Version string            `json:"version"`
		Rule    []json.RawMessage `json:"rule"`
	}
	if err := json.Unmarshal(canonical, &document); err != nil {
		return Overlay{}, fmt.Errorf("%w: %v", ErrInvalidDocument, err)
	}
	if document.Version == "" {
		return Overlay{}, fmt.Errorf("%w: version is required", ErrInvalidDocument)
	}
	// 🔴 一份没有规则的矩阵会清空收到它的每一台设备。
	//
	// `{"version":"x"}` 此前一路畅通：上面只检查「是对象、version 非空」。
	// 它落库、被推给该租户的每一台设备，而**边缘端也接受它** ——
	// `MatrixDocument.rule` 是 `#[serde(default)]`，所以它解析成一个空矩阵。
	// 实测（2026-09-05，edge-core）：规则数=0，EC20 x CN-Mobile 的来源
	// 变成 Fallback。于是每一对都读作「从没测过」，短信全被拒，
	// 纳管的追溯执行会把每一根都判进隔离。一次普通租户会话的 PUT 就能做到。
	//
	// 这条规则本来就写下来了 —— 在 ledger_routes.go 的 publishLedger 里：
	// 「An empty ledger is "nothing is supported". That may well be true on a
	// fresh tenant, but pushing it is not how anybody would mean to say it,
	// so it has to be a deliberate act rather than a stray click.」
	// 它只挡住了账本那条路；`PUT /v1/capability-matrix` 从旁边绕了过去。
	//
	// 放在 Parse 里而不是再抄一遍到 putMatrix：这是**唯一**同时在两条路上的
	// 函数（publishLedger 和 publish-ledger CLI 都走它，注释里写明了理由是
	// 摘要必须逐字节一致），所以放这里两条路自动都有。
	if len(document.Rule) == 0 {
		return Overlay{}, fmt.Errorf(
			"%w: a matrix with no rules would clear every device that receives it",
			ErrInvalidDocument)
	}
	sum := sha256.Sum256(canonical)
	return Overlay{
		Version:  document.Version,
		SHA256:   hex.EncodeToString(sum[:]),
		Document: canonical,
	}, nil
}

// Canonical re-encodes JSON so Go map keys match serde BTreeMap order.
func Canonical(raw json.RawMessage) ([]byte, error) {
	if !json.Valid(raw) {
		return nil, fmt.Errorf("%w: not json", ErrInvalidDocument)
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidDocument, err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: matrix must be an object", ErrInvalidDocument)
	}
	return json.Marshal(object)
}

// CommandPayload is the UpdateCapabilityMatrix body delivered to the edge.
func CommandPayload(overlay Overlay) ([]byte, error) {
	return json.Marshal(struct {
		Kind    string          `json:"kind"`
		Version string          `json:"matrix_version"`
		SHA256  string          `json:"matrix_sha256"`
		Matrix  json.RawMessage `json:"matrix"`
	}{
		Kind:    "UpdateCapabilityMatrix",
		Version: overlay.Version,
		SHA256:  overlay.SHA256,
		Matrix:  overlay.Document,
	})
}
