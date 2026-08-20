// Package directory resolves hostname slugs to tenants in the shared database.
//
// Unknown slugs are a miss, never a default tenant. Successful lookups are
// cached; a cached region cannot be overwritten with a different value.
package directory

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/region"
)

// Lookup loads one tenant by slug from storage. ok is false when the slug is unknown.
type Lookup func(ctx context.Context, slug string) (region.Entry, bool, error)

// Resolver is the cached slug directory used by Host routing.
type Resolver struct {
	Cache      *region.Cache
	Lookup     Lookup
	BaseDomain string
}

// New returns a resolver. A nil lookup means only primed cache entries resolve.
func New(lookup Lookup) *Resolver {
	return &Resolver{
		Cache:      region.NewCache(),
		Lookup:     lookup,
		BaseDomain: DefaultBaseDomain,
	}
}

// Resolve returns the tenant for slug. Empty or unknown slugs are not found.
func (resolver *Resolver) Resolve(ctx context.Context, slug string) (region.Entry, bool, error) {
	slug = strings.ToLower(strings.TrimSpace(slug))
	if slug == "" {
		return region.Entry{}, false, nil
	}
	if resolver == nil {
		return region.Entry{}, false, nil
	}
	if entry, ok := resolver.Cache.Lookup(slug); ok {
		return entry, true, nil
	}
	if resolver.Lookup == nil {
		return region.Entry{}, false, nil
	}
	entry, ok, err := resolver.Lookup(ctx, slug)
	if err != nil || !ok {
		return region.Entry{}, ok, err
	}
	entry.Slug = slug
	_ = resolver.Cache.Store(entry)
	return entry, true, nil
}

// SQLLookup uses app.resolve_tenant, which does not need SET LOCAL.
func SQLLookup(db *sql.DB) Lookup {
	return func(ctx context.Context, slug string) (region.Entry, bool, error) {
		if db == nil {
			return region.Entry{}, false, errors.New("database is not configured")
		}
		var entry region.Entry
		err := db.QueryRowContext(
			ctx,
			`SELECT id::text, slug, status, region FROM app.resolve_tenant($1)`,
			slug,
		).Scan(&entry.TenantID, &entry.Slug, &entry.Status, &entry.Region)
		if errors.Is(err, sql.ErrNoRows) {
			return region.Entry{}, false, nil
		}
		if err != nil {
			return region.Entry{}, false, err
		}
		return entry, true, nil
	}
}

// ServeHTTP is GET /v1/tenants/{slug}. Unknown slugs are 404.
func (resolver *Resolver) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	resolver.writeTenant(writer, request, request.PathValue("slug"))
}

// ServeHost is GET /v1/tenant. The tenant comes from Host, e.g. a.vodoge.com.
func (resolver *Resolver) ServeHost(writer http.ResponseWriter, request *http.Request) {
	base := resolver.BaseDomain
	if base == "" {
		base = DefaultBaseDomain
	}
	slug, ok := SlugFromHost(requestHost(request), base)
	if !ok {
		writeTenantError(writer, http.StatusNotFound, "unknown tenant")
		return
	}
	resolver.writeTenant(writer, request, slug)
}

func (resolver *Resolver) writeTenant(writer http.ResponseWriter, request *http.Request, slug string) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")

	entry, ok, err := resolver.Resolve(request.Context(), slug)
	if err != nil {
		writeTenantError(writer, http.StatusInternalServerError, "tenant lookup failed")
		return
	}
	if !ok {
		writeTenantError(writer, http.StatusNotFound, "unknown tenant")
		return
	}
	_ = json.NewEncoder(writer).Encode(map[string]string{
		"tenant_id": entry.TenantID,
		"slug":      entry.Slug,
		"region":    entry.Region,
		"status":    entry.Status,
	})
}

func writeTenantError(writer http.ResponseWriter, code int, message string) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(code)
	_ = json.NewEncoder(writer).Encode(map[string]string{"error": message})
}
