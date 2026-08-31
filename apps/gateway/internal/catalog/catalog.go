// Package catalog lists tenant-scoped devices, messages, and SMS sessions.
package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Device is one edge box as shown on the tenant dashboard.
type Device struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	State    string `json:"state"`
	LastSeen *int64 `json:"last_seen"`
	// What the device says about itself on every reconnect.
	EdgeVersion   *string `json:"edge_version,omitempty"`
	MatrixVersion *string `json:"matrix_version,omitempty"`
	QueueRecords  *int64  `json:"queue_records,omitempty"`
	QueueBytes    *int64  `json:"queue_bytes,omitempty"`
	ResumedAt     *int64  `json:"resumed_at,omitempty"`
	// The edge host itself. PublicIP is the one fact about the egress path
	// the box cannot work out locally -- every interface it owns has a
	// private address -- so the agent asks an outside service and reports the
	// answer. HostReportedAt is when the block was last carried, which is not
	// LastSeen: an agent too old to report vitals still checks in every poll,
	// and without it a reading frozen at the moment of an upgrade looks
	// current.
	PublicIP         *string  `json:"public_ip,omitempty"`
	CPUPercent       *float64 `json:"cpu_percent,omitempty"`
	MemoryUsedBytes  *int64   `json:"memory_used_bytes,omitempty"`
	MemoryTotalBytes *int64   `json:"memory_total_bytes,omitempty"`
	// The filesystem holding the agent's databases, not every mount: that is
	// the one whose exhaustion stops the outbox committing. Throughput is a
	// rate over the poll interval rather than a since-boot counter, and it
	// excludes the modules' own wwan interfaces, so it measures the box's
	// link to the world rather than its traffic to hardware inside itself.
	DiskUsedBytes    *int64  `json:"disk_used_bytes,omitempty"`
	DiskTotalBytes   *int64  `json:"disk_total_bytes,omitempty"`
	NetRxBytesPerSec *int64  `json:"net_rx_bytes_per_sec,omitempty"`
	NetTxBytesPerSec *int64  `json:"net_tx_bytes_per_sec,omitempty"`
	CPUModel         *string `json:"cpu_model,omitempty"`
	Kernel           *string `json:"kernel,omitempty"`
	Hostname         *string `json:"hostname,omitempty"`
	HostReportedAt   *int64  `json:"host_reported_at,omitempty"`
}

// Message is one SMS row in the tenant inbox.
type Message struct {
	ID         string `json:"id"`
	DeviceID   string `json:"device_id"`
	Direction  string `json:"direction"`
	Peer       string `json:"peer"`
	Body       string `json:"body"`
	Bearer     string `json:"bearer"`
	ReceivedAt int64  `json:"received_at"`
	Seq        int64  `json:"seq"`
}

// Session is one peer thread in the tenant inbox.
type Session struct {
	Peer           string `json:"peer"`
	Count          int    `json:"count"`
	LastBody       string `json:"last_body"`
	LastReceivedAt int64  `json:"last_received_at"`
	DeviceID       string `json:"device_id"`
}

// Store loads console data. SQL implementations must bind tenant_id with SET LOCAL.
type Store interface {
	ListDevices(ctx context.Context, tenantID string) ([]Device, error)
	ListMessages(ctx context.Context, tenantID string) ([]Message, error)
	ListSessions(ctx context.Context, tenantID string) ([]Session, error)
	ListModems(ctx context.Context, tenantID string) ([]Modem, error)
	ListCommands(ctx context.Context, tenantID, deviceID string, limit int) ([]CommandRow, error)
	// ListUptime returns recent hourly buckets for one device, newest first.
	// An hour with no row is an hour nothing was heard from, and it is absent
	// rather than zero -- see migration 0048.
	ListUptime(ctx context.Context, tenantID, deviceID string, hours int) ([]UptimeHour, error)
	// ListCandidates returns the endpoints an agent has seen and not written
	// to. What the console offers to approve; not devices.
	ListCandidates(ctx context.Context, tenantID string) ([]CandidateRow, error)
	// RaiseSilenceAlerts announces devices that have stopped reporting.
	//
	// 🔴 The one fault an agent cannot announce about itself. On 2026-08-31 a
	// USB re-enumeration wedged the edge process inside a kernel write for
	// fifty minutes: it held its socket, answered nothing, and raised nothing,
	// because the thread that would have raised an alert was the stuck one.
	// Silence has to be noticed from outside.
	RaiseSilenceAlerts(
		ctx context.Context, tenantID string, quiet time.Duration, now time.Time,
	) (int, error)

	// ListAlerts returns what the agents announced, newest first. Already
	// throttled at the edge: one row per code per window, so the count is the
	// number of times somebody should have been told rather than the number
	// of times the fault happened.
	ListAlerts(ctx context.Context, tenantID, deviceID string, limit int) ([]AlertRow, error)
	ListEvents(ctx context.Context, tenantID string, query EventQuery) ([]EventRow, error)
	ListEsimProfiles(ctx context.Context, tenantID, deviceID string) ([]EsimProfileRow, error)
	RenameDevice(ctx context.Context, tenantID, deviceID, name string) error
	// RecordResume stores what a device reported when it connected.
	RecordResume(ctx context.Context, tenantID, deviceID, edgeVersion, matrixVersion string,
		queueRecords, queueBytes int64) error
	// DeleteDevice removes a device and reports whether it existed.
	DeleteDevice(ctx context.Context, tenantID, deviceID string) (bool, error)
}

