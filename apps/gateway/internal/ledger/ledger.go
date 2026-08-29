// Package ledger holds what has actually been measured: which module family,
// on whose network, doing what.
//
// The rule this exists to serve is that a pairing nobody has tested is not
// supported, and the edge refuses it by name. So a row here is a claim that
// somebody watched hardware do the thing, and the evidence columns are part of
// the record rather than a comment on it.
//
// The document pushed to devices is *rendered* from these rows, in Document
// below. That direction matters: the rows are the source, and the artefact on
// the wire is derived, so re-testing one pairing does not mean rewriting a
// blob and hoping the rest survived.
package ledger

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Entry is one measured pairing.
type Entry struct {
	ModemFamily string  `json:"modem_family"`
	Carrier     string  `json:"carrier"`
	SmsMo       *string `json:"sms_mo"`
	SmsMt       *string `json:"sms_mt"`
	Data        *string `json:"data"`
	Voice       *string `json:"voice"`
	Bearer      string  `json:"bearer"`
	Reason      *string `json:"reason"`
	Note        string  `json:"note"`
	TestedAt    int64   `json:"tested_at"`
	TestedBy    string  `json:"tested_by"`
}

// ErrInvalid explains a rejected entry.
type ErrInvalid struct{ Reason string }

func (err ErrInvalid) Error() string { return err.Reason }

var namePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

var supportValues = map[string]bool{"supported": true, "unsupported": true, "probe": true}

// Validate checks an entry before it is stored.
//
// The names are constrained to what a matrix key may hold, because they are
// carried into the document as keys: a family with a quote or a newline in it
// would travel to every device and match no module on any of them.
func Validate(entry *Entry) error {
	entry.ModemFamily = strings.TrimSpace(entry.ModemFamily)
	entry.Carrier = strings.TrimSpace(entry.Carrier)
	entry.TestedBy = strings.TrimSpace(entry.TestedBy)
	entry.Note = strings.TrimSpace(entry.Note)

	if !namePattern.MatchString(entry.ModemFamily) {
		return ErrInvalid{"modem_family must be 1-64 characters of letters, digits, dot, dash or underscore"}
	}
	if !namePattern.MatchString(entry.Carrier) {
		return ErrInvalid{"carrier must be 1-64 characters of letters, digits, dot, dash or underscore"}
	}
	if entry.TestedBy == "" {
		return ErrInvalid{"tested_by is required: a row here is a claim somebody made"}
	}
	if entry.Bearer == "" {
		entry.Bearer = "cellular"
	}
	if entry.Bearer != "cellular" && entry.Bearer != "ims" {
		return ErrInvalid{"bearer must be cellular or ims"}
	}
	measured := 0
	for name, value := range map[string]*string{
		"sms_mo": entry.SmsMo, "sms_mt": entry.SmsMt,
		"data": entry.Data, "voice": entry.Voice,
	} {
		if value == nil {
			continue
		}
		if !supportValues[*value] {
			return ErrInvalid{fmt.Sprintf("%s must be supported, unsupported or probe", name)}
		}
		measured++
	}
	if measured == 0 {
		return ErrInvalid{"a row that measured nothing is not a measurement"}
	}
	return nil
}

// Store reads and writes a tenant's ledger.
type Store interface {
	List(ctx context.Context, tenantID string) ([]Entry, error)
	Save(ctx context.Context, tenantID string, entry Entry) error
	Delete(ctx context.Context, tenantID, family, carrier string) error
}

// Empty is the store when PostgreSQL is not configured.
//
// Reads report an empty ledger rather than failing, which is the honest answer:
// with no database nothing has been measured. Writes refuse, because a
// measurement that is not durable is not a record of anything.
type Empty struct{}

func (Empty) List(context.Context, string) ([]Entry, error) { return []Entry{}, nil }

func (Empty) Save(context.Context, string, Entry) error {
	return errors.New("support ledger store is not configured")
}

func (Empty) Delete(context.Context, string, string, string) error {
	return errors.New("support ledger store is not configured")
}

// SQL reads through the tenant's RLS context.
type SQL struct{ DB *sql.DB }

