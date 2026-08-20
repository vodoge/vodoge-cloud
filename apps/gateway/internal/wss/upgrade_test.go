package wss

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
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
