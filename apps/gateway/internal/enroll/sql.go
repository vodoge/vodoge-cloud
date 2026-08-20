package enroll

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// SQLIssuer consumes enrollment codes and stores certificate serials in PostgreSQL.
type SQLIssuer struct {
	DB      *sql.DB
	Timeout time.Duration
}

func (issuer *SQLIssuer) timeout() time.Duration {
	if issuer != nil && issuer.Timeout > 0 {
		return issuer.Timeout
	}
	return 5 * time.Second
}

// Issue runs consume + certificate insert in one tenant-scoped transaction.
func (issuer *SQLIssuer) Issue(ctx context.Context, tenantID, code, hint string, sign func(Consumed) (CertificateRecord, error)) (CertificateRecord, error) {
	if issuer == nil || issuer.DB == nil {
		return CertificateRecord{}, fmt.Errorf("enrollment database is not configured")
	}
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), issuer.timeout())
		defer cancel()
	}

	var issued CertificateRecord
	err := tenant.Transact(ctx, issuer.DB, tenantID, func(tx *sql.Tx) error {
		consumed, err := consumeCode(ctx, tx, tenantID, code, hint)
		if err != nil {
			return err
		}
		issued, err = sign(consumed)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO app.device_certificates (
				tenant_id, device_id, serial, fingerprint, not_before, not_after
			) VALUES ($1, $2, $3, $4, $5, $6)`,
			issued.TenantID,
			issued.DeviceID,
			issued.Serial,
			issued.Fingerprint,
			issued.NotBefore,
			issued.NotAfter,
		)
		return err
	})
	if err != nil {
		return CertificateRecord{}, mapConsumeError(err)
	}
	return issued, nil
}

func consumeCode(ctx context.Context, tx *sql.Tx, tenantID, code, hint string) (Consumed, error) {
	var consumed Consumed
	err := tx.QueryRowContext(ctx, `
		SELECT device_id::text, tenant_id::text, region
		  FROM app.consume_enrollment_code($1, $2, $3)`,
		tenantID, code, hint,
	).Scan(&consumed.DeviceID, &consumed.TenantID, &consumed.Region)
	if err != nil {
		return Consumed{}, err
	}
	return consumed, nil
}

func mapConsumeError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	switch {
	case strings.Contains(message, "already used"):
		return fmt.Errorf("%w: %v", ErrUsed, err)
	case strings.Contains(message, "expired"):
		return fmt.Errorf("%w: %v", ErrExpired, err)
	case strings.Contains(message, "does not belong"), strings.Contains(message, "does not match enrollment tenant"):
		return fmt.Errorf("%w: %v", ErrWrongTenant, err)
	case strings.Contains(message, "not found"):
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	case strings.Contains(message, "not active"):
		return fmt.Errorf("%w: %v", ErrInactiveTenant, err)
	default:
		return err
	}
}
