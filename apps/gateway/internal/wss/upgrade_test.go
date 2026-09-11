package wss

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/session"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/transport"
	contract "github.com/vodoge/vodoge-cloud/packages/contract"
)

func TestServeHTTPRejectsUnauthenticatedUpgrade(t *testing.T) {
	t.Parallel()

	server := &Server{Hub: session.NewHub(), Journal: ingress.NewJournal(), Region: "cn"}

	request := httptest.NewRequest(http.MethodGet, Path, nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("missing subprotocol status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, Path, nil)
	request.Header.Set("Sec-WebSocket-Protocol", contract.WebSocketSubprotocol)
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing certificate status = %d", response.Code)
	}
}

func TestServeHTTPRoundTripResumeOverMTLS(t *testing.T) {
	t.Parallel()

	ca, caKey := newTestCA(t)
	serverCert, _ := newSignedCert(t, ca, caKey, pkix.Name{CommonName: "gateway.test"}, []string{"gateway.test"}, x509.ExtKeyUsageServerAuth)
	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	deviceCert, _ := newSignedCert(t, ca, caKey, pkix.Name{
		CommonName:         device.DeviceID,
		Organization:       []string{device.TenantID},
		OrganizationalUnit: []string{device.Region},
	}, nil, x509.ExtKeyUsageClientAuth)

	clientCAs := x509.NewCertPool()
	clientCAs.AddCert(ca)
	tlsConfig, err := transport.ServerTLSConfig(serverCert, clientCAs)
	if err != nil {
		t.Fatal(err)
	}

	gateway := &Server{Region: "cn", Hub: session.NewHub(), Journal: ingress.NewJournal()}
	httpServer := httptest.NewUnstartedServer(gateway)
	httpServer.TLS = tlsConfig
	httpServer.StartTLS()
	t.Cleanup(httpServer.Close)

	roots := x509.NewCertPool()
	roots.AddCert(ca)
	dialer := websocket.Dialer{
		TLSClientConfig: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			MaxVersion:   tls.VersionTLS13,
			RootCAs:      roots,
			Certificates: []tls.Certificate{deviceCert},
			ServerName:   "gateway.test",
		},
		Subprotocols: []string{contract.WebSocketSubprotocol},
	}
	url := "wss://" + httpServer.Listener.Addr().String() + Path
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	defer conn.Close()

	now := time.Now()
	resume, err := json.Marshal(contract.Envelope{
		V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
		ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
		Payload: mustJSON(t, contract.ResumePayload{
			ConnectionID:            "22222222-2222-4222-8222-222222222222",
			LastAssignedSeq:         "0",
			LastAckedSeq:            "0",
			PendingGapIds:           []string{},
			CapabilityMatrixVersion: "1",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, resume); err != nil {
		t.Fatal(err)
	}
	_, frame, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	ack := decodeWritten(t, frame)
	if ack.Kind != contract.MessageKindResumeAck {
		t.Fatalf("kind = %s, want ResumeAck", ack.Kind)
	}
}

func newTestCA(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "vodoge test CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return parsed, key
}

func newSignedCert(
	t *testing.T,
	issuer *x509.Certificate,
	issuerKey *ecdsa.PrivateKey,
	subject pkix.Name,
	dnsNames []string,
	usage x509.ExtKeyUsage,
) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               subject,
		DNSNames:              dnsNames,
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{usage},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, issuer, &key.PublicKey, issuerKey)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{
		Certificate: [][]byte{der, issuer.Raw},
		PrivateKey:  key,
		Leaf:        parsed,
	}, parsed
}

// 一个只按调用方给的答案判定的 Revocations 桩。
type stubRevocations struct {
	revoked bool
	err     error
	calls   int
}

func (stub *stubRevocations) Revoked(
	_ context.Context, _ identity.Device, _ *tls.ConnectionState,
) (bool, error) {
	stub.calls++
	return stub.revoked, stub.err
}

// 构造一次带客户端证书的升级请求。
func authenticatedUpgrade(t *testing.T, device identity.Device) *http.Request {
	t.Helper()
	ca, caKey := newTestCA(t)
	deviceCert, _ := newSignedCert(t, ca, caKey, pkix.Name{
		CommonName:         device.DeviceID,
		Organization:       []string{device.TenantID},
		OrganizationalUnit: []string{device.Region},
	}, nil, x509.ExtKeyUsageClientAuth)
	leaf, err := x509.ParseCertificate(deviceCert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, Path, nil)
	request.Header.Set("Sec-WebSocket-Protocol", contract.WebSocketSubprotocol)
	request.TLS = &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{leaf},
		VerifiedChains:   [][]*x509.Certificate{{leaf}},
	}
	return request
}

// 🔴 被吊销的证书必须当场拒掉。
//
// 在这之前**没有任何地方查过** `app.device_certificates.revoked_at`：那一列
// 从 0006 就在，而认证路径只信 CA 签名 —— 任何这个 CA 签过的证书都永久有效。
// 机器丢了收不回来，而现役那张证书有效到 2028-08-31。
func TestARevokedCertificateIsRefused(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	stub := &stubRevocations{revoked: true}
	server := &Server{
		Hub: session.NewHub(), Journal: ingress.NewJournal(), Region: "cn",
		Revocations: stub,
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, authenticatedUpgrade(t, device))

	if response.Code != http.StatusForbidden {
		t.Fatalf("被吊销的证书拿到 %d，想要 403 —— 机器丢了就该收得回来", response.Code)
	}
	if stub.calls != 1 {
		t.Fatalf("吊销检查被调用了 %d 次，想要 1 次", stub.calls)
	}
}

