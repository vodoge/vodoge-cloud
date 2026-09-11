package wss

import (
	"context"
	"crypto/tls"
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

// Revocations answers whether the certificate on this handshake was revoked.
//
// 接口而不是直接拿 *sql.DB：`wss` 这个包今天不认识数据库，为一次查询把它
// 接进来，等于让每一个 wss 的测试都要准备一个库。
type Revocations interface {
	Revoked(ctx context.Context, device identity.Device, state *tls.ConnectionState) (bool, error)
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

	// 这张证书被吊销了没有。
	//
	// 🔴 在这之前**没有任何地方查过**。`app.device_certificates` 从 0006 起
	//    就有 `revoked_at` 这一列，而认证路径只信 CA 签名 —— 也就是说任何
	//    这个 CA 签过的证书都永久有效。机器丢了收不回来，而现役那张证书
	//    有效到 2028-08-31。
	//
	// ⚠️ 只在**明确被吊销**时拒，查不到记录的照旧放行。方向是刻意的：
	//    生产上 `app.device_certificates` 今天是 0 行（现役证书是 2026-09-01
	//    手工签进 /etc/vodoge-edge 的，没走过 /v1/enroll），把「查不到」当成
	//    「被吊销」会在这一行代码上线的那一刻打死唯一那台在跑的设备。
	//
	//    等装机链路用起来、每张证书都有记录之后，「未知即拒」才是一次
	//    有依据的收紧 —— 那是另一个决定，不是这一行顺手做的。
	//
	// ⚠️ 查询失败也放行，并且**说出来**。吊销检查坏掉时把整个机队关在门外，
	//    比让一张已吊销的证书多活几分钟更坏 —— 而静默放行才是真正的问题，
	//    所以它落一条 Error 日志。
	if server.Revocations != nil {
		revoked, err := server.Revocations.Revoked(request.Context(), device, request.TLS)
		switch {
		case err != nil:
			slog.Error("could not check whether this certificate was revoked; letting it in",
				"tenant_id", device.TenantID, "device_id", device.DeviceID, "error", err)
		case revoked:
			slog.Warn("refused a revoked certificate",
				"tenant_id", device.TenantID, "device_id", device.DeviceID)
			http.Error(writer, "certificate has been revoked", http.StatusForbidden)
			return
		}
	}

	conn, err := upgrader.Upgrade(writer, request, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(MaxFrameBytes)
	// A device session that ends on a rejected Resume used to close the socket
	// with no trace at all, which made edge-side failures undiagnosable.
	err = server.ServeDevice(device, conn)
	if server.OnSessionEnd != nil {
		server.OnSessionEnd(device, server.now())
	}
	if err != nil {
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
