// Package transport provides hardened network transport configuration for the gateway.
package transport

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrMissingClientCAs indicates that mTLS trust roots were not supplied.
	ErrMissingClientCAs = errors.New("gateway TLS requires at least one client CA")
	// ErrInvalidServerCertificate indicates that the certificate cannot safely be used by a TLS server.
	ErrInvalidServerCertificate = errors.New("invalid gateway server certificate")
)

// ServerTLSConfig returns a TLS 1.3-only server configuration that requires
// and verifies a client certificate against clientCAs.
func ServerTLSConfig(serverCertificate tls.Certificate, clientCAs *x509.CertPool) (*tls.Config, error) {
	if clientCAs == nil || len(clientCAs.Subjects()) == 0 {
		return nil, ErrMissingClientCAs
	}

	leaf, err := validateServerCertificate(serverCertificate, time.Now())
	if err != nil {
		return nil, err
	}

	certificate := serverCertificate
	certificate.Leaf = leaf

	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		MaxVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,

		// CipherSuites only affects TLS 1.0-1.2. Keeping it unset avoids
		// suggesting that an obsolete protocol has a usable fallback policy.
		VerifyConnection: verifyTLS13Connection,
	}, nil
}

func verifyTLS13Connection(state tls.ConnectionState) error {
	if state.Version != tls.VersionTLS13 {
		return fmt.Errorf("gateway TLS negotiated unsupported version %x", state.Version)
	}
	if !isAllowedTLS13CipherSuite(state.CipherSuite) {
		return fmt.Errorf("gateway TLS negotiated unsupported cipher suite %x", state.CipherSuite)
	}
	if len(state.VerifiedChains) == 0 {
		return errors.New("gateway TLS connection has no verified client certificate chain")
	}
	return nil
}

// Go intentionally does not expose TLS 1.3 cipher-suite selection through
// tls.Config.CipherSuites. The standard library negotiates from its TLS 1.3
// implementation, so this immutable allowlist is enforced after selection.
func isAllowedTLS13CipherSuite(cipherSuite uint16) bool {
	switch cipherSuite {
	case tls.TLS_AES_128_GCM_SHA256, tls.TLS_AES_256_GCM_SHA384, tls.TLS_CHACHA20_POLY1305_SHA256:
		return true
	default:
		return false
	}
}

func validateServerCertificate(certificate tls.Certificate, now time.Time) (*x509.Certificate, error) {
	if len(certificate.Certificate) == 0 || certificate.PrivateKey == nil {
		return nil, fmt.Errorf("%w: certificate chain and private key are required", ErrInvalidServerCertificate)
	}

	for i, der := range certificate.Certificate {
		if _, err := x509.ParseCertificate(der); err != nil {
			return nil, fmt.Errorf("%w: parse chain certificate %d: %v", ErrInvalidServerCertificate, i, err)
		}
	}

	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("%w: parse leaf: %v", ErrInvalidServerCertificate, err)
	}
	if leaf.IsCA {
		return nil, fmt.Errorf("%w: leaf must not be a CA", ErrInvalidServerCertificate)
	}
	if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
		return nil, fmt.Errorf("%w: leaf is not currently valid", ErrInvalidServerCertificate)
	}
	if leaf.KeyUsage != 0 && leaf.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		return nil, fmt.Errorf("%w: leaf lacks digital-signature key usage", ErrInvalidServerCertificate)
	}
	if len(leaf.ExtKeyUsage) > 0 && !hasServerAuthUsage(leaf.ExtKeyUsage) {
		return nil, fmt.Errorf("%w: leaf is not valid for server authentication", ErrInvalidServerCertificate)
	}
	if err := validateServerPublicKey(leaf.PublicKey); err != nil {
		return nil, err
	}
	if err := validatePrivateKeyMatchesLeaf(certificate.PrivateKey, leaf.PublicKey); err != nil {
		return nil, err
	}

	return leaf, nil
}

func hasServerAuthUsage(usages []x509.ExtKeyUsage) bool {
	for _, usage := range usages {
		if usage == x509.ExtKeyUsageServerAuth || usage == x509.ExtKeyUsageAny {
			return true
		}
	}
	return false
}

func validateServerPublicKey(publicKey any) error {
	switch key := publicKey.(type) {
	case *rsa.PublicKey:
		if key.N == nil || key.N.BitLen() < 2048 {
			return fmt.Errorf("%w: RSA key must be at least 2048 bits", ErrInvalidServerCertificate)
		}
	case *ecdsa.PublicKey:
		if key.Curve == nil {
			return fmt.Errorf("%w: ECDSA key has no curve", ErrInvalidServerCertificate)
		}
	case ed25519.PublicKey:
		if len(key) != ed25519.PublicKeySize {
			return fmt.Errorf("%w: invalid Ed25519 public key", ErrInvalidServerCertificate)
		}
	default:
		return fmt.Errorf("%w: unsupported public key type %T", ErrInvalidServerCertificate, publicKey)
	}
	return nil
}

func validatePrivateKeyMatchesLeaf(privateKey any, leafPublicKey any) error {
	signer, ok := privateKey.(crypto.Signer)
	if !ok {
		return fmt.Errorf("%w: private key does not implement crypto.Signer", ErrInvalidServerCertificate)
	}

	certificatePublicKey, err := x509.MarshalPKIXPublicKey(leafPublicKey)
	if err != nil {
		return fmt.Errorf("%w: encode certificate public key: %v", ErrInvalidServerCertificate, err)
	}
	privatePublicKey, err := x509.MarshalPKIXPublicKey(signer.Public())
	if err != nil {
		return fmt.Errorf("%w: encode private public key: %v", ErrInvalidServerCertificate, err)
	}
	if !bytes.Equal(certificatePublicKey, privatePublicKey) {
		return fmt.Errorf("%w: private key does not match certificate leaf", ErrInvalidServerCertificate)
	}
	return nil
}
