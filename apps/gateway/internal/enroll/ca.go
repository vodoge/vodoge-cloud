package enroll

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
)

const (
	// DefaultValidity is the lifetime of a newly issued device certificate.
	DefaultValidity = 365 * 24 * time.Hour
	clockSkew       = 5 * time.Minute
)

// Authority is the device CA that signs enrollment CSRs.
type Authority struct {
	Certificate *x509.Certificate
	PrivateKey  crypto.Signer
	Validity    time.Duration
}

func (authority *Authority) validity() time.Duration {
	if authority != nil && authority.Validity > 0 {
		return authority.Validity
	}
	return DefaultValidity
}

// ParseCSR decodes a PEM certificate request and checks its signature.
func ParseCSR(pemBytes []byte) (*x509.CertificateRequest, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil || block.Type != "CERTIFICATE REQUEST" {
		return nil, fmt.Errorf("%w: PEM CERTIFICATE REQUEST is required", ErrInvalidCSR)
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidCSR, err)
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidCSR, err)
	}
	if csr.PublicKey == nil {
		return nil, fmt.Errorf("%w: public key is required", ErrInvalidCSR)
	}
	return csr, nil
}

// SignCSR issues a client certificate. The CSR subject is ignored; identity
// comes from the consumed enrollment code and the tenant's region.
func (authority *Authority) SignCSR(csr *x509.CertificateRequest, device identity.Device, now time.Time) (*x509.Certificate, []byte, error) {
	if authority == nil || authority.Certificate == nil || authority.PrivateKey == nil {
		return nil, nil, ErrMissingCA
	}
	if csr == nil || csr.PublicKey == nil {
		return nil, nil, fmt.Errorf("%w: public key is required", ErrInvalidCSR)
	}
	if _, err := identity.FromCertificate(&x509.Certificate{
		Subject: pkix.Name{
			CommonName:         device.DeviceID,
			Organization:       []string{device.TenantID},
			OrganizationalUnit: []string{device.Region},
		},
	}); err != nil {
		return nil, nil, err
	}

	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	if now.IsZero() {
		now = time.Now()
	}

	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:         device.DeviceID,
			Organization:       []string{device.TenantID},
			OrganizationalUnit: []string{device.Region},
		},
		NotBefore:             now.Add(-clockSkew),
		NotAfter:              now.Add(authority.validity()),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		SignatureAlgorithm:    x509.ECDSAWithSHA256,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, authority.Certificate, csr.PublicKey, authority.PrivateKey)
	if err != nil {
		return nil, nil, fmt.Errorf("sign device certificate: %w", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return certificate, pemBytes, nil
}

// Fingerprint returns the SHA-256 of the certificate DER as lowercase hex.
func Fingerprint(certificate *x509.Certificate) string {
	if certificate == nil {
		return ""
	}
	sum := sha256.Sum256(certificate.Raw)
	return hex.EncodeToString(sum[:])
}

// ParseAuthority loads a PEM certificate and private key used to sign devices.
func ParseAuthority(certPEM, keyPEM []byte) (*Authority, error) {
	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return nil, errors.New("device CA certificate PEM is required")
	}
	certificate, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse device CA certificate: %w", err)
	}
	if !certificate.IsCA {
		return nil, errors.New("device CA certificate is not a CA")
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, errors.New("device CA private key PEM is required")
	}
	signer, err := parseSigner(keyBlock.Bytes)
	if err != nil {
		return nil, err
	}
	return &Authority{Certificate: certificate, PrivateKey: signer, Validity: DefaultValidity}, nil
}

func parseSigner(der []byte) (crypto.Signer, error) {
	if key, err := x509.ParsePKCS8PrivateKey(der); err == nil {
		return signerFromKey(key)
	}
	if key, err := x509.ParseECPrivateKey(der); err == nil {
		return key, nil
	}
	if key, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return key, nil
	}
	return nil, errors.New("device CA private key is not PKCS#8, PKCS#1, or EC")
}

func signerFromKey(key any) (crypto.Signer, error) {
	switch typed := key.(type) {
	case *ecdsa.PrivateKey:
		return typed, nil
	case *rsa.PrivateKey:
		return typed, nil
	default:
		if signer, ok := key.(crypto.Signer); ok {
			return signer, nil
		}
		return nil, fmt.Errorf("unsupported device CA private key type %T", key)
	}
}

func randomSerial() (*big.Int, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	if serial.Sign() == 0 {
		return big.NewInt(1), nil
	}
	return serial, nil
}
