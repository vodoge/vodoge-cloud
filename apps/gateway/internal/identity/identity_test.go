package identity

import (
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"testing"
)

func TestFromCertificateReadsSubject(t *testing.T) {
	t.Parallel()

	got, err := FromCertificate(&x509.Certificate{
		Subject: pkix.Name{
			CommonName:         "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			Organization:       []string{"11111111-1111-1111-1111-111111111111"},
			OrganizationalUnit: []string{"cn"},
		},
	})
	if err != nil {
		t.Fatalf("FromCertificate() error = %v", err)
	}
	if got.DeviceID != "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" {
		t.Errorf("DeviceID = %q", got.DeviceID)
	}
	if got.TenantID != "11111111-1111-1111-1111-111111111111" {
		t.Errorf("TenantID = %q", got.TenantID)
	}
	if got.Region != "cn" {
		t.Errorf("Region = %q", got.Region)
	}
}

func TestFromCertificateRejectsUnknownRegion(t *testing.T) {
	t.Parallel()

	_, err := FromCertificate(&x509.Certificate{
		Subject: pkix.Name{
			CommonName:         "dev",
			Organization:       []string{"tenant"},
			OrganizationalUnit: []string{"eu"},
		},
	})
	if !errors.Is(err, ErrInvalidIdentity) {
		t.Fatalf("error = %v, want ErrInvalidIdentity", err)
	}
}

func TestFromConnectionStateRequiresAClientCertificate(t *testing.T) {
	t.Parallel()

	_, err := FromConnectionState(nil)
	if !errors.Is(err, ErrMissingCertificate) {
		t.Fatalf("nil state err = %v", err)
	}
	_, err = FromConnectionState(&tls.ConnectionState{})
	if !errors.Is(err, ErrMissingCertificate) {
		t.Fatalf("empty peer err = %v", err)
	}
}

func TestMatchesEnvelope(t *testing.T) {
	t.Parallel()

	device := Device{DeviceID: "dev-1", TenantID: "t", Region: "intl"}
	if !device.MatchesEnvelope("dev-1") {
		t.Fatal("matching device_id must be accepted")
	}
	if device.MatchesEnvelope("dev-2") {
		t.Fatal("mismatched envelope device_id must be rejected")
	}
}
