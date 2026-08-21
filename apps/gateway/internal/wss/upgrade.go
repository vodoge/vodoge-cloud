package wss

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	contract "github.com/vodoge/vodoge-cloud/packages/contract"
)

// Path is the device WebSocket route on the gateway process.
const Path = "/v1/edge"

var upgrader = websocket.Upgrader{
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: false,
	Subprotocols:      []string{contract.WebSocketSubprotocol},
	CheckOrigin: func(*http.Request) bool {
		// Device agents are not browsers. Origin is not an authorization signal;
		// the client certificate is.
		return true
	},
}

// ServeHTTP upgrades an authenticated mTLS request to the device session.
func (server *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !acceptsSubprotocol(request) {
		http.Error(writer, "websocket subprotocol vodoge.edge.v1 is required", http.StatusBadRequest)
		return
	}

	device, err := identity.FromConnectionState(request.TLS)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, identity.ErrInvalidIdentity) {
			status = http.StatusForbidden
		}
		http.Error(writer, err.Error(), status)
		return
	}
	if server.Region != "" && device.Region != server.Region {
		http.Error(writer, "certificate region does not match gateway", http.StatusForbidden)
		return
	}

	conn, err := upgrader.Upgrade(writer, request, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(MaxFrameBytes)
	// A device session that ends on a rejected Resume used to close the socket
	// with no trace at all, which made edge-side failures undiagnosable.
	if err := server.ServeDevice(device, conn); err != nil {
		slog.Warn("device session ended",
			"tenant_id", device.TenantID,
			"device_id", device.DeviceID,
			"region", device.Region,
			"error", err)
	}
}

func acceptsSubprotocol(request *http.Request) bool {
	for _, protocol := range websocket.Subprotocols(request) {
		if protocol == contract.WebSocketSubprotocol {
			return true
		}
	}
	return false
}
