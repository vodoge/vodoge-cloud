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
	contacts map[string]map[string]Contact
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
		if message.Direction == "inbound" && message.ReadAt == nil {
			thread.Unread++
		}
		if message.ReceivedAt >= thread.LastAt {
			thread.LastAt = message.ReceivedAt
			thread.LastBody = message.Body
			thread.LastInbound = message.Direction == "inbound"
		}
	}
	out := make([]Thread, 0, len(byPeer))
	for _, thread := range byPeer {
		if contact, ok := store.contacts[tenantID][thread.Peer]; ok {
			thread.Name = contact.Name
		}
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
	reference *int,
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
		if reference != nil {
			value := *reference
			store.messages[tenantID][i].ProviderReference = &value
		}
	}
	return nil
}

func (store *Memory) MarkThreadRead(
	_ context.Context,
	tenantID, peer string,
) (int64, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	var marked int64
	now := time.Now().UnixMilli()
	for i, message := range store.messages[tenantID] {
		if message.Peer != peer || message.Direction != "inbound" || message.ReadAt != nil {
			continue
		}
		value := now
		store.messages[tenantID][i].ReadAt = &value
		marked++
	}
	return marked, nil
}

func (store *Memory) Contacts(_ context.Context, tenantID string) ([]Contact, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []Contact{}
	for _, contact := range store.contacts[tenantID] {
		out = append(out, contact)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (store *Memory) SaveContact(_ context.Context, tenantID string, contact Contact) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.contacts == nil {
		store.contacts = map[string]map[string]Contact{}
	}
	if store.contacts[tenantID] == nil {
		store.contacts[tenantID] = map[string]Contact{}
	}
	contact.UpdatedAt = time.Now().UnixMilli()
	store.contacts[tenantID][contact.Peer] = contact
	return nil
}

func (store *Memory) DeleteContact(_ context.Context, tenantID, peer string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.contacts[tenantID], peer)
	return nil
}

// ApplyStatusReport is the in-memory stand-in for the SmsStatusReport branch
// of accept_ingress. It exists so a test can drive the delivery path without
// PostgreSQL; production settles delivery in the projection, which is the only
// writer of these columns.
func (store *Memory) ApplyStatusReport(
	tenantID, peer string,
	reference int,
	status string,
	deliveredAt int64,
) {
	store.mu.Lock()
	defer store.mu.Unlock()
	newest := -1
	for i, message := range store.messages[tenantID] {
		if message.Direction != "outbound" || message.Peer != peer {
			continue
		}
		if message.ProviderReference == nil || *message.ProviderReference != reference {
			continue
		}
		newest = i
	}
	if newest < 0 {
		return
	}
	switch status {
	case "delivered":
		store.messages[tenantID][newest].Status = "delivered"
		value := deliveredAt
		store.messages[tenantID][newest].DeliveredAt = &value
	case "failed":
		store.messages[tenantID][newest].Status = "undelivered"
	}
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