// Modem is one module as the edge last reported it.
//
// The SMS bearer fields come from the capability matrix rather than being
// inferred here: whether a card can send is a hardware and carrier fact the
// edge already resolved, and re-deciding it in the cloud is how the two ends
// start disagreeing.
type Modem struct {
	ID           string  `json:"id"`
	DeviceID     string  `json:"device_id"`
	IMEI         string  `json:"imei"`
	Family       string  `json:"family"`
	ICCID        *string `json:"iccid"`
	State        *string `json:"state"`
	Registration *string `json:"registration"`
	SignalDbm    *int64  `json:"signal_dbm"`
	// Quality figures from AT+QCSQ. SignalDbm comes from AT+CSQ, whose index
	// pegs at 31 next to a tower and reports -51 dBm for every module on the
	// bench; these vary, so they are what says whether a link is good.
	Rsrp *int64 `json:"rsrp"`
	Rsrq *int64 `json:"rsrq"`
	Sinr *int64 `json:"sinr"`
	// How the edge found this module, and whether it can act on it. A module
	// discovered over its AT port alone is present and out of reach: every
	// structured operation the agent performs goes over QMI. Both are nil for
	// a row last written by an agent that predates the second enumeration,
	// which is not the same as false.
	Discovery   *string `json:"discovery"`
	Manageable  *bool   `json:"manageable"`
	HomePlmn    *string `json:"home_plmn"`
	ServingPlmn *string `json:"serving_plmn"`
	SmsMo       *string `json:"sms_mo"`
	SmsMt       *string `json:"sms_mt"`
	// The carrier half of the capability-matrix key, and whether the matrix
	// had a rule for this (family, carrier) pair at all. The edge panel has
	// shown both since it existed; without them the console cannot tell a pair
	// characterised as "probe" from one nobody has ever considered, and those
	// are the two states a support-ledger entry is written between.
	CarrierProfile   *string `json:"carrier_profile"`
	CapabilityOrigin *string `json:"capability_origin"`
	LastSeen         *int64  `json:"last_seen"`
	// Identity the edge reads on every probe and used to discard. Firmware
	// answers "which build is on that stick" without a diagnostic round trip;
	// the number is often absent because plenty of operators never write one
	// to the card, so nil means the card did not say.
	Firmware *string `json:"firmware"`
	Msisdn   *string `json:"msisdn"`
	// Where the module physically is on the edge machine. The cloud cannot see
	// that host's /dev or sysfs, and it is the first thing asked for when a
	// module stops answering.
	ControlPort *string `json:"control_port"`
	UsbDevice   *string `json:"usb_device"`
	// The module's own packet data profile table, as reported. Raw JSON
	// because nothing here queries inside it and re-modelling it would give
	// the console a second shape to keep in step with the edge's.
	ApnContexts json.RawMessage `json:"apn_contexts"`
}

// CommandRow is one issued command and, once it lands, what came back.
type CommandRow struct {
	ID          string          `json:"id"`
	DeviceID    string          `json:"device_id"`
	Kind        string          `json:"kind"`
	Status      string          `json:"status"`
	IssuedAt    int64           `json:"issued_at"`
	CompletedAt *int64          `json:"completed_at"`
	Payload     json.RawMessage `json:"payload"`
	Result      json.RawMessage `json:"result"`
}

// CandidateRow is one endpoint an agent has seen and not written to.
//
// It is not a modem: it has no IMEI until somebody approves a probe, which is
// the whole reason this list exists separately from the fleet.
type CandidateRow struct {
	DeviceID     string  `json:"device_id"`
	CandidateKey string  `json:"candidate_key"`
	UsbDevice    *string `json:"usb_device"`
	Transport    string  `json:"transport"`
	ControlPort  string  `json:"control_port"`
	VendorID     *string `json:"vendor_id"`
	ProductID    *string `json:"product_id"`
	State        string  `json:"state"`
	IMEI         *string `json:"imei"`
	Detail       string  `json:"detail"`
	LastSeen     *int64  `json:"last_seen"`
}

// AlertRow is one fault an agent announced.
type AlertRow struct {
	ID         string          `json:"id"`
	DeviceID   string          `json:"device_id"`
	Level      string          `json:"level"`
	Code       string          `json:"code"`
	Message    string          `json:"message"`
	Context    json.RawMessage `json:"context"`
	OccurredAt int64           `json:"occurred_at"`
}

// UptimeHour is one device's presence in one closed hour.
//
// `MinutesOnline` is out of sixty and the denominator is not carried: an hour
// is an hour. What the row cannot say is whether the device was expected to be
// up, so a console drawing a ratio counts only hours that have rows.
type UptimeHour struct {
	Hour          int64 `json:"hour"`
	MinutesOnline int   `json:"minutes_online"`
}

