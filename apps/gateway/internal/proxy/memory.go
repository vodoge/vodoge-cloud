package proxy

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Memory is the store used when PostgreSQL is not configured, and by tests.
type Memory struct {
	mu        sync.Mutex
	upstreams map[string][]Upstream
	instances map[string][]Instance
	rules     map[string][]CountryRule
	traffic   map[string][]TrafficPoint
	nextID    int
}

func (store *Memory) id() string {
	store.nextID++
	return fmt.Sprintf("mem-%d", store.nextID)
}

func (store *Memory) Upstreams(_ context.Context, tenantID string) ([]Upstream, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := append([]Upstream{}, store.upstreams[tenantID]...)
	// Passwords never leave the store, matching what the SQL implementation
	// can offer — it does not select the column at all.
	for i := range out {
		out[i].HasPassword = out[i].Password != ""
		out[i].Password = ""
	}
	return out, nil
}

func (store *Memory) SaveUpstream(
	_ context.Context,
	tenantID string,
	upstream Upstream,
) (string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.upstreams == nil {
		store.upstreams = map[string][]Upstream{}
	}
	if upstream.ID == "" {
		upstream.ID = store.id()
		store.upstreams[tenantID] = append(store.upstreams[tenantID], upstream)
		return upstream.ID, nil
	}
	for i, existing := range store.upstreams[tenantID] {
		if existing.ID != upstream.ID {
			continue
		}
		if upstream.Password == "" {
			upstream.Password = existing.Password
		}
		upstream.LastProbe, upstream.LastProbeAt = existing.LastProbe, existing.LastProbeAt
		store.upstreams[tenantID][i] = upstream
		return upstream.ID, nil
	}
	return "", ErrInvalid{"no such upstream"}
}

func (store *Memory) DeleteUpstream(_ context.Context, tenantID, id string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	kept := store.upstreams[tenantID][:0]
	for _, existing := range store.upstreams[tenantID] {
		if existing.ID != id {
			kept = append(kept, existing)
		}
	}
	store.upstreams[tenantID] = kept
	return nil
}

func (store *Memory) RecordProbe(
	_ context.Context,
	tenantID, id string,
	probe map[string]any,
	at time.Time,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	for i, existing := range store.upstreams[tenantID] {
		if existing.ID == id {
			ms := at.UnixMilli()
			store.upstreams[tenantID][i].LastProbe = probe
			store.upstreams[tenantID][i].LastProbeAt = &ms
		}
	}
	return nil
}

func (store *Memory) Instances(_ context.Context, tenantID, deviceID string) ([]Instance, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []Instance{}
	for _, item := range store.instances[tenantID] {
		if deviceID != "" && item.DeviceID != deviceID {
			continue
		}
		item.HasPassword = item.Password != ""
		item.Password = ""
		out = append(out, item)
	}
	return out, nil
}

func (store *Memory) SaveInstance(
	_ context.Context,
	tenantID string,
	instance Instance,
) (string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.instances == nil {
		store.instances = map[string][]Instance{}
	}
	for _, existing := range store.instances[tenantID] {
		samePort := existing.DeviceID == instance.DeviceID &&
			existing.ListenPort == instance.ListenPort &&
			existing.ID != instance.ID
		if samePort {
			return "", ErrInvalid{"another instance on this device already uses that port"}
		}
	}
	if instance.ID == "" {
		instance.ID = store.id()
		store.instances[tenantID] = append(store.instances[tenantID], instance)
		return instance.ID, nil
	}
	for i, existing := range store.instances[tenantID] {
		if existing.ID != instance.ID {
			continue
		}
		if instance.Password == "" {
			instance.Password = existing.Password
		}
		store.instances[tenantID][i] = instance
		return instance.ID, nil
	}
	return "", ErrInvalid{"no such instance"}
}

func (store *Memory) DeleteInstance(_ context.Context, tenantID, id string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	kept := store.instances[tenantID][:0]
	for _, existing := range store.instances[tenantID] {
		if existing.ID != id {
			kept = append(kept, existing)
		}
	}
	store.instances[tenantID] = kept
	return nil
}

func (store *Memory) CountryRules(_ context.Context, tenantID string) ([]CountryRule, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := append([]CountryRule{}, store.rules[tenantID]...)
	sort.Slice(out, func(i, j int) bool { return out[i].CountryCode < out[j].CountryCode })
	return out, nil
}

func (store *Memory) SaveCountryRule(_ context.Context, tenantID string, rule CountryRule) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.rules == nil {
		store.rules = map[string][]CountryRule{}
	}
	for i, existing := range store.rules[tenantID] {
		if existing.CountryCode == rule.CountryCode {
			store.rules[tenantID][i] = rule
			return nil
		}
	}
	store.rules[tenantID] = append(store.rules[tenantID], rule)
	return nil
}

func (store *Memory) DeleteCountryRule(_ context.Context, tenantID, code string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	kept := store.rules[tenantID][:0]
	for _, existing := range store.rules[tenantID] {
		if existing.CountryCode != code {
			kept = append(kept, existing)
		}
	}
	store.rules[tenantID] = kept
	return nil
}

func (store *Memory) Traffic(
	_ context.Context,
	tenantID string,
	since time.Time,
) ([]TrafficPoint, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []TrafficPoint{}
	for _, point := range store.traffic[tenantID] {
		if point.Hour >= since.UnixMilli() {
			out = append(out, point)
		}
	}
	return out, nil
}

func (store *Memory) AddTraffic(
	_ context.Context,
	tenantID string,
	points []TrafficPoint,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.traffic == nil {
		store.traffic = map[string][]TrafficPoint{}
	}
	for _, point := range points {
		point.Hour = time.UnixMilli(point.Hour).Truncate(time.Hour).UnixMilli()
		found := false
		for i, existing := range store.traffic[tenantID] {
			if existing.InstanceID == point.InstanceID && existing.Hour == point.Hour {
				store.traffic[tenantID][i].BytesUp += point.BytesUp
				store.traffic[tenantID][i].BytesDown += point.BytesDown
				store.traffic[tenantID][i].Connections += point.Connections
				found = true
				break
			}
		}
		if !found {
			store.traffic[tenantID] = append(store.traffic[tenantID], point)
		}
	}
	return nil
}
