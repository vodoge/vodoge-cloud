package cards

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Memory is the store used when PostgreSQL is not configured, and by tests.
type Memory struct {
	mu       sync.Mutex
	policies map[string]map[string]Policy
}

func (store *Memory) List(_ context.Context, tenantID string) ([]Policy, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []Policy{}
	for _, policy := range store.policies[tenantID] {
		out = append(out, policy)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ICCID < out[j].ICCID })
	return out, nil
}

func (store *Memory) Get(_ context.Context, tenantID, iccid string) (Policy, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	policy, ok := store.policies[tenantID][iccid]
	return policy, ok, nil
}

func (store *Memory) Save(_ context.Context, tenantID string, policy Policy) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.policies == nil {
		store.policies = map[string]map[string]Policy{}
	}
	if store.policies[tenantID] == nil {
		store.policies[tenantID] = map[string]Policy{}
	}
	policy.UpdatedAt = time.Now().UnixMilli()
	store.policies[tenantID][policy.ICCID] = policy
	return nil
}

func (store *Memory) Delete(_ context.Context, tenantID, iccid string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.policies[tenantID], iccid)
	return nil
}

func (store *Memory) Version(_ context.Context, tenantID string) (string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	var latest int64
	for _, policy := range store.policies[tenantID] {
		if policy.UpdatedAt > latest {
			latest = policy.UpdatedAt
		}
	}
	return fmt.Sprintf("%d-%d", len(store.policies[tenantID]), latest/1000), nil
}