// EsimProfileRow is one profile on one eUICC, as last reported.
type EsimProfileRow struct {
	EID         string  `json:"eid"`
	ICCID       string  `json:"iccid"`
	State       string  `json:"state"`
	Nickname    *string `json:"nickname,omitempty"`
	ModemIMEI   *string `json:"modem_imei,omitempty"`
	DeviceID    *string `json:"device_id,omitempty"`
	CollectedAt int64   `json:"collected_at"`
}

// EventRow is one envelope as it landed, for the history view.
type EventRow struct {
	Seq        int64           `json:"seq"`
	DeviceID   string          `json:"device_id"`
	Kind       string          `json:"kind"`
	ReceivedAt int64           `json:"received_at"`
	Payload    json.RawMessage `json:"payload,omitempty"`
}

// EventQuery narrows the history.
type EventQuery struct {
	DeviceID string
	Kind     string
	// Before is a cursor: return what arrived strictly before this instant.
	// A timestamp rather than an offset, because rows keep arriving while
	// someone pages and an offset would show them the same row twice.
	Before int64
	Limit  int
	// WithPayload is off by default. A page of envelopes with payloads is
	// megabytes, and the list view shows none of it.
	WithPayload bool
}

// Empty is used when PostgreSQL is not configured.
type Empty struct{}

// ListDevices returns no devices.
func (Empty) ListDevices(context.Context, string) ([]Device, error) {
	return []Device{}, nil
}

// ListMessages returns no messages.
func (Empty) ListMessages(context.Context, string) ([]Message, error) {
	return []Message{}, nil
}

// ListSessions returns no sessions.
func (Empty) ListCommands(context.Context, string, string, int) ([]CommandRow, error) {
	return []CommandRow{}, nil
}

func (Empty) ListUptime(context.Context, string, string, int) ([]UptimeHour, error) {
	return []UptimeHour{}, nil
}

func (Empty) ListCandidates(context.Context, string) ([]CandidateRow, error) {
	return []CandidateRow{}, nil
}

func (Empty) ListAlerts(context.Context, string, string, int) ([]AlertRow, error) {
	return []AlertRow{}, nil
}

func (Empty) RaiseSilenceAlerts(
	context.Context, string, time.Duration, time.Time,
) (int, error) {
	return 0, nil
}

func (Empty) ListEvents(context.Context, string, EventQuery) ([]EventRow, error) {
	return []EventRow{}, nil
}

func (Empty) ListEsimProfiles(context.Context, string, string) ([]EsimProfileRow, error) {
	return []EsimProfileRow{}, nil
}

func (Empty) RenameDevice(context.Context, string, string, string) error { return nil }

func (Empty) RecordResume(
	context.Context, string, string, string, string, int64, int64,
) error {
	return nil
}

func (Empty) DeleteDevice(context.Context, string, string) (bool, error) { return false, nil }

func (Empty) ListModems(context.Context, string) ([]Modem, error) {
	return []Modem{}, nil
}

func (Empty) ListSessions(context.Context, string) ([]Session, error) {
	return []Session{}, nil
}

// Memory is an in-process catalog used by tests.
type Memory struct {
	mu       sync.Mutex
	Devices  map[string][]Device
	Messages map[string][]Message
	Modems   map[string][]Modem
	Commands map[string][]CommandRow
	Events   map[string][]EventRow
	Esim     map[string][]EsimProfileRow
	// Keyed by device rather than tenant: the question this answers is always
	// about one device, and a tenant-keyed map would have every test that
	// touches uptime also state which tenant the device is in.
	Uptime map[string][]UptimeHour
	// A flat list rather than a map: candidates are read for the whole tenant
	// and filtered per device by the caller, which is the shape the console
	// needs -- "what is plugged in anywhere" is the fleet question.
	Candidates []CandidateRow
	Alerts     []AlertRow
}