// 🔴 被吊销之后**不许再往下走**。
//
// 变异验证时发现的：把那个 `return` 去掉，看状态码的断言照样绿 ——
// `httptest.ResponseRecorder` 不支持 Hijack，升级本来就会失败。而漏了
// return 的真实后果是**一张被吊销的证书照样建立了会话**。
//
// 所以这一条走**真的 TLS 服务器和真的拨号**（和
// TestServeHTTPRoundTripResumeOverMTLS 同一套脚手架）：那时 Hijack 是可用的，
// 少一个 return 就真的会升级成功，而这条断言要求它连不上。
func TestARevokedCertificateCannotEvenConnect(t *testing.T) {
	t.Parallel()

	ca, caKey := newTestCA(t)
	serverCert, _ := newSignedCert(t, ca, caKey,
		pkix.Name{CommonName: "gateway.test"}, []string{"gateway.test"}, x509.ExtKeyUsageServerAuth)
	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	deviceCert, _ := newSignedCert(t, ca, caKey, pkix.Name{
		CommonName:         device.DeviceID,
		Organization:       []string{device.TenantID},
		OrganizationalUnit: []string{device.Region},
	}, nil, x509.ExtKeyUsageClientAuth)

	clientCAs := x509.NewCertPool()
	clientCAs.AddCert(ca)
	tlsConfig, err := transport.ServerTLSConfig(serverCert, clientCAs)
	if err != nil {
		t.Fatal(err)
	}

	hub := session.NewHub()
	gateway := &Server{
		Region: "cn", Hub: hub, Journal: ingress.NewJournal(),
		Revocations: &stubRevocations{revoked: true},
	}
	httpServer := httptest.NewUnstartedServer(gateway)
	httpServer.TLS = tlsConfig
	httpServer.StartTLS()
	t.Cleanup(httpServer.Close)

	roots := x509.NewCertPool()
	roots.AddCert(ca)
	dialer := websocket.Dialer{
		TLSClientConfig: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			MaxVersion:   tls.VersionTLS13,
			RootCAs:      roots,
			Certificates: []tls.Certificate{deviceCert},
			ServerName:   "gateway.test",
		},
		Subprotocols: []string{contract.WebSocketSubprotocol},
	}
	conn, response, err := dialer.Dial(
		"wss://"+httpServer.Listener.Addr().String()+Path, nil)
	if err == nil {
		conn.Close()
		t.Fatal("被吊销的证书仍然连上来了 —— 机器丢了就收不回来")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		got := 0
		if response != nil {
			got = response.StatusCode
		}
		t.Fatalf("被拒的状态码是 %d，想要 403", got)
	}
	if _, bound := hub.Lookup(device.DeviceID); bound {
		t.Fatal("被吊销的证书在 Hub 里建立了会话")
	}
}

// ⚠️ 查不到记录的**不是**被吊销，照旧放行。
//
// 🔴 方向是刻意的，而且是这一行代码能不能上线的关键：生产上
//
//	`app.device_certificates` 今天是 0 行（现役证书是 2026-09-01 手工签的，
//	没走过 /v1/enroll）。把「查不到」当成「被吊销」，会在上线那一刻打死
//	唯一那台在跑的设备。
//
//	等装机链路用起来、每张证书都有记录之后，「未知即拒」才是一次有依据的
//	收紧 —— 那是另一个决定。
func TestAnUnknownCertificateIsNotTreatedAsRevoked(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	stub := &stubRevocations{revoked: false}
	server := &Server{
		Hub: session.NewHub(), Journal: ingress.NewJournal(), Region: "cn",
		Revocations: stub,
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, authenticatedUpgrade(t, device))

	// httptest.ResponseRecorder 不支持 Hijack，所以升级本身会失败 —— 那没关系：
	// 这里断言的是**没有被 403 拦住**，也就是吊销检查放行了。
	if response.Code == http.StatusForbidden {
		t.Fatalf("没有吊销记录的证书被拒了 —— 生产上那张表是 0 行，这会打死唯一一台设备")
	}
	if stub.calls != 1 {
		t.Fatalf("吊销检查被调用了 %d 次，想要 1 次", stub.calls)
	}
}

// ⚠️ 吊销检查自己坏掉时**放行**，但要说出来。
//
// 把整个机队关在门外，比让一张已吊销的证书多活几分钟更坏。真正的问题是
// 静默放行，所以那一支落一条 Error 日志（见 upgrade.go）。
func TestAFailedRevocationCheckLetsTheDeviceIn(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	stub := &stubRevocations{err: errors.New("database is down")}
	server := &Server{
		Hub: session.NewHub(), Journal: ingress.NewJournal(), Region: "cn",
		Revocations: stub,
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, authenticatedUpgrade(t, device))

	if response.Code == http.StatusForbidden {
		t.Fatal("吊销检查坏掉时把设备关在了门外 —— 那会在一次数据库抖动里关停整个机队")
	}
}
