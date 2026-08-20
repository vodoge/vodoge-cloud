// Package enroll exchanges a one-time enrollment code for a device mTLS certificate.
//
// The edge generates the private key and CSR. This package only signs the CSR.
// Certificate subject:
//
//	CN  = device_id (UUID)
//	O   = tenant_id (UUID)
//	OU  = region (cn|intl)
package enroll

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
)

const (
	// Path is the device enrollment route. It does not require a client certificate.
	Path         = "/v1/enroll"
	maxBodyBytes = 32 << 10
)

var (
	// ErrUsed indicates the enrollment code was already consumed.
	ErrUsed = errors.New("enrollment code already used")
	// ErrExpired indicates the enrollment code is past expires_at.
	ErrExpired = errors.New("enrollment code expired")
	// ErrNotFound indicates no matching code exists for the tenant.
	ErrNotFound = errors.New("enrollment code not found")
	// ErrWrongTenant indicates the code belongs to a different tenant.
	ErrWrongTenant = errors.New("enrollment code does not belong to this tenant")
	// ErrInvalidCSR indicates the PEM is not a usable certificate request.
	ErrInvalidCSR = errors.New("invalid certificate request")
	// ErrMissingCA indicates the signing authority is not configured.
	ErrMissingCA = errors.New("device CA is not configured")
	// ErrInactiveTenant indicates the tenant cannot enroll devices.
	ErrInactiveTenant = errors.New("enrollment tenant is not active")
)

// Consumed is the identity assigned when a code is marked used.
type Consumed struct {
	TenantID string
	DeviceID string
	Region   string
}

// CertificateRecord is the issued leaf plus the values stored for later revoke.
type CertificateRecord struct {
	TenantID    string
	DeviceID    string
	Region      string
	Serial      string
	Fingerprint string
	NotBefore   time.Time
	NotAfter    time.Time
	PEM         string
}

// Issuer consumes a one-time code and records the signed certificate atomically.
type Issuer interface {
	Issue(ctx context.Context, tenantID, code, hint string, sign func(Consumed) (CertificateRecord, error)) (CertificateRecord, error)
}

// Service signs CSRs after a code is consumed.
type Service struct {
	Issuer Issuer
	CA     *Authority
	Now    func() time.Time
}

func (service *Service) now() time.Time {
	if service != nil && service.Now != nil {
		return service.Now()
	}
	return time.Now()
}

// Enroll consumes the code, signs the CSR, and returns the leaf PEM and device_id.
func (service *Service) Enroll(ctx context.Context, tenantID, code, csrPEM string) (CertificateRecord, error) {
	if service == nil || service.CA == nil {
		return CertificateRecord{}, ErrMissingCA
	}
	if service.Issuer == nil {
		return CertificateRecord{}, errors.New("enrollment issuer is not configured")
	}
	tenantID = strings.TrimSpace(tenantID)
	code = strings.TrimSpace(code)
	if tenantID == "" || code == "" {
		return CertificateRecord{}, fmt.Errorf("%w: tenant_id and code are required", ErrNotFound)
	}

	csr, err := ParseCSR([]byte(csrPEM))
	if err != nil {
		return CertificateRecord{}, err
	}

	return service.Issuer.Issue(ctx, tenantID, code, csrPEM, func(consumed Consumed) (CertificateRecord, error) {
		device := identity.Device{
			TenantID: consumed.TenantID,
			DeviceID: consumed.DeviceID,
			Region:   consumed.Region,
		}
		certificate, pem, err := service.CA.SignCSR(csr, device, service.now())
		if err != nil {
			return CertificateRecord{}, err
		}
		return CertificateRecord{
			TenantID:    consumed.TenantID,
			DeviceID:    consumed.DeviceID,
			Region:      consumed.Region,
			Serial:      certificate.SerialNumber.Text(16),
			Fingerprint: Fingerprint(certificate),
			NotBefore:   certificate.NotBefore,
			NotAfter:    certificate.NotAfter,
			PEM:         string(pem),
		}, nil
	})
}

// Handler is POST /v1/enroll. TLS 1.3 is required when the request used TLS;
// a client certificate is not.
type Handler struct {
	Service *Service
}

type enrollRequest struct {
	TenantID string `json:"tenant_id"`
	Code     string `json:"code"`
	CSR      string `json:"csr"`
}

type enrollResponse struct {
	DeviceID    string `json:"device_id"`
	Certificate string `json:"certificate"`
}

// ServeHTTP exchanges a one-time code and CSR PEM for a device certificate.
func (handler *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")

	if handler == nil || handler.Service == nil {
		writeEnrollError(writer, http.StatusServiceUnavailable, "enrollment is not configured")
		return
	}
	if request.TLS != nil && request.TLS.Version != 0 && request.TLS.Version != tls.VersionTLS13 {
		writeEnrollError(writer, http.StatusBadRequest, "enrollment requires TLS 1.3")
		return
	}

	var body enrollRequest
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxBodyBytes))
	if err := decoder.Decode(&body); err != nil {
		writeEnrollError(writer, http.StatusBadRequest, "invalid enrollment request")
		return
	}

	record, err := handler.Service.Enroll(request.Context(), body.TenantID, body.Code, body.CSR)
	if err != nil {
		writeEnrollError(writer, enrollStatus(err), enrollMessage(err))
		return
	}
	_ = json.NewEncoder(writer).Encode(enrollResponse{
		DeviceID:    record.DeviceID,
		Certificate: record.PEM,
	})
}

func enrollStatus(err error) int {
	switch {
	case errors.Is(err, ErrUsed):
		return http.StatusConflict
	case errors.Is(err, ErrWrongTenant), errors.Is(err, ErrNotFound), errors.Is(err, ErrInactiveTenant):
		return http.StatusForbidden
	case errors.Is(err, ErrExpired), errors.Is(err, ErrInvalidCSR):
		return http.StatusBadRequest
	case errors.Is(err, ErrMissingCA):
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

func enrollMessage(err error) string {
	switch {
	case errors.Is(err, ErrUsed):
		return ErrUsed.Error()
	case errors.Is(err, ErrWrongTenant), errors.Is(err, ErrNotFound):
		return ErrNotFound.Error()
	case errors.Is(err, ErrExpired):
		return ErrExpired.Error()
	case errors.Is(err, ErrInvalidCSR):
		return ErrInvalidCSR.Error()
	case errors.Is(err, ErrInactiveTenant):
		return ErrInactiveTenant.Error()
	case errors.Is(err, ErrMissingCA):
		return ErrMissingCA.Error()
	default:
		return "enrollment failed"
	}
}

func writeEnrollError(writer http.ResponseWriter, code int, message string) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(code)
	_ = json.NewEncoder(writer).Encode(map[string]string{"error": message})
}

// Unavailable is POST /v1/enroll when the process has no device CA.
func Unavailable(writer http.ResponseWriter, _ *http.Request) {
	writeEnrollError(writer, http.StatusServiceUnavailable, "enrollment is not configured")
}
