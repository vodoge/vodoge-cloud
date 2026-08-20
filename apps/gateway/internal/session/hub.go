// Package session keeps the live set of edge WebSocket connections.
//
// At most one connection is bound per device_id. A newer Resume replaces the
// previous connection so a stale TCP session cannot ack or receive commands.
package session

import (
	"sync"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
)

const (
	// PingInterval is the edge-to-cloud heartbeat period.
	PingInterval = 30 * time.Second
	// IdleTimeout is how long the gateway waits without a frame before offline.
	IdleTimeout = 90 * time.Second
)

// Connection is one authenticated WSS session.
type Connection struct {
	ID           string
	Device       identity.Device
	ConnectedAt  time.Time
	LastPacketAt time.Time
}

// Hub stores live connections. It is safe for concurrent use.
type Hub struct {
	mu      sync.Mutex
	byDevice map[string]*Connection
	byID     map[string]string
}

// NewHub returns an empty connection hub.
func NewHub() *Hub {
	return &Hub{
		byDevice: make(map[string]*Connection),
		byID:     make(map[string]string),
	}
}

// Bind registers a connection. The previous connection for the same device is
// returned so the caller can close it.
func (hub *Hub) Bind(connection Connection) *Connection {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	previous := hub.byDevice[connection.Device.DeviceID]
	if previous != nil {
		delete(hub.byID, previous.ID)
	}
	clone := connection
	hub.byDevice[connection.Device.DeviceID] = &clone
	hub.byID[connection.ID] = connection.Device.DeviceID
	if previous == nil {
		return nil
	}
	copied := *previous
	return &copied
}

// Touch records that a frame arrived on this connection. Unknown IDs are ignored
// so a superseded session cannot refresh its idle timer.
func (hub *Hub) Touch(connectionID string, at time.Time) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	deviceID, ok := hub.byID[connectionID]
	if !ok {
		return false
	}
	connection := hub.byDevice[deviceID]
	if connection == nil || connection.ID != connectionID {
		return false
	}
	connection.LastPacketAt = at
	return true
}

// Lookup returns the active connection for a device, if any.
func (hub *Hub) Lookup(deviceID string) (Connection, bool) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	connection := hub.byDevice[deviceID]
	if connection == nil {
		return Connection{}, false
	}
	return *connection, true
}

// Unbind removes a connection only if it is still the live binding. A superseded
// session calling Unbind must not drop the newer connection.
func (hub *Hub) Unbind(connectionID string) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	deviceID, ok := hub.byID[connectionID]
	if !ok {
		return false
	}
	connection := hub.byDevice[deviceID]
	if connection == nil || connection.ID != connectionID {
		return false
	}
	delete(hub.byID, connectionID)
	delete(hub.byDevice, deviceID)
	return true
}

// SweepIdle unbinds connections that have been silent longer than IdleTimeout.
func (hub *Hub) SweepIdle(now time.Time) []Connection {
	hub.mu.Lock()
	defer hub.mu.Unlock()

	var expired []Connection
	for deviceID, connection := range hub.byDevice {
		if now.Sub(connection.LastPacketAt) < IdleTimeout {
			continue
		}
		expired = append(expired, *connection)
		delete(hub.byID, connection.ID)
		delete(hub.byDevice, deviceID)
	}
	return expired
}

// Len returns the number of live device connections.
func (hub *Hub) Len() int {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return len(hub.byDevice)
}
