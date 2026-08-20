// Package region caches the tenant-to-region mapping from the global control
// plane. The mapping is almost immutable, so a resolved entry remains usable if
// the global database later becomes unreachable.
package region

import "sync"

// Entry is the cached result of resolving a tenant hostname slug.
type Entry struct {
	TenantID string
	Slug     string
	Region   string
	Status   string
}

// Cache stores resolved tenant routing information. It is safe for concurrent use.
type Cache struct {
	mu      sync.RWMutex
	entries map[string]Entry
}

// NewCache returns an empty tenant-to-region cache.
func NewCache() *Cache {
	return &Cache{entries: make(map[string]Entry)}
}

// Lookup returns a previously stored routing entry. A miss does not imply the
// tenant does not exist; it only means this process has not resolved it yet.
func (cache *Cache) Lookup(slug string) (Entry, bool) {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	entry, ok := cache.entries[slug]
	return entry, ok
}

// Store records a routing entry. Region is treated as immutable: a later store
// for the same slug with a different region is ignored and reports false.
func (cache *Cache) Store(entry Entry) bool {
	cache.mu.Lock()
	defer cache.mu.Unlock()

	if existing, ok := cache.entries[entry.Slug]; ok && existing.Region != entry.Region {
		return false
	}
	cache.entries[entry.Slug] = entry
	return true
}

// Len returns the number of cached routing entries.
func (cache *Cache) Len() int {
	cache.mu.RLock()
	defer cache.mu.RUnlock()
	return len(cache.entries)
}
