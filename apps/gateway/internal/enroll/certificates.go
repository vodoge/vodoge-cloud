package enroll

import (
	"context"
	"database/sql"
	"errors"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Certificate is one issued device certificate, as the console shows it.
//
// ⚠️ 不带证书本身（PEM）。控制台要回答的是「这台机器用的是哪一张、还有效
// 多久、被吊销了没有」——把整张证书送到浏览器只是多一处泄露面，而它对这
// 三个问题一点帮助都没有。
type Certificate struct {
	ID          string `json:"id"`
	DeviceID    string `json:"device_id"`
	Serial      string `json:"serial"`
	Fingerprint string `json:"fingerprint"`
	NotBefore   int64  `json:"not_before"`
	NotAfter    int64  `json:"not_after"`
	RevokedAt   *int64 `json:"revoked_at"`
}

// ErrCertificateNotFound means no such certificate in this tenant.
var ErrCertificateNotFound = errors.New("certificate not found")

// SQLCertificates lists and revokes a tenant's device certificates.
type SQLCertificates struct {
	DB *sql.DB
}

// List returns this tenant's certificates, newest first.
func (store SQLCertificates) List(ctx context.Context, tenantID string) ([]Certificate, error) {
	var out []Certificate
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text, device_id::text, serial, fingerprint,
			       (extract(epoch from not_before) * 1000)::bigint,
			       (extract(epoch from not_after) * 1000)::bigint,
			       CASE WHEN revoked_at IS NULL THEN NULL
			            ELSE (extract(epoch from revoked_at) * 1000)::bigint END
			  FROM app.device_certificates
			 ORDER BY not_before DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Certificate
			if err := rows.Scan(&item.ID, &item.DeviceID, &item.Serial, &item.Fingerprint,
				&item.NotBefore, &item.NotAfter, &item.RevokedAt); err != nil {
				return err
			}
			out = append(out, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Revoke marks one certificate revoked and reports whether it changed anything.
//
// 🔴 幂等：已经被吊销的再吊销一次，`revoked_at` **不动**。保留第一次吊销的
//
//	时刻 —— 那个时刻是「这台机器什么时候被判定为不再可信」的唯一记录，
//	被一次重复点击改写之后就再也答不上来了。这和 register_modem 保留首次
//	纳管时刻是同一条规矩（见 edge-store/tests/registered_modems.rs）。
func (store SQLCertificates) Revoke(ctx context.Context, tenantID, id string) (bool, error) {
	var changed bool
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		var found bool
		if err := tx.QueryRowContext(ctx, `
			SELECT EXISTS (SELECT 1 FROM app.device_certificates WHERE id = $1::uuid)`,
			id).Scan(&found); err != nil {
			return err
		}
		if !found {
			return ErrCertificateNotFound
		}
		result, err := tx.ExecContext(ctx, `
			UPDATE app.device_certificates
			   SET revoked_at = now()
			 WHERE id = $1::uuid
			   AND revoked_at IS NULL`, id)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		changed = affected > 0
		return nil
	})
	return changed, err
}