// ListEsimProfiles returns the tenant's eUICC contents.
func (store *Memory) ListEsimProfiles(
	_ context.Context,
	tenantID, deviceID string,
) ([]EsimProfileRow, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []EsimProfileRow{}
	for _, row := range store.Esim[tenantID] {
		if deviceID != "" && (row.DeviceID == nil || *row.DeviceID != deviceID) {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

// RecordResume stores what a device reported when it connected.
func (store *Memory) RecordResume(
	_ context.Context,
	tenantID, deviceID, edgeVersion, matrixVersion string,
	queueRecords, queueBytes int64,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	for i, device := range store.Devices[tenantID] {
		if device.ID != deviceID {
			continue
		}
		if edgeVersion != "" {
			store.Devices[tenantID][i].EdgeVersion = &edgeVersion
		}
		if matrixVersion != "" {
			store.Devices[tenantID][i].MatrixVersion = &matrixVersion
		}
		records, bytes := queueRecords, queueBytes
		store.Devices[tenantID][i].QueueRecords = &records
		store.Devices[tenantID][i].QueueBytes = &bytes
	}
	return nil
}

// RenameDevice changes a device's label.
func (store *Memory) RenameDevice(_ context.Context, tenantID, deviceID, name string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	for i, device := range store.Devices[tenantID] {
		if device.ID == deviceID {
			store.Devices[tenantID][i].Name = name
			return nil
		}
	}
	return nil
}

// DeleteDevice removes a device and everything referring to it.
func (store *Memory) DeleteDevice(_ context.Context, tenantID, deviceID string) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	existed := false
	kept := store.Devices[tenantID][:0]
	for _, device := range store.Devices[tenantID] {
		if device.ID == deviceID {
			existed = true
			continue
		}
		kept = append(kept, device)
	}
	store.Devices[tenantID] = kept
	if !existed {
		return false, nil
	}
	keptModems := store.Modems[tenantID][:0]
	for _, modem := range store.Modems[tenantID] {
		if modem.DeviceID != deviceID {
			keptModems = append(keptModems, modem)
		}
	}
	store.Modems[tenantID] = keptModems
	return true, nil
}

// ListEvents returns the tenant's journal entries, newest first.
func (store *Memory) ListEvents(
	_ context.Context,
	tenantID string,
	query EventQuery,
) ([]EventRow, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []EventRow{}
	for _, row := range store.Events[tenantID] {
		if query.DeviceID != "" && row.DeviceID != query.DeviceID {
			continue
		}
		if query.Kind != "" && row.Kind != query.Kind {
			continue
		}
		if query.Before > 0 && row.ReceivedAt >= query.Before {
			continue
		}
		if !query.WithPayload {
			row.Payload = nil
		}
		out = append(out, row)
		if query.Limit > 0 && len(out) == query.Limit {
			break
		}
	}
	return out, nil
}

// ListCommands returns the tenant's commands, filtered to one device when
// deviceID is given.
func (store *Memory) RaiseSilenceAlerts(
	_ context.Context,
	_ string,
	_ time.Duration,
	_ time.Time,
) (int, error) {
	return 0, nil
}

func (store *Memory) ListAlerts(
	_ context.Context,
	_, deviceID string,
	limit int,
) ([]AlertRow, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []AlertRow{}
	for _, row := range store.Alerts {
		if deviceID != "" && row.DeviceID != deviceID {
			continue
		}
		out = append(out, row)
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (store *Memory) ListCandidates(_ context.Context, _ string) ([]CandidateRow, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return append([]CandidateRow{}, store.Candidates...), nil
}

func (store *Memory) ListUptime(
	_ context.Context,
	_, deviceID string,
	hours int,
) ([]UptimeHour, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	rows := store.Uptime[deviceID]
	if hours > 0 && len(rows) > hours {
		rows = rows[:hours]
	}
	return append([]UptimeHour{}, rows...), nil
}

func (store *Memory) ListCommands(
	_ context.Context,
	tenantID, deviceID string,
	limit int,
) ([]CommandRow, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := []CommandRow{}
	for _, row := range store.Commands[tenantID] {
		if deviceID != "" && row.DeviceID != deviceID {
			continue
		}
		out = append(out, row)
		if limit > 0 && len(out) == limit {
			break
		}
	}
	return out, nil
}

// ListModems returns modems for tenantID, never another tenant's rows.
func (store *Memory) ListModems(_ context.Context, tenantID string) ([]Modem, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := store.Modems[tenantID]
	if out == nil {
		return []Modem{}, nil
	}
	copied := make([]Modem, len(out))
	copy(copied, out)
	return copied, nil
}

// ListDevices returns devices for tenantID, never another tenant's rows.
func (store *Memory) ListDevices(_ context.Context, tenantID string) ([]Device, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return cloneDevices(store.Devices[tenantID]), nil
}

// ListMessages returns messages for tenantID, never another tenant's rows.
func (store *Memory) ListMessages(_ context.Context, tenantID string) ([]Message, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return cloneMessages(store.Messages[tenantID]), nil
}

// ListSessions aggregates tenantID messages by peer.
func (store *Memory) ListSessions(ctx context.Context, tenantID string) ([]Session, error) {
	messages, err := store.ListMessages(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	return SessionsFrom(messages), nil
}

// SQL reads app.devices and app.messages through tenant.Transact.
type SQL struct {
	DB *sql.DB
}

// ListModems returns the tenant's modules, most recently seen first.
// RecordResume stores what a device reported when it connected.
func (store SQL) RecordResume(
	ctx context.Context,
	tenantID, deviceID, edgeVersion, matrixVersion string,
	queueRecords, queueBytes int64,
) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`SELECT app.record_device_resume($1::uuid, $2::uuid, $3, $4, $5, $6)`,
			tenantID, deviceID, edgeVersion, matrixVersion, queueRecords, queueBytes)
		return err
	})
}

// RenameDevice changes the label a device is known by.
//
// Only the name. Everything else about a device — its IMEI, its region, what
// it is running — is reported by the device, and a console that could edit
// those would be inviting someone to write down what they wish were true.
func (store SQL) RenameDevice(ctx context.Context, tenantID, deviceID, name string) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE app.devices SET name = $2, updated_at = now()
			 WHERE id = $1::uuid`, deviceID, name)
		return err
	})
}

// DeleteDevice removes a device and everything that hangs off it.
//
// The work is in app.delete_device rather than here. Doing it from Go would
// mean granting this role DELETE on app.ingress, app.commands and
// app.device_certificates — the power to erase any device's whole history,
// held permanently, to support one operation. The function is SECURITY
// DEFINER but not an escape from isolation: its owner is subject to FORCE row
// level security too, so it still sees only the calling tenant's rows.
func (store SQL) DeleteDevice(ctx context.Context, tenantID, deviceID string) (bool, error) {
	var existed bool
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx,
			`SELECT app.delete_device($1::uuid)`, deviceID).Scan(&existed)
	})
	return existed, err
}

// ListEsimProfiles returns what each eUICC last reported it holds.
//
// Deleted profiles are included. Which ICCID used to be on a chip is exactly
// what someone needs when a card stops working after a switch, and hiding them
// would make the inventory agree with the chip while disagreeing with history.
func (store SQL) ListEsimProfiles(
	ctx context.Context,
	tenantID, deviceID string,
) ([]EsimProfileRow, error) {
	out := []EsimProfileRow{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT eid, iccid, state, nickname, modem_imei, device_id::text, collected_at
			  FROM app.esim_profiles
			 WHERE ($1 = '' OR device_id = $1::uuid)
			 ORDER BY eid, state, iccid`, deviceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row EsimProfileRow
			var nickname, imei, device sql.NullString
			var collected time.Time
			if err := rows.Scan(&row.EID, &row.ICCID, &row.State,
				&nickname, &imei, &device, &collected); err != nil {
				return err
			}
			row.Nickname = nullableString(nickname)
			row.ModemIMEI = nullableString(imei)
			row.DeviceID = nullableString(device)
			row.CollectedAt = collected.UnixMilli()
			out = append(out, row)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ListEvents reads the uplink journal, newest first.
//
// This is the only view of what a device actually said, as opposed to what the
// projections made of it. When a modem's state looks wrong on a page, the
// question is always whether the device reported it that way or the projection
// mangled it, and nothing could answer that before.
func (store SQL) ListEvents(
	ctx context.Context,
	tenantID string,
	query EventQuery,
) ([]EventRow, error) {
	if query.Limit <= 0 || query.Limit > 500 {
		query.Limit = 100
	}
	var rows []EventRow
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		// The payload column is selected conditionally rather than always and
		// discarded: a hundred DeviceState payloads is a megabyte of JSON the
		// list view never shows.
		payloadExpr := "NULL::jsonb"
		if query.WithPayload {
			payloadExpr = "payload"
		}
		before := time.Now().Add(time.Minute)
		if query.Before > 0 {
			before = time.UnixMilli(query.Before)
		}
		queried, err := tx.QueryContext(ctx, `
			SELECT seq, device_id::text, kind, received_at, `+payloadExpr+`
			  FROM app.ingress
			 WHERE received_at < $1
			   AND ($2 = '' OR device_id = $2::uuid)
			   AND ($3 = '' OR kind = $3)
			 ORDER BY received_at DESC, seq DESC
			 LIMIT $4`, before, query.DeviceID, query.Kind, query.Limit)
		if err != nil {
			return err
		}
		defer queried.Close()
		for queried.Next() {
			var item EventRow
			var at time.Time
			var payload []byte
			if err := queried.Scan(
				&item.Seq, &item.DeviceID, &item.Kind, &at, &payload,
			); err != nil {
				return err
			}
			item.ReceivedAt = at.UnixMilli()
			if len(payload) > 0 {
				item.Payload = json.RawMessage(payload)
			}
			rows = append(rows, item)
		}
		return queried.Err()
	})
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []EventRow{}
	}
	return rows, nil
}