func (store SQL) List(ctx context.Context, tenantID string) ([]Entry, error) {
	out := []Entry{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT modem_family, carrier, sms_mo, sms_mt, data, voice, bearer,
			       reason, coalesce(note, ''),
			       extract(epoch from tested_at) * 1000, tested_by
			  FROM app.support_ledger
			 ORDER BY modem_family, carrier`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var entry Entry
			var tested float64
			if err := rows.Scan(&entry.ModemFamily, &entry.Carrier,
				&entry.SmsMo, &entry.SmsMt, &entry.Data, &entry.Voice, &entry.Bearer,
				&entry.Reason, &entry.Note, &tested, &entry.TestedBy); err != nil {
				return err
			}
			entry.TestedAt = int64(tested)
			out = append(out, entry)
		}
		return rows.Err()
	})
	return out, err
}

func (store SQL) Save(ctx context.Context, tenantID string, entry Entry) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.support_ledger
			    (tenant_id, modem_family, carrier, sms_mo, sms_mt, data, voice,
			     bearer, reason, note, tested_by, tested_at, updated_at)
			VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8,
			        nullif($9, ''), $10, now(), now())
			ON CONFLICT (tenant_id, modem_family, carrier) DO UPDATE
			   SET sms_mo = EXCLUDED.sms_mo,
			       sms_mt = EXCLUDED.sms_mt,
			       data = EXCLUDED.data,
			       voice = EXCLUDED.voice,
			       bearer = EXCLUDED.bearer,
			       reason = EXCLUDED.reason,
			       note = EXCLUDED.note,
			       -- A re-test supersedes: the new reading and who took it
			       -- replace the old, rather than accumulating a history this
			       -- table has nowhere to put.
			       tested_by = EXCLUDED.tested_by,
			       tested_at = now(),
			       updated_at = now()`,
			entry.ModemFamily, entry.Carrier, entry.SmsMo, entry.SmsMt, entry.Data,
			entry.Voice, entry.Bearer, entry.Reason, entry.Note, entry.TestedBy)
		return err
	})
}

func (store SQL) Delete(ctx context.Context, tenantID, family, carrier string) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`DELETE FROM app.support_ledger WHERE modem_family = $1 AND carrier = $2`,
			family, carrier)
		return err
	})
}

// Document renders the ledger as the capability-matrix document the edge
// parses.
//
// Deliberately emits no `[fallback]`: the edge's own default answers a pairing
// with no rule, and it answers "untested". A fallback here would be this
// console quietly deciding what happens to hardware nobody has measured, which
// is the decision the ledger exists to stop being made by accident.
func Document(version string, entries []Entry) map[string]any {
	sorted := append([]Entry(nil), entries...)
	sort.Slice(sorted, func(left, right int) bool {
		if sorted[left].ModemFamily != sorted[right].ModemFamily {
			return sorted[left].ModemFamily < sorted[right].ModemFamily
		}
		return sorted[left].Carrier < sorted[right].Carrier
	})

	rules := make([]map[string]any, 0, len(sorted))
	for _, entry := range sorted {
		rule := map[string]any{
			"modem_family": entry.ModemFamily,
			"carrier":      entry.Carrier,
		}
		for name, value := range map[string]*string{
			"sms_mo": entry.SmsMo, "sms_mt": entry.SmsMt,
			"data": entry.Data, "voice": entry.Voice,
		} {
			if value == nil {
				continue
			}
			rule[name] = supportShape(*value, entry.Bearer, entry.Reason)
		}
		rules = append(rules, rule)
	}
	return map[string]any{"version": version, "rule": rules}
}

// supportShape renders one operation the way the edge's matrix parser reads it.
func supportShape(value, bearer string, reason *string) map[string]any {
	switch value {
	case "supported":
		return map[string]any{"kind": "supported", "bearer": bearer}
	case "unsupported":
		shape := map[string]any{"kind": "unsupported"}
		if reason != nil && *reason != "" {
			shape["reason"] = *reason
		}
		return shape
	default:
		return map[string]any{"kind": "probe"}
	}
}
