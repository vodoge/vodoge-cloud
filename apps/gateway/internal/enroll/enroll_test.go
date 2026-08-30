package enroll

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/directory"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/transport"
)

const (
	tenantCN   = directory.OperatorTenantID
	tenantIntl = "b0000000-0000-4000-8000-00000000000b"
)

func TestEnrollIssuesCertificateFromCSR(t *testing.T) {
	t.Parallel()

	handler, memory := testHandler(t)
	memory.Put(tenantCN, "code-cn-1", "cn", time.Now().Add(time.Hour))
	csrPEM, key := newCSR(t)

	response := postEnroll(t, handler, enrollRequest{
		TenantID: tenantCN,
		Code:     "code-cn-1",
		CSR:      csrPEM,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}

	var body enrollResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.DeviceID == "" {
		t.Fatal("device_id is empty")
	}
	certificate := parseLeaf(t, body.Certificate)
	device, err := identity.FromCertificate(certificate)
	if err != nil {
		t.Fatalf("FromCertificate() error = %v", err)
	}
	if device.DeviceID != body.DeviceID {
		t.Errorf("CN device_id = %q, want %q", device.DeviceID, body.DeviceID)
	}
	if device.TenantID != tenantCN {
		t.Errorf("O tenant_id = %q, want %q", device.TenantID, tenantCN)
	}
	if device.Region != "cn" {
		t.Errorf("OU region = %q, want cn from tenant", device.Region)
	}
	if len(certificate.Subject.OrganizationalUnit) != 1 || certificate.Subject.OrganizationalUnit[0] != "cn" {
		t.Errorf("subject OU = %v, want [cn]", certificate.Subject.OrganizationalUnit)
	}
	if !publicKeysEqual(t, certificate.PublicKey, &key.PublicKey) {
		t.Error("issued certificate public key does not match CSR")
	}
	if strings.Contains(body.Certificate, "PRIVATE KEY") {
		t.Error("response included a private key")
	}
}

func TestEnrollWritesTenantRegionOnCertificate(t *testing.T) {
	t.Parallel()

	handler, memory := testHandler(t)
	memory.Put(tenantIntl, "code-intl-1", "intl", time.Now().Add(time.Hour))
	csrPEM, _ := newCSR(t)

	response := postEnroll(t, handler, enrollRequest{
		TenantID: tenantIntl,
		Code:     "code-intl-1",
		CSR:      csrPEM,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var body enrollResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	certificate := parseLeaf(t, body.Certificate)
	device, err := identity.FromCertificate(certificate)
	if err != nil {
		t.Fatal(err)
	}
	if device.Region != "intl" {
		t.Errorf("region = %q, want intl from tenant", device.Region)
	}
}

func TestEnrollRejectsReuse(t *testing.T) {
	t.Parallel()

	handler, memory := testHandler(t)
	memory.Put(tenantCN, "code-once", "cn", time.Now().Add(time.Hour))
	csrPEM, _ := newCSR(t)
	first := postEnroll(t, handler, enrollRequest{TenantID: tenantCN, Code: "code-once", CSR: csrPEM})
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body = %s", first.Code, first.Body.String())
	}

	reuseCSR, _ := newCSR(t)
	reuse := postEnroll(t, handler, enrollRequest{TenantID: tenantCN, Code: "code-once", CSR: reuseCSR})
	if reuse.Code != http.StatusConflict {
		t.Fatalf("reuse status = %d, want 409; body = %s", reuse.Code, reuse.Body.String())
	}
	if !strings.Contains(reuse.Body.String(), ErrUsed.Error()) {
		t.Errorf("reuse body = %s", reuse.Body.String())
	}
}

func TestEnrollRejectsWrongTenant(t *testing.T) {
	t.Parallel()

	handler, memory := testHandler(t)
	memory.Put(tenantCN, "code-apple", "cn", time.Now().Add(time.Hour))
	csrPEM, _ := newCSR(t)

	wrong := postEnroll(t, handler, enrollRequest{
		TenantID: tenantIntl,
		Code:     "code-apple",
		CSR:      csrPEM,
	})
	if wrong.Code != http.StatusForbidden {
		t.Fatalf("wrong tenant status = %d, want 403; body = %s", wrong.Code, wrong.Body.String())
	}

	ok := postEnroll(t, handler, enrollRequest{
		TenantID: tenantCN,
		Code:     "code-apple",
		CSR:      csrPEM,
	})
	if ok.Code != http.StatusOK {
		t.Fatalf("owner status = %d, want 200 after wrong-tenant attempt; body = %s", ok.Code, ok.Body.String())
	}
}

func TestEnrollIgnoresCSRSubject(t *testing.T) {
	t.Parallel()

	handler, memory := testHandler(t)
	memory.Put(tenantCN, "code-subject", "cn", time.Now().Add(time.Hour))
	csrPEM := newCSRWithSubject(t, pkix.Name{
		CommonName:         "not-a-device",
		Organization:       []string{"other-tenant"},
		OrganizationalUnit: []string{"intl"},
	})

	response := postEnroll(t, handler, enrollRequest{
		TenantID: tenantCN,
		Code:     "code-subject",
		CSR:      csrPEM,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var body enrollResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	certificate := parseLeaf(t, body.Certificate)
	device, err := identity.FromCertificate(certificate)
	if err != nil {
		t.Fatal(err)
	}
	if device.DeviceID == "not-a-device" || device.TenantID == "other-tenant" || device.Region != "cn" {
		t.Fatalf("CSR subject leaked into certificate: %+v", device)
	}
}

func TestEnrollRejectsExpiredAndInvalidCSR(t *testing.T) {
	t.Parallel()

	handler, memory := testHandler(t)
	memory.Put(tenantCN, "code-expired", "cn", time.Now().Add(-time.Minute))
	csrPEM, _ := newCSR(t)

	expired := postEnroll(t, handler, enrollRequest{TenantID: tenantCN, Code: "code-expired", CSR: csrPEM})
	if expired.Code != http.StatusBadRequest {
		t.Fatalf("expired status = %d, want 400", expired.Code)
	}

	memory.Put(tenantCN, "code-bad-csr", "cn", time.Now().Add(time.Hour))
	bad := postEnroll(t, handler, enrollRequest{TenantID: tenantCN, Code: "code-bad-csr", CSR: "not-a-csr"})
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid CSR status = %d, want 400", bad.Code)
	}
}

func TestEnrollOverTLS13WithoutClientCertificate(t *testing.T) {
	t.Parallel()

	handler, memory := testHandler(t)
	memory.Put(tenantCN, "code-tls", "cn", time.Now().Add(time.Hour))

	ca, caKey := newTestCA(t)
	serverCert := newServerCertificate(t, ca, caKey)
	clientCAs := x509.NewCertPool()
	clientCAs.AddCert(ca)
	tlsConfig, err := transport.OptionalClientTLSConfig(serverCert, clientCAs)
	if err != nil {
		t.Fatal(err)
	}

	httpServer := httptest.NewUnstartedServer(handler)
	httpServer.TLS = tlsConfig
	httpServer.StartTLS()
	t.Cleanup(httpServer.Close)

	roots := x509.NewCertPool()
	roots.AddCert(ca)
	client := httpServer.Client()
	client.Transport = &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS13,
			MaxVersion: tls.VersionTLS13,
			RootCAs:    roots,
			ServerName: "gateway.test",
		},
	}

	csrPEM, _ := newCSR(t)
	payload, err := json.Marshal(enrollRequest{TenantID: tenantCN, Code: "code-tls", CSR: csrPEM})
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Post(httpServer.URL+Path, "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("POST without client certificate: %v", err)
	}
	defer response.Body.Close()
	if response.TLS == nil || response.TLS.Version != tls.VersionTLS13 {
		t.Fatalf("negotiated %+v, want TLS 1.3", response.TLS)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.StatusCode, body)
	}
	var parsed enrollResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	certificate := parseLeaf(t, parsed.Certificate)
	if _, err := identity.FromCertificate(certificate); err != nil {
		t.Fatal(err)
	}
}