// ListCommands returns a device's recent commands, newest first, with whatever
// result has landed. A relayed diagnostic is asynchronous — the console issues
// it and reads the answer here — so the result column is the point of this
// query, not an afterthought.
func (store SQL) ListCommands(
	ctx context.Context,
	tenantID, deviceID string,
	limit int,
) ([]CommandRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var rows []CommandRow
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		queried, err := tx.QueryContext(ctx, `
			SELECT id::text,
			       device_id::text,
			       kind::text,
			       status::text,
			       issued_at,
			       completed_at,
			       -- The one read of a command payload that a person sees, so
			       -- it is the one that must not carry a credential. Stripped
			       -- in SQL rather than in Go because this row is serialised
			       -- straight to the console as json.RawMessage: whatever is
			       -- left in it is on the wire. configure_apn is the only
			       -- command carrying a password, and dropping the key
			       -- everywhere costs nothing where there is none.
			       payload - 'password',
			       result
			  FROM app.commands
			 WHERE ($1 = '' OR device_id = $1::uuid)
			 ORDER BY issued_at DESC
			 LIMIT $2`, deviceID, limit)
		if err != nil {
			return err
		}
		defer queried.Close()
		for queried.Next() {
			var item CommandRow
			var issued time.Time
			var completed sql.NullTime
			var payload, result []byte
			if err := queried.Scan(
				&item.ID, &item.DeviceID, &item.Kind, &item.Status,
				&issued, &completed, &payload, &result,
			); err != nil {
				return err
			}
			item.IssuedAt = issued.UnixMilli()
			if completed.Valid {
				ms := completed.Time.UnixMilli()
				item.CompletedAt = &ms
			}
			item.Payload = json.RawMessage(payload)
			if len(result) > 0 {
				item.Result = json.RawMessage(result)
			}
			rows = append(rows, item)
		}
		return queried.Err()
	})
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []CommandRow{}
	}
	return rows, nil
}

