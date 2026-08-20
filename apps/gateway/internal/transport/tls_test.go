package transport

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net"
	"testing"
	"time"
)

func TestServerTLSConfigEnforcesTLS13MutualTLS(t *testing.T) {
	t.Parallel()

	serverCertificate, clientCAs := testServerCertificate(t)
	config, err := ServerTLSConfig(serverCertificate, clientCAs)
	if err != nil {
		t.Fatalf("ServerTLSConfig() error = %v", err)
	}

	if config.MinVersion != tls.VersionTLS13 {
		t.Errorf("MinVersion = %x, want TLS 1.3", config.MinVersion)
	}
	if config.MaxVersion != tls.VersionTLS13 {
		t.Errorf("MaxVersion = %x, want TLS 1.3", config.MaxVersion)
	}
	if config.ClientAuth != tls.RequireAndVerifyClientCert {
		t.Errorf("ClientAuth = %v, want RequireAndVerifyClientCert", config.ClientAuth)
	}
	if config.ClientCAs != clientCAs {
		t.Error("ClientCAs does not retain the supplied CA pool")
	}
	if config.VerifyConnection == nil {
		t.Fatal("VerifyConnection is nil; TLS 1.3 cipher-suite policy is not enforced")
	}
	for _, suite := range []uint16{
		tls.TLS_AES_128_GCM_SHA256,
		tls.TLS_AES_256_GCM_SHA384,
		tls.TLS_CHACHA20_POLY1305_SHA256,
	} {
		if err := config.VerifyConnection(tls.ConnectionState{
			Version:        tls.VersionTLS13,
			CipherSuite:    suite,
			VerifiedChains: [][]*x509.Certificate{{}},
		}); err != nil {
			t.Errorf("allowed suite %x rejected: %v", suite, err)
		}
	}
}

func TestServerTLSConfigRejectsMissingClientCAs(t *testing.T) {
	t.Parallel()

	serverCertificate, _ := testServerCertificate(t)
	for _, clientCAs := range []*x509.CertPool{nil, x509.NewCertPool()} {
		_, err := ServerTLSConfig(serverCertificate, clientCAs)
		if !errors.Is(err, ErrMissingClientCAs) {
			t.Errorf("ServerTLSConfig(..., %v) error = %v, want ErrMissingClientCAs", clientCAs, err)
		}
	}
}

func TestServerTLSConfigRejectsInvalidServerCertificate(t *testing.T) {
	t.Parallel()

	_, clientCAs := testServerCertificate(t)
	_, err := ServerTLSConfig(tls.Certificate{}, clientCAs)
	if !errors.Is(err, ErrInvalidServerCertificate) {
		t.Fatalf("ServerTLSConfig() error = %v, want ErrInvalidServerCertificate", err)
	}
}

func TestOptionalClientTLSConfigAllowsMissingClientCertificate(t *testing.T) {
	t.Parallel()

	serverCertificate, clientCAs := testServerCertificate(t)
	config, err := OptionalClientTLSConfig(serverCertificate, clientCAs)
	if err != nil {
		t.Fatalf("OptionalClientTLSConfig() error = %v", err)
	}
	if config.MinVersion != tls.VersionTLS13 || config.MaxVersion != tls.VersionTLS13 {
		t.Fatalf("versions = %x/%x, want TLS 1.3", config.MinVersion, config.MaxVersion)
	}
	if config.ClientAuth != tls.VerifyClientCertIfGiven {
		t.Errorf("ClientAuth = %v, want VerifyClientCertIfGiven", config.ClientAuth)
	}
	if err := config.VerifyConnection(tls.ConnectionState{
		Version:     tls.VersionTLS13,
		CipherSuite: tls.TLS_AES_128_GCM_SHA256,
	}); err != nil {
		t.Fatalf("missing client certificate rejected: %v", err)
	}

	serverConnection, clientConnection := net.Pipe()
	t.Cleanup(func() {
		_ = serverConnection.Close()
		_ = clientConnection.Close()
	})

	server := tls.Server(serverConnection, config)
	client := tls.Client(clientConnection, &tls.Config{
		MinVersion: tls.VersionTLS13,
		MaxVersion: tls.VersionTLS13,
		RootCAs:    clientCAs,
		ServerName: "gateway.test",
	})

	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Handshake() }()
	if err := client.Handshake(); err != nil {
		t.Fatalf("client handshake without client certificate: %v", err)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("server handshake without client certificate: %v", err)
	}
	if client.ConnectionState().Version != tls.VersionTLS13 {
		t.Fatalf("version = %x, want TLS 1.3", client.ConnectionState().Version)
	}
}

func TestTLS12ClientCannotNegotiate(t *testing.T) {
	t.Parallel()

	serverCertificate, clientCAs := testServerCertificate(t)
	serverConfig, err := ServerTLSConfig(serverCertificate, clientCAs)
	if err != nil {
		t.Fatalf("ServerTLSConfig() error = %v", err)
	}

	serverConnection, clientConnection := net.Pipe()
	t.Cleanup(func() {
		_ = serverConnection.Close()
		_ = clientConnection.Close()
	})

	server := tls.Server(serverConnection, serverConfig)
	client := tls.Client(clientConnection, &tls.Config{
		MinVersion:         tls.VersionTLS12,
		MaxVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // The test intentionally only exercises version negotiation.
	})

	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Handshake() }()

	if err := client.Handshake(); err == nil {
		t.Fatal("TLS 1.2 client unexpectedly negotiated with TLS 1.3-only server")
	}
	if err := <-serverErr; err == nil {
		t.Fatal("TLS 1.3-only server unexpectedly accepted a TLS 1.2 client")
	}
}

func testServerCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()

	caCertificate, caPrivateKey := newCertificateAuthority(t)
	serverCertificate := newSignedCertificate(t, caCertificate, caPrivateKey, x509.ExtKeyUsageServerAuth)

	clientCAs := x509.NewCertPool()
	clientCAs.AddCert(caCertificate)
	return serverCertificate, clientCAs
}

func newCertificateAuthority(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()

	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "gateway test CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatalf("CreateCertificate(CA) error = %v", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("ParseCertificate(CA) error = %v", err)
	}
	return certificate, privateKey
}

func newSignedCertificate(t *testing.T, issuer *x509.Certificate, issuerKey *ecdsa.PrivateKey, usage x509.ExtKeyUsage) tls.Certificate {
	t.Helper()

	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               pkix.Name{CommonName: "gateway test certificate"},
		DNSNames:              []string{"gateway.test"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{usage},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, issuer, &privateKey.PublicKey, issuerKey)
	if err != nil {
		t.Fatalf("CreateCertificate(leaf) error = %v", err)
	}
	return tls.Certificate{
		Certificate: [][]byte{der, issuer.Raw},
		PrivateKey:  privateKey,
	}
}
