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

// SupportedDevice is one row of the cross-tenant supported-hardware list.
//
// ⚠️ **不是** `catalog.Device`。那个是机队里的一台边缘机；这个是一款受支持
// 的硬件型号。同一个词在这个代码库里指两样东西，所以这里带上限定词 ——
// 名字和 edge-core 的 `SupportedDevice` 对齐，两端读的是同一个概念。
//
// 「支持」是两件事的合取：这个 build 有策略驱动它（代码说了算），**且**
// 目录里启用（这张表说了算）。这个类型只承载后半句。
type SupportedDevice struct {
	UsbVendor  string
	UsbProduct string
	Strategy   string
	Enabled    bool
	Note       *string
}

// Devices reads the cross-tenant supported-device list.
//
// 没有 tenant 参数，因为这张表没有 tenant_id：它是跨租户事实。
type Devices interface {
	ListSupportedDevices(ctx context.Context) ([]SupportedDevice, error)
}

// NoDevices is the stand-in for "this deployment has no catalogue yet".
//
// 🔴 它返回空切片，而 `Document` 在空的时候**整个不写** `device` 键 ——
// 那正是「还没人建这张表」应有的行为。见 Document 上的注释。
type NoDevices struct{}

func (NoDevices) ListSupportedDevices(context.Context) ([]SupportedDevice, error) {
	return nil, nil
}

// SQLDevices reads app.supported_devices.
type SQLDevices struct{ DB *sql.DB }

func (store SQLDevices) ListSupportedDevices(ctx context.Context) ([]SupportedDevice, error) {
	if store.DB == nil {
		return nil, nil
	}
	rows, err := store.DB.QueryContext(ctx, `
		SELECT usb_vendor, usb_product, strategy, enabled, note
		  FROM app.supported_devices
		 ORDER BY usb_vendor, usb_product`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SupportedDevice
	for rows.Next() {
		var device SupportedDevice
		var note sql.NullString
		if err := rows.Scan(&device.UsbVendor, &device.UsbProduct,
			&device.Strategy, &device.Enabled, &note); err != nil {
			return nil, err
		}
		if note.Valid {
			value := note.String
			device.Note = &value
		}
		out = append(out, device)
	}
	return out, rows.Err()
}

// Document renders the ledger as the capability-matrix document the edge
// parses.
//
// Deliberately emits no `[fallback]`: the edge's own default answers a pairing
// with no rule, and it answers "untested". A fallback here would be this
// console quietly deciding what happens to hardware nobody has measured, which
// is the decision the ledger exists to stop being made by accident.
// Document renders the ledger (and the supported-device list) into the matrix
// document the edge parses.
//
// 🔴 `devices` 为空时**整个不写** `device` 键，而不是写一个空数组。
//
// 边缘端的 `DeviceGate` 分得很清：没有这个段是 `NotStated`（放行，
// 向后兼容），有段而某个硬件不在里面是 `Absent`（拒）。所以一个空的
// `[[device]]` 列表会拒掉**每一块**硬件 —— 和 `PUT /v1/capability-matrix`
// 收下 `{"version":"x"}` 是同一个形状的灾难，而那个已经在 `matrix.Parse`
// 里堵上了。这里是同一条规则在渲染这一侧。
func Document(version string, entries []Entry, devices []SupportedDevice) map[string]any {
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
	document := map[string]any{"version": version, "rule": rules}
	if len(devices) > 0 {
		shaped := make([]map[string]any, 0, len(devices))
		for _, device := range devices {
			entry := map[string]any{
				"usb":      device.UsbVendor + ":" + device.UsbProduct,
				"strategy": device.Strategy,
				"enabled":  device.Enabled,
			}
			if device.Note != nil && *device.Note != "" {
				entry["note"] = *device.Note
			}
			shaped = append(shaped, entry)
		}
		document["device"] = shaped
	}
	return document
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