func (store SQL) ListModems(ctx context.Context, tenantID string) ([]Modem, error) {
	var modems []Modem
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text,
			       device_id::text,
			       imei,
			       family,
			       iccid,
			       state,
			       registration,
			       signal_dbm,
			       rsrp,
			       rsrq,
			       sinr,
			       discovery,
			       manageable,
			       home_plmn,
			       serving_plmn,
			       capability ->> 'sms_mo',
			       capability ->> 'sms_mt',
			       capability ->> 'carrier_profile',
			       capability ->> 'origin',
			       last_seen_at,
			       firmware,
			       msisdn,
			       control_port,
			       usb_device,
			       apn_contexts
			  FROM app.modems
			 ORDER BY last_seen_at DESC NULLS LAST, imei`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Modem
			var iccid, state, registration, homePlmn, servingPlmn, smsMo, smsMt sql.NullString
			var carrierProfile, capabilityOrigin sql.NullString
			var discovery sql.NullString
			var firmware, msisdn, controlPort, usbDevice sql.NullString
			var apnContexts []byte
			var manageable sql.NullBool
			var rsrp, rsrq, sinr sql.NullInt64
			var signal sql.NullInt64
			var lastSeen sql.NullTime
			if err := rows.Scan(
				&item.ID, &item.DeviceID, &item.IMEI, &item.Family,
				&iccid, &state, &registration, &signal,
				&rsrp, &rsrq, &sinr, &discovery, &manageable,
				&homePlmn, &servingPlmn, &smsMo, &smsMt,
				&carrierProfile, &capabilityOrigin, &lastSeen,
				&firmware, &msisdn, &controlPort, &usbDevice, &apnContexts,
			); err != nil {
				return err
			}
			item.ICCID = nullableString(iccid)
			item.State = nullableString(state)
			item.Registration = nullableString(registration)
			item.Discovery = nullableString(discovery)
			item.Rsrp = nullableInt(rsrp)
			item.Rsrq = nullableInt(rsrq)
			item.Sinr = nullableInt(sinr)
			if manageable.Valid {
				value := manageable.Bool
				item.Manageable = &value
			}
			item.HomePlmn = nullableString(homePlmn)
			item.ServingPlmn = nullableString(servingPlmn)
			item.SmsMo = nullableString(smsMo)
			item.SmsMt = nullableString(smsMt)
			item.CarrierProfile = nullableString(carrierProfile)
			item.CapabilityOrigin = nullableString(capabilityOrigin)
			item.Firmware = nullableString(firmware)
			item.Msisdn = nullableString(msisdn)
			item.ControlPort = nullableString(controlPort)
			item.UsbDevice = nullableString(usbDevice)
			if len(apnContexts) > 0 {
				item.ApnContexts = json.RawMessage(apnContexts)
			}
			if signal.Valid {
				value := signal.Int64
				item.SignalDbm = &value
			}
			if lastSeen.Valid {
				ms := lastSeen.Time.UnixMilli()
				item.LastSeen = &ms
			}
			modems = append(modems, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	if modems == nil {
		modems = []Modem{}
	}
	return modems, nil
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

func nullableInt(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	out := value.Int64
	return &out
}

func nullableFloat(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	out := value.Float64
	return &out
}

// ListDevices returns the tenant's devices ordered by name.
func (store SQL) ListDevices(ctx context.Context, tenantID string) ([]Device, error) {
	var devices []Device
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text,
			       name,
			       CASE
			         WHEN last_seen_at IS NULL THEN 'unknown'
			         WHEN last_seen_at > now() - interval '2 minutes' THEN 'online'
			         ELSE 'offline'
			       END,
			       last_seen_at,
			       edge_version, matrix_version, queue_records, queue_bytes, resumed_at,
			       public_ip, cpu_percent, memory_used_bytes, memory_total_bytes,
			       disk_used_bytes, disk_total_bytes,
			       net_rx_bytes_per_sec, net_tx_bytes_per_sec,
			       cpu_model, kernel, hostname,
			       host_reported_at
			  FROM app.devices
			 ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Device
			var lastSeen, resumed sql.NullTime
			var edgeVersion, matrixVersion sql.NullString
			var queueRecords, queueBytes sql.NullInt64
			var publicIP sql.NullString
			var cpuPercent sql.NullFloat64
			var memoryUsed, memoryTotal sql.NullInt64
			var diskUsed, diskTotal, netRx, netTx sql.NullInt64
			var cpuModel, kernel, hostname sql.NullString
			var hostReported sql.NullTime
			if err := rows.Scan(&item.ID, &item.Name, &item.State, &lastSeen,
				&edgeVersion, &matrixVersion, &queueRecords, &queueBytes, &resumed,
				&publicIP, &cpuPercent, &memoryUsed, &memoryTotal,
				&diskUsed, &diskTotal, &netRx, &netTx,
				&cpuModel, &kernel, &hostname, &hostReported); err != nil {
				return err
			}
			if lastSeen.Valid {
				ms := lastSeen.Time.UnixMilli()
				item.LastSeen = &ms
			}
			item.EdgeVersion = nullableString(edgeVersion)
			item.MatrixVersion = nullableString(matrixVersion)
			item.PublicIP = nullableString(publicIP)
			item.CPUPercent = nullableFloat(cpuPercent)
			item.MemoryUsedBytes = nullableInt(memoryUsed)
			item.MemoryTotalBytes = nullableInt(memoryTotal)
			item.DiskUsedBytes = nullableInt(diskUsed)
			item.DiskTotalBytes = nullableInt(diskTotal)
			item.NetRxBytesPerSec = nullableInt(netRx)
			item.NetTxBytesPerSec = nullableInt(netTx)
			item.CPUModel = nullableString(cpuModel)
			item.Kernel = nullableString(kernel)
			item.Hostname = nullableString(hostname)
			if hostReported.Valid {
				ms := hostReported.Time.UnixMilli()
				item.HostReportedAt = &ms
			}
			if queueRecords.Valid {
				value := queueRecords.Int64
				item.QueueRecords = &value
			}
			if queueBytes.Valid {
				value := queueBytes.Int64
				item.QueueBytes = &value
			}
			if resumed.Valid {
				ms := resumed.Time.UnixMilli()
				item.ResumedAt = &ms
			}
			devices = append(devices, item)
		}
		return rows.Err()
	})
	if devices == nil {
		devices = []Device{}
	}
	return devices, err
}

// ListMessages returns the newest 200 SMS rows for the tenant.
func (store SQL) ListMessages(ctx context.Context, tenantID string) ([]Message, error) {
	var messages []Message
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text,
			       device_id::text,
			       direction,
			       peer,
			       body,
			       bearer,
			       (EXTRACT(EPOCH FROM received_at) * 1000)::bigint,
			       seq
			  FROM app.messages
			 ORDER BY received_at DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Message
			if err := rows.Scan(
				&item.ID, &item.DeviceID, &item.Direction, &item.Peer,
				&item.Body, &item.Bearer, &item.ReceivedAt, &item.Seq,
			); err != nil {
				return err
			}
			messages = append(messages, item)
		}
		return rows.Err()
	})
	if messages == nil {
		messages = []Message{}
	}
	return messages, err
}

// ListSessions returns the newest 200 peer threads for the tenant.
func (store SQL) ListSessions(ctx context.Context, tenantID string) ([]Session, error) {
	var sessions []Session
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT peer,
			       COUNT(*)::int,
			       (ARRAY_AGG(body ORDER BY received_at DESC))[1],
			       (EXTRACT(EPOCH FROM MAX(received_at)) * 1000)::bigint,
			       (ARRAY_AGG(device_id::text ORDER BY received_at DESC))[1]
			  FROM app.messages
			 GROUP BY peer
			 ORDER BY MAX(received_at) DESC
			 LIMIT 200`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Session
			if err := rows.Scan(
				&item.Peer, &item.Count, &item.LastBody, &item.LastReceivedAt, &item.DeviceID,
			); err != nil {
				return err
			}
			sessions = append(sessions, item)
		}
		return rows.Err()
	})
	if sessions == nil {
		sessions = []Session{}
	}
	return sessions, err
}

