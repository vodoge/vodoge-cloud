// Package cards holds per-SIM policy: whether a card may use cellular data,
// which vertical's rules apply, and which APN to use.
//
// Keyed by ICCID rather than by modem. A policy belongs to the subscription,
// not to the hardware it is in today: moving a SIM to another stick should
// carry its policy with it, and on an eUICC the ICCID is what changes when a
// profile is switched — exactly when a different policy should take effect.
package cards

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Policy is one card's rules.
type Policy struct {
	ICCID           string  `json:"iccid"`
	CellularEnabled bool    `json:"cellular_enabled"`
	// What the operator says this plan is sold as doing. Strictly
	// subtractive on the edge: false withholds an operation the measured
	// (modem, carrier) pair allowed, true asserts nothing, nil is
	// undeclared. Pointers because those are three distinct states and a
	// bare bool would collapse the first two.
	SmsSend    *bool `json:"sms_send"`
	SmsReceive *bool `json:"sms_receive"`
	Data       *bool `json:"data"`
	Voice      *bool `json:"voice"`
	Vertical        string  `json:"vertical"`
	APN             *string `json:"apn"`
	Note            string  `json:"note,omitempty"`
	UpdatedAt       int64   `json:"updated_at"`
}

// ErrInvalid explains a rejected policy.
type ErrInvalid struct{ Reason string }

func (err ErrInvalid) Error() string { return err.Reason }

var iccidPattern = regexp.MustCompile(`^[0-9]{19,20}$`)

// Validate checks a policy before it is stored or pushed.
func Validate(policy *Policy) error {
	policy.ICCID = strings.TrimSpace(policy.ICCID)
	if !iccidPattern.MatchString(policy.ICCID) {
		// A policy for something that is not an ICCID would be pushed to every
		// device and match no card on any of them: a silent no-op rather than
		// an error, which is the worst outcome available.
		return ErrInvalid{"iccid must be 19 or 20 digits"}
	}
	if policy.Vertical == "" {
		policy.Vertical = "cn"
	}
	if policy.Vertical != "cn" && policy.Vertical != "intl" {
		return ErrInvalid{"vertical must be cn or intl"}
	}
	if policy.APN != nil {
		trimmed := strings.TrimSpace(*policy.APN)
		if trimmed == "" {
			// An empty APN means "no override", which is what absent means.
			// Storing "" would push an empty string to the modem instead.
			policy.APN = nil
		} else {
			if len(trimmed) > 128 {
				return ErrInvalid{"apn must be 128 characters or fewer"}
			}
			policy.APN = &trimmed
		}
	}
	return nil
}

// Store reads and writes a tenant's card policies.
type Store interface {
	List(ctx context.Context, tenantID string) ([]Policy, error)
	Get(ctx context.Context, tenantID, iccid string) (Policy, bool, error)
	Save(ctx context.Context, tenantID string, policy Policy) error
	Delete(ctx context.Context, tenantID, iccid string) error
	// Version is a fingerprint of the whole set, sent with a push so a device
	// can tell whether what it holds is current.
	Version(ctx context.Context, tenantID string) (string, error)
}

// SQL reads through the tenant's RLS context.
type SQL struct{ DB *sql.DB }

func (store SQL) List(ctx context.Context, tenantID string) ([]Policy, error) {
	out := []Policy{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT iccid, cellular_enabled, vertical, apn, coalesce(note, ''),
			       extract(epoch from updated_at) * 1000,
			       sms_send, sms_receive, data, voice
			  FROM app.card_policies
			 ORDER BY iccid`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var policy Policy
			var apn sql.NullString
			var updated float64
			if err := rows.Scan(&policy.ICCID, &policy.CellularEnabled, &policy.Vertical,
				&apn, &policy.Note, &updated,
				&policy.SmsSend, &policy.SmsReceive, &policy.Data, &policy.Voice); err != nil {
				return err
			}
			if apn.Valid {
				value := apn.String
				policy.APN = &value
			}
			policy.UpdatedAt = int64(updated)
			out = append(out, policy)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (store SQL) Get(ctx context.Context, tenantID, iccid string) (Policy, bool, error) {
	var policy Policy
	found := false
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		var apn sql.NullString
		var updated float64
		err := tx.QueryRowContext(ctx, `
			SELECT iccid, cellular_enabled, vertical, apn, coalesce(note, ''),
			       extract(epoch from updated_at) * 1000,
			       sms_send, sms_receive, data, voice
			  FROM app.card_policies WHERE iccid = $1`, iccid,
		).Scan(&policy.ICCID, &policy.CellularEnabled, &policy.Vertical,
			&apn, &policy.Note, &updated)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		if apn.Valid {
			value := apn.String
			policy.APN = &value
		}
		policy.UpdatedAt = int64(updated)
		found = true
		return nil
	})
	return policy, found, err
}

func (store SQL) Save(ctx context.Context, tenantID string, policy Policy) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.card_policies
			    (tenant_id, iccid, cellular_enabled, vertical, apn, note,
			     sms_send, sms_receive, data, voice)
			VALUES (app.current_tenant_id(), $1, $2, $3, $4, nullif($5, ''),
			        $6, $7, $8, $9)
			ON CONFLICT (tenant_id, iccid) DO UPDATE
			   SET cellular_enabled = EXCLUDED.cellular_enabled,
			       vertical = EXCLUDED.vertical,
			       apn = EXCLUDED.apn,
			       note = EXCLUDED.note,
			       -- Replaced rather than merged: the form sends every field
			       -- it holds, so clearing a declaration has to be able to
			       -- reach NULL. A COALESCE here would make "undeclare this"
			       -- unexpressible.
			       sms_send = EXCLUDED.sms_send,
			       sms_receive = EXCLUDED.sms_receive,
			       data = EXCLUDED.data,
			       voice = EXCLUDED.voice,
			       updated_at = now()`,
			policy.ICCID, policy.CellularEnabled, policy.Vertical, policy.APN, policy.Note,
			policy.SmsSend, policy.SmsReceive, policy.Data, policy.Voice)
		return err
	})
}

func (store SQL) Delete(ctx context.Context, tenantID, iccid string) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`DELETE FROM app.card_policies WHERE iccid = $1`, iccid)
		return err
	})
}

// Version fingerprints the set from its most recent change and its size.
//
// Not a counter: a counter needs a place to live and something to increment it
// atomically, and this answers the only question a device asks — "is what I
// hold the same set the cloud has" — from data already present. The count is
// there because a deletion moves nothing forward on its own.
func (store SQL) Version(ctx context.Context, tenantID string) (string, error) {
	var version string
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		var count int64
		var latest sql.NullFloat64
		if err := tx.QueryRowContext(ctx, `
			SELECT count(*), max(extract(epoch from updated_at))
			  FROM app.card_policies`).Scan(&count, &latest); err != nil {
			return err
		}
		version = fmt.Sprintf("%d-%d", count, int64(latest.Float64))
		return nil
	})
	return version, err
}
