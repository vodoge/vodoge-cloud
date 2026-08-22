package messaging

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Memory is the store used when PostgreSQL is not configured, and by tests.
type Memory struct {
	mu       sync.Mutex
	messages map[string][]Message
	nextID   int
}

func (store *Memory) Threads(_ context.Context, tenantID string) ([]Thread, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	byPeer := map[string]*Thread{}
	for _, message := range store.messages[tenantID] {
		thread, ok := byPeer[message.Peer]
		if !ok {
			thread = &Thread{Peer: message.Peer, DeviceID: message.DeviceID}
			byPeer[message.Peer] = thread
		}
		thread.Messages++
		if message.Status == "queued" || message.Status == "failed" {
			thread.Unsent++
		}
		if message.ReceivedAt >= thread.LastAt {
			thread.LastAt = message.ReceivedAt
			thread.LastBody = message.Body
			thread.LastInbound = message.Direction == "inbound"
		}
	}
	out := make([]Thread, 0, len(byPeer))
	for _, thread := range byPeer {
		out = append(out, *thread)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastAt > out[j].LastAt })
	return out, nil
}

func (store *Memory) Thread(
	_ context.Context,
	tenantID, peer string,
	limit int,
) ([]Message, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []Message{}
	for _, message := range store.messages[tenantID] {
		if message.Peer == peer {
			out = append(out, message)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ReceivedAt < out[j].ReceivedAt })
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

func (store *Memory) RecordOutbound(_ context.Context, tenantID string, message Message) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.messages == nil {
		store.messages = map[string][]Message{}
	}
	// Same guard as the unique index: a redelivered command must not produce a
	// second copy of the message in the conversation.
	for _, existing := range store.messages[tenantID] {
		if existing.CommandID != nil && message.CommandID != nil &&
			*existing.CommandID == *message.CommandID {
			return nil
		}
	}
	store.nextID++
	message.ID = "mem-" + strconv.Itoa(store.nextID)
	message.Direction = "outbound"
	message.Status = "queued"
	message.Bearer = "unknown"
	message.createdAt = time.Now()
	if message.ReceivedAt == 0 {
		message.ReceivedAt = time.Now().UnixMilli()
	}
	store.messages[tenantID] = append(store.messages[tenantID], message)
	return nil
}

func (store *Memory) SettleOutbound(
	_ context.Context,
	tenantID, commandID, status, reason string,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	for i, message := range store.messages[tenantID] {
		if message.CommandID == nil || *message.CommandID != commandID {
			continue
		}
		if message.Status != "queued" {
			continue
		}
		store.messages[tenantID][i].Status = status
		if reason != "" {
			value := reason
			store.messages[tenantID][i].FailureReason = &value
		}
	}
	return nil
}

func (store *Memory) DeleteMessage(_ context.Context, tenantID, id string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	kept := store.messages[tenantID][:0]
	for _, message := range store.messages[tenantID] {
		if message.ID != id {
			kept = append(kept, message)
		}
	}
	store.messages[tenantID] = kept
	return nil
}

func (store *Memory) DeleteThread(_ context.Context, tenantID, peer string) (int64, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	kept := store.messages[tenantID][:0]
	var removed int64
	for _, message := range store.messages[tenantID] {
		if message.Peer == peer {
			removed++
			continue
		}
		kept = append(kept, message)
	}
	store.messages[tenantID] = kept
	return removed, nil
}

// Seed adds a message directly, for tests that need a conversation to exist.
func (store *Memory) Seed(tenantID string, message Message) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.messages == nil {
		store.messages = map[string][]Message{}
	}
	store.nextID++
	if message.ID == "" {
		message.ID = "mem-" + strconv.Itoa(store.nextID)
	}
	store.messages[tenantID] = append(store.messages[tenantID], message)
}

func (store *Memory) CountOutboundSince(
	_ context.Context,
	tenantID string,
	since time.Time,
) (int, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	count := 0
	for _, message := range store.messages[tenantID] {
		if message.Direction == "outbound" && !message.createdAt.Before(since) {
			count++
		}
	}
	return count, nil
}
