// Package events is an in-process fan-out for console SSE.
// Redis may replace the transport later; lost notifications are acceptable.
package events

import "sync"

// Bus publishes tenant-scoped notifications to live console subscribers.
type Bus struct {
	mu   sync.Mutex
	subs map[string][]chan string
}

// NewBus returns an empty bus.
func NewBus() *Bus {
	return &Bus{subs: make(map[string][]chan string)}
}

// Publish sends event to every subscriber of tenantID. Slow consumers are dropped.
func (bus *Bus) Publish(tenantID, event string) {
	if tenantID == "" || event == "" {
		return
	}
	bus.mu.Lock()
	defer bus.mu.Unlock()
	for _, ch := range bus.subs[tenantID] {
		select {
		case ch <- event:
		default:
		}
	}
}

// Subscribe returns a channel and an unsubscribe function.
func (bus *Bus) Subscribe(tenantID string) (<-chan string, func()) {
	ch := make(chan string, 16)
	bus.mu.Lock()
	bus.subs[tenantID] = append(bus.subs[tenantID], ch)
	bus.mu.Unlock()
	return ch, func() {
		bus.mu.Lock()
		defer bus.mu.Unlock()
		kept := bus.subs[tenantID][:0]
		for _, existing := range bus.subs[tenantID] {
			if existing != ch {
				kept = append(kept, existing)
			}
		}
		if len(kept) == 0 {
			delete(bus.subs, tenantID)
		} else {
			bus.subs[tenantID] = kept
		}
		close(ch)
	}
}