func testHandler(t *testing.T) (*Handler, *Memory) {
	t.Helper()
	memory := NewMemory()
	authority := testAuthority(t)
	return &Handler{Service: &Service{Issuer: memory, CA: authority}}, memory
}

func postEnroll(t *testing.T, handler http.Handler, body enrollRequest) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, Path, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func parseLeaf(t *testing.T, pemBytes string) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode([]byte(pemBytes))
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatalf("response is not a certificate PEM: %q", pemBytes)
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}

func newCSR(t *testing.T) (string, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "edge-local"},
	}, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), key
}

func newCSRWithSubject(t *testing.T, subject pkix.Name) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: subject}, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}))
}

func testAuthority(t *testing.T) *Authority {
	t.Helper()
	certificate, key := newTestCA(t)
	return &Authority{Certificate: certificate, PrivateKey: key, Validity: time.Hour}
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
		Subject:               pkix.Name{CommonName: "vodoge device test CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
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

func newServerCertificate(t *testing.T, issuer *x509.Certificate, issuerKey *ecdsa.PrivateKey) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               pkix.Name{CommonName: "gateway.test"},
		DNSNames:              []string{"gateway.test"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, issuer, &key.PublicKey, issuerKey)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der, issuer.Raw}, PrivateKey: key}
}

func publicKeysEqual(t *testing.T, left, right any) bool {
	t.Helper()
	leftBytes, err := x509.MarshalPKIXPublicKey(left)
	if err != nil {
		t.Fatal(err)
	}
	rightBytes, err := x509.MarshalPKIXPublicKey(right)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Equal(leftBytes, rightBytes)
}

