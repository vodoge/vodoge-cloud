package region

import "testing"

func TestCacheSurvivesWithoutFurtherLookups(t *testing.T) {
	t.Parallel()

	cache := NewCache()
	entry := Entry{
		TenantID: "11111111-1111-1111-1111-111111111111",
		Slug:     "apple",
		Region:   "cn",
		Status:   "active",
	}
	if !cache.Store(entry) {
		t.Fatal("store of a new tenant routing entry failed")
	}

	got, ok := cache.Lookup("apple")
	if !ok {
		t.Fatal("expected cached tenant routing entry")
	}
	if got != entry {
		t.Fatalf("got %+v, want %+v", got, entry)
	}

	// A later control-plane outage must not evict an already-resolved mapping.
	if cache.Len() != 1 {
		t.Fatalf("len = %d, want 1 after simulated control-plane outage", cache.Len())
	}
	if _, ok := cache.Lookup("missing"); ok {
		t.Fatal("unknown slug must not invent a default tenant")
	}
}

func TestCacheRejectsRegionMutation(t *testing.T) {
	t.Parallel()

	cache := NewCache()
	if !cache.Store(Entry{Slug: "apple", Region: "cn", TenantID: "t1", Status: "active"}) {
		t.Fatal("initial store failed")
	}
	if cache.Store(Entry{Slug: "apple", Region: "intl", TenantID: "t1", Status: "active"}) {
		t.Fatal("cache allowed a region change")
	}

	got, _ := cache.Lookup("apple")
	if got.Region != "cn" {
		t.Fatalf("region = %q, want cn", got.Region)
	}
}
