package directory

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/region"
)

func TestResolveDoesNotInventADefaultTenant(t *testing.T) {
	t.Parallel()

	resolver := New(nil)
	entry, ok, err := resolver.Resolve(context.Background(), "missing")
	if err != nil || ok {
		t.Fatalf("missing slug = %+v ok=%v err=%v", entry, ok, err)
	}
	_, ok, err = resolver.Resolve(context.Background(), "")
	if err != nil || ok {
		t.Fatal("empty slug must not resolve")
	}
}

func TestResolveCachesAndNeverChangesRegion(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	resolver := New(func(_ context.Context, slug string) (region.Entry, bool, error) {
		calls.Add(1)
		if slug != "apple" {
			return region.Entry{}, false, nil
		}
		return region.Entry{TenantID: "t1", Slug: "apple", Region: "cn", Status: "active"}, true, nil
	})

	first, ok, err := resolver.Resolve(context.Background(), "Apple")
	if err != nil || !ok || first.TenantID != "t1" || first.Region != "cn" {
		t.Fatalf("first = %+v ok=%v err=%v", first, ok, err)
	}
	second, ok, err := resolver.Resolve(context.Background(), "apple")
	if err != nil || !ok || second != first {
		t.Fatalf("cache miss on second lookup: %+v", second)
	}
	if calls.Load() != 1 {
		t.Fatalf("lookup calls = %d, want 1", calls.Load())
	}
}

func TestServeHTTPUnknownSlugIs404(t *testing.T) {
	t.Parallel()

	resolver := New(func(context.Context, string) (region.Entry, bool, error) {
		return region.Entry{TenantID: "should-not-use", Slug: "default", Region: "cn", Status: "active"}, false, nil
	})
	mux := http.NewServeMux()
	mux.Handle("GET /v1/tenants/{slug}", resolver)

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/tenants/missing", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}

	resolver.Cache.Store(region.Entry{TenantID: "t1", Slug: "apple", Region: "cn", Status: "active"})
	found := httptest.NewRecorder()
	mux.ServeHTTP(found, httptest.NewRequest(http.MethodGet, "/v1/tenants/apple", nil))
	if found.Code != http.StatusOK {
		t.Fatalf("known slug status = %d", found.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(found.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["tenant_id"] != "t1" || body["region"] != "cn" {
		t.Fatalf("body = %v", body)
	}
}