func TestMapConsumeError(t *testing.T) {
	t.Parallel()

	if !errors.Is(mapConsumeError(errors.New("ERROR: enrollment code already used (SQLSTATE 55000)")), ErrUsed) {
		t.Fatal("used")
	}
	if !errors.Is(mapConsumeError(errors.New("ERROR: enrollment code not found (SQLSTATE P0002)")), ErrNotFound) {
		t.Fatal("not found")
	}
	if !errors.Is(mapConsumeError(errors.New("ERROR: tenant context does not match enrollment tenant (SQLSTATE 42501)")), ErrWrongTenant) {
		t.Fatal("wrong tenant")
	}
}

// A tenant at its limit is not a tenant with a bad code, and the difference
// matters to whoever is standing next to the machine: one is fixed by raising
// a number in the console, the other by issuing a new code. 403 would send
// them looking for the wrong thing.
func TestAQuotaRefusalIsNotAnAuthorisationFailure(t *testing.T) {
	err := fmt.Errorf("%w: 5 of 5 devices enrolled", ErrQuotaExceeded)
	if status := enrollStatus(err); status != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402", status)
	}
	if status := enrollStatus(ErrNotFound); status == enrollStatus(err) {
		t.Fatal("a quota refusal is indistinguishable from an unusable code")
	}
}

// 🔴 The counts stay out of the response. The device asking is on somebody
// else's network, and how many devices a tenant holds is not something an
// enrolment endpoint should tell an unauthenticated caller.
func TestAQuotaRefusalDoesNotCountTheFleetOutLoud(t *testing.T) {
	err := fmt.Errorf("%w: 5 of 5 devices enrolled", ErrQuotaExceeded)
	message := enrollMessage(err)
	if strings.Contains(message, "5") {
		t.Fatalf("the response counted the fleet out loud: %q", message)
	}
	if message != ErrQuotaExceeded.Error() {
		t.Fatalf("message = %q", message)
	}
}