// SessionsFrom groups messages into peer threads, newest first.
func SessionsFrom(messages []Message) []Session {
	type acc struct {
		session Session
	}
	byPeer := make(map[string]*acc)
	for _, message := range messages {
		existing, ok := byPeer[message.Peer]
		if !ok {
			byPeer[message.Peer] = &acc{session: Session{
				Peer:           message.Peer,
				Count:          1,
				LastBody:       message.Body,
				LastReceivedAt: message.ReceivedAt,
				DeviceID:       message.DeviceID,
			}}
			continue
		}
		existing.session.Count++
		if message.ReceivedAt >= existing.session.LastReceivedAt {
			existing.session.LastBody = message.Body
			existing.session.LastReceivedAt = message.ReceivedAt
			existing.session.DeviceID = message.DeviceID
		}
	}
	sessions := make([]Session, 0, len(byPeer))
	for _, item := range byPeer {
		sessions = append(sessions, item.session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].LastReceivedAt == sessions[j].LastReceivedAt {
			return sessions[i].Peer < sessions[j].Peer
		}
		return sessions[i].LastReceivedAt > sessions[j].LastReceivedAt
	})
	if len(sessions) > 200 {
		sessions = sessions[:200]
	}
	return sessions
}

func cloneDevices(in []Device) []Device {
	if in == nil {
		return []Device{}
	}
	out := make([]Device, len(in))
	copy(out, in)
	return out
}

func cloneMessages(in []Message) []Message {
	if in == nil {
		return []Message{}
	}
	out := make([]Message, len(in))
	copy(out, in)
	return out
}

// UnixMilli is exported for tests that compare last_seen.
func UnixMilli(ts time.Time) int64 {
	return ts.UnixMilli()
}

