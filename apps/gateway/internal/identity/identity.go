// Package identity extracts the device binding from an mTLS client certificate.
//
// The certificate subject is authoritative. Envelope device_id may not override
// it. Layout:
//
//	CN  = device_id (UUID)
//	O   = tenant_id (UUID)
//	OU  = region (cn|intl)
package identity

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrMissingCertificate indicates that the handshake produced no verified client certificate.
	ErrMissingCertificate = errors.New("missing client certificate")
	// ErrInvalidIdentity indicates that the certificate subject is not a usable device identity.
	ErrInvalidIdentity = errors.New("invalid device certificate identity")
)

// Device is the (tenant, device, region) tuple bound to one mTLS session.
type Device struct {
	TenantID string
	DeviceID string
	Region   string
}

// FromConnectionState reads identity from a completed mTLS handshake.
func FromConnectionState(state *tls.ConnectionState) (Device, error) {
	if state == nil || len(state.PeerCertificates) == 0 {
		return Device{}, ErrMissingCertificate
	}
	leaf := state.PeerCertificates[0]
	if len(state.VerifiedChains) > 0 && len(state.VerifiedChains[0]) > 0 {
		leaf = state.VerifiedChains[0][0]
	}
	return FromCertificate(leaf)
}

// FromCertificate reads identity from a verified client certificate leaf.
func FromCertificate(certificate *x509.Certificate) (Device, error) {
	if certificate == nil {
		return Device{}, ErrMissingCertificate
	}
	deviceID := strings.TrimSpace(certificate.Subject.CommonName)
	if deviceID == "" {
		return Device{}, fmt.Errorf("%w: common name (device_id) is required", ErrInvalidIdentity)
	}
	if len(certificate.Subject.Organization) != 1 || strings.TrimSpace(certificate.Subject.Organization[0]) == "" {
		return Device{}, fmt.Errorf("%w: organization (tenant_id) is required", ErrInvalidIdentity)
	}
	if len(certificate.Subject.OrganizationalUnit) != 1 {
		return Device{}, fmt.Errorf("%w: organizational unit (region) is required", ErrInvalidIdentity)
	}
	region := strings.TrimSpace(certificate.Subject.OrganizationalUnit[0])
	if region != "cn" && region != "intl" {
		return Device{}, fmt.Errorf("%w: region %q is not cn or intl", ErrInvalidIdentity, region)
	}
	return Device{
		TenantID: strings.TrimSpace(certificate.Subject.Organization[0]),
		DeviceID: deviceID,
		Region:   region,
	}, nil
}

// MatchesEnvelope reports whether an envelope device_id equals the certificate.
func (device Device) MatchesEnvelope(deviceID string) bool {
	return device.DeviceID == strings.TrimSpace(deviceID)
}
