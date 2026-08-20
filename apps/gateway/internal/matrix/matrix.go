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
		Version string `json:"version"`
	}
	if err := json.Unmarshal(canonical, &document); err != nil {
		return Overlay{}, fmt.Errorf("%w: %v", ErrInvalidDocument, err)
	}
	if document.Version == "" {
		return Overlay{}, fmt.Errorf("%w: version is required", ErrInvalidDocument)
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