// ListUptime reads recent hourly buckets for one device.
func (store SQL) ListUptime(
	ctx context.Context,
	tenantID, deviceID string,
	hours int,
) ([]UptimeHour, error) {
	if hours <= 0 || hours > 24*30 {
		hours = 24 * 7
	}
	rows := []UptimeHour{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		queried, err := tx.QueryContext(ctx, `
			SELECT extract(epoch from hour) * 1000, minutes_online
			  FROM app.device_uptime
			 WHERE device_id = $1::uuid
			 ORDER BY hour DESC
			 LIMIT $2`, deviceID, hours)
		if err != nil {
			return err
		}
		defer queried.Close()
		for queried.Next() {
			var item UptimeHour
			var stamp float64
			if err := queried.Scan(&stamp, &item.MinutesOnline); err != nil {
				return err
			}
			item.Hour = int64(stamp)
			rows = append(rows, item)
		}
		return queried.Err()
	})
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// ListCandidates reads every unclaimed endpoint the tenant's agents report.
func (store SQL) ListCandidates(ctx context.Context, tenantID string) ([]CandidateRow, error) {
	rows := []CandidateRow{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		queried, err := tx.QueryContext(ctx, `
			SELECT device_id::text, candidate_key, usb_device, transport,
			       control_port, vendor_id, product_id, state, imei, detail,
			       extract(epoch from last_seen) * 1000
			  FROM app.modem_candidates
			 ORDER BY device_id, candidate_key`)
		if err != nil {
			return err
		}
		defer queried.Close()
		for queried.Next() {
			var item CandidateRow
			var usbDevice, vendorID, productID, imei sql.NullString
			var lastSeen sql.NullFloat64
			if err := queried.Scan(
				&item.DeviceID, &item.CandidateKey, &usbDevice, &item.Transport,
				&item.ControlPort, &vendorID, &productID, &item.State, &imei,
				&item.Detail, &lastSeen,
			); err != nil {
				return err
			}
			item.UsbDevice = nullableString(usbDevice)
			item.VendorID = nullableString(vendorID)
			item.ProductID = nullableString(productID)
			item.IMEI = nullableString(imei)
			if lastSeen.Valid {
				stamp := int64(lastSeen.Float64)
				item.LastSeen = &stamp
			}
			rows = append(rows, item)
		}
		return queried.Err()
	})
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// ListAlerts reads recent alerts, for one device or for the whole tenant.
func (store SQL) ListAlerts(
	ctx context.Context,
	tenantID, deviceID string,
	limit int,
) ([]AlertRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows := []AlertRow{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		queried, err := tx.QueryContext(ctx, `
			SELECT id::text, device_id::text, level, code, message, context,
			       extract(epoch from occurred_at) * 1000
			  FROM app.alerts
			 WHERE ($1 = '' OR device_id = $1::uuid)
			 ORDER BY occurred_at DESC
			 LIMIT $2`, deviceID, limit)
		if err != nil {
			return err
		}
		defer queried.Close()
		for queried.Next() {
			var item AlertRow
			var context []byte
			var stamp float64
			if err := queried.Scan(
				&item.ID, &item.DeviceID, &item.Level, &item.Code,
				&item.Message, &context, &stamp,
			); err != nil {
				return err
			}
			item.Context = json.RawMessage(context)
			item.OccurredAt = int64(stamp)
			rows = append(rows, item)
		}
		return queried.Err()
	})
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// RaiseSilenceAlerts inserts one alert per device that has gone quiet.
//
// # Why one per episode, and how that is enforced without state
//
// The edge throttles its own alerts by remembering what it announced. Nothing
// here can do that: this runs every tick, and a device that stays quiet for a
// week must not produce a row per tick.
//
// The rule that gets it right with no bookkeeping is to compare against the
// device's own clock: announce only when no `agent_silent` alert exists that
// is *newer than the silence began*. `last_seen_at` moves the moment the
// device reports again, so the next silence is automatically a new episode and
// the previous alert no longer counts. One row per episode, decided by a
// predicate rather than by remembering anything.
//
// A device that has never reported (`last_seen_at IS NULL`) is skipped: it has
// not gone quiet, it has never spoken, and a fleet being provisioned would
// otherwise alert on every device before its first check-in.
func (store SQL) RaiseSilenceAlerts(
	ctx context.Context,
	tenantID string,
	quiet time.Duration,
	now time.Time,
) (int, error) {
	if quiet <= 0 {
		return 0, nil
	}
	raised := 0
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO app.alerts (
			    tenant_id, device_id, level, code, message, context, occurred_at
			)
			SELECT device.tenant_id,
			       device.id,
			       'error',
			       'agent_silent',
			       'no state report for ' ||
			           floor(extract(epoch from ($2::timestamptz - device.last_seen_at)) / 60)::text ||
			           ' minutes',
			       jsonb_build_object(
			           'last_seen_at',
			           floor(extract(epoch from device.last_seen_at) * 1000)::bigint,
			           'quiet_seconds',
			           floor(extract(epoch from $3::interval))::bigint
			       ),
			       $2::timestamptz
			  FROM app.devices device
			 WHERE device.last_seen_at IS NOT NULL
			   AND device.last_seen_at < $2::timestamptz - $3::interval
			   AND NOT EXISTS (
			       SELECT 1
			         FROM app.alerts existing
			        WHERE existing.device_id = device.id
			          AND existing.code = 'agent_silent'
			          AND existing.occurred_at > device.last_seen_at
			   )`,
			tenantID, now.UTC(), fmt.Sprintf("%d seconds", int64(quiet.Seconds())))
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		raised = int(affected)
		return nil
	})
	if err != nil {
		return 0, err
	}
	return raised, nil
}
